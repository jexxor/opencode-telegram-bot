import { config } from "../../config.js";
import { t } from "../../i18n/index.js";
import { opencodeClient } from "../../opencode/client.js";
import { logger } from "../../utils/logger.js";
import type { ScheduledTask, ScheduledTaskExecutionResult } from "../types/scheduled-task.js";
import {
  markScheduledTaskSessionActive,
  markScheduledTaskSessionInactive,
} from "../managers/scheduled-task-active-session-manager.js";

export const SCHEDULED_TASK_AGENT = "build";
const EXECUTION_POLL_INTERVAL_MS = 2000;
const MAX_IDLE_POLLS_WITHOUT_RESULT = 3;
// Grace period for the server to start the session before any activity is seen.
const MAX_STARTUP_POLLS_WITHOUT_ACTIVITY = 45;
const COMPLETED_EMPTY_RESULT_RECHECK_INTERVAL_MS = 500;
const MAX_COMPLETED_EMPTY_RESULT_RECHECKS = 3;
const MODELS_DOCS_URL = "https://opencode.ai/docs/config/#models";
const EXECUTION_TIMEOUT_ERROR_PREFIX = "Scheduled task exceeded bot execution timeout";
const INTERACTIVE_PERMISSION_REJECT_MESSAGE =
  "Scheduled task cannot continue because it requires interactive permission.";

type InteractiveRequestKind = "question" | "permission";

type PendingQuestionRequest = {
  id: string;
  sessionID: string;
  questions?: unknown[];
};

type PendingPermissionRequest = {
  id: string;
  sessionID: string;
  permission?: string;
  patterns?: string[];
};

type PendingInteractiveRequest =
  | { kind: "question"; request: PendingQuestionRequest }
  | { kind: "permission"; request: PendingPermissionRequest };

type MessagePartSnapshot = {
  id?: string;
  type?: string;
  text?: string;
  ignored?: boolean;
  tool?: string;
  reason?: string;
  state?: { status?: string };
};

type TextLikePart = Pick<MessagePartSnapshot, "type" | "text" | "ignored">;

type AssistantMessageSnapshot = {
  info: {
    id?: string;
    role: string;
    summary?: unknown;
    finish?: string;
    time?: { created?: number; completed?: number };
    error?: unknown;
  };
  parts: MessagePartSnapshot[];
};

class ScheduledTaskEmptyAssistantResponseError extends Error {
  constructor() {
    super("Scheduled task returned an empty assistant response");
    this.name = "ScheduledTaskEmptyAssistantResponseError";
  }
}

class ScheduledTaskInteractiveRequestError extends Error {
  constructor(kind: InteractiveRequestKind) {
    super(
      t(
        kind === "question"
          ? "task.run.error.interactive_question"
          : "task.run.error.interactive_permission",
      ),
    );
    this.name = "ScheduledTaskInteractiveRequestError";
  }
}

function collectResponseText(parts: TextLikePart[]): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string" && !part.ignored)
    .map((part) => part.text)
    .join("")
    .trim();
}

function extractErrorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }

  if (!error || typeof error !== "object") {
    return null;
  }

  const typedError = error as {
    message?: unknown;
    name?: unknown;
    data?: { message?: unknown };
  };

  if (typeof typedError.data?.message === "string" && typedError.data.message.trim()) {
    return typedError.data.message.trim();
  }

  if (typeof typedError.message === "string" && typedError.message.trim()) {
    return typedError.message.trim();
  }

  if (typeof typedError.name === "string" && typedError.name.trim()) {
    return typedError.name.trim();
  }

  return null;
}

function isTimeoutErrorMessage(message: string): boolean {
  return /(timed out|timeout|time out|deadline exceeded|request aborted)/i.test(message);
}

function isBotExecutionTimeoutMessage(message: string): boolean {
  return message.startsWith(EXECUTION_TIMEOUT_ERROR_PREFIX);
}

function createExecutionTimeoutMessage(): string {
  return `${EXECUTION_TIMEOUT_ERROR_PREFIX} after ${config.bot.scheduledTaskExecutionTimeoutMinutes} minutes.`;
}

function getExecutionTimeoutMs(): number {
  return config.bot.scheduledTaskExecutionTimeoutMinutes * 60 * 1000;
}

function normalizeScheduledTaskErrorMessage(message: string): string {
  if (
    isBotExecutionTimeoutMessage(message) ||
    !isTimeoutErrorMessage(message) ||
    message.includes(MODELS_DOCS_URL)
  ) {
    return message;
  }

  return `${message} Check OpenCode model timeout settings: ${MODELS_DOCS_URL}`;
}

function toErrorMessage(error: unknown): string {
  const message = extractErrorMessage(error);
  if (message) {
    return normalizeScheduledTaskErrorMessage(message);
  }

  return "Unknown scheduled task execution error";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findLatestAssistantMessage(
  messages: Array<{
    info: { role: string; summary?: unknown; finish?: string };
    parts: MessagePartSnapshot[];
  }>,
  startedAtMs: number,
): AssistantMessageSnapshot | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const createdAt = (message as AssistantMessageSnapshot | undefined)?.info.time?.created;
    if (
      message?.info.role === "assistant" &&
      !message.info.summary &&
      typeof createdAt === "number" &&
      createdAt >= startedAtMs
    ) {
      return message;
    }
  }

  return null;
}

function getAssistantFinishReason(message: AssistantMessageSnapshot): string | null {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (part?.type === "step-finish" && typeof part.reason === "string" && part.reason.trim()) {
      return part.reason.trim();
    }
  }

  if (typeof message.info.finish === "string" && message.info.finish.trim()) {
    return message.info.finish.trim();
  }

  return null;
}

function extractAssistantResult(message: AssistantMessageSnapshot | null): {
  resultText: string | null;
  errorMessage: string | null;
  completed: boolean;
  message: AssistantMessageSnapshot | null;
} {
  if (!message) {
    return {
      resultText: null,
      errorMessage: null,
      completed: false,
      message: null,
    };
  }

  const errorMessage = extractErrorMessage(message.info.error);
  if (errorMessage) {
    return {
      resultText: null,
      errorMessage: normalizeScheduledTaskErrorMessage(errorMessage),
      completed: true,
      message,
    };
  }

  const resultText = collectResponseText(message.parts);
  const completed = Boolean(message.info.time?.completed);
  const finishReason = getAssistantFinishReason(message);
  const awaitingToolCalls = completed && finishReason === "tool-calls";

  return {
    resultText: awaitingToolCalls ? null : resultText,
    errorMessage: null,
    completed: completed && !awaitingToolCalls,
    message,
  };
}

function summarizeAssistantParts(parts: MessagePartSnapshot[]): Array<{
  id?: string;
  type?: string;
  ignored?: boolean;
  textLength?: number;
  tool?: string;
  status?: string;
}> {
  return parts.map((part) => ({
    id: part.id,
    type: part.type,
    ignored: part.ignored,
    reason: part.reason,
    ...(typeof part.text === "string" ? { textLength: part.text.length } : {}),
    ...(part.tool ? { tool: part.tool } : {}),
    ...(part.state?.status ? { status: part.state.status } : {}),
  }));
}

function logEmptyAssistantResponseDiagnostics(
  taskId: string,
  sessionId: string,
  directory: string,
  message: AssistantMessageSnapshot | null,
  readCount: number,
): void {
  logger.warn("[ScheduledTaskExecutor] Empty completed assistant response diagnostics", {
    taskId,
    sessionId,
    directory,
    readCount,
    assistantMessage: message
      ? {
          id: message.info.id,
          completed: Boolean(message.info.time?.completed),
          summary: Boolean(message.info.summary),
          finish: getAssistantFinishReason(message),
          errorMessage: extractErrorMessage(message.info.error),
          parts: summarizeAssistantParts(message.parts),
        }
      : null,
  });
}

async function loadPendingInteractiveRequest(
  sessionId: string,
  directory: string,
): Promise<PendingInteractiveRequest | null> {
  const [questionsResult, permissionsResult] = await Promise.all([
    opencodeClient.question.list({ directory }),
    opencodeClient.permission.list({ directory }),
  ]);

  if (questionsResult.error) {
    logger.warn(
      `[ScheduledTaskExecutor] Failed to list pending questions: sessionId=${sessionId}`,
      questionsResult.error,
    );
  }

  const question = questionsResult.data?.find((request) => request.sessionID === sessionId);
  if (question) {
    return { kind: "question", request: question };
  }

  if (permissionsResult.error) {
    logger.warn(
      `[ScheduledTaskExecutor] Failed to list pending permissions: sessionId=${sessionId}`,
      permissionsResult.error,
    );
  }

  const permission = permissionsResult.data?.find((request) => request.sessionID === sessionId);
  if (permission) {
    return { kind: "permission", request: permission };
  }

  return null;
}

async function rejectInteractiveRequest(
  request: PendingInteractiveRequest,
  directory: string,
): Promise<void> {
  try {
    if (request.kind === "question") {
      const { error } = await opencodeClient.question.reject({
        requestID: request.request.id,
        directory,
      });

      if (error) {
        logger.warn(
          `[ScheduledTaskExecutor] Failed to reject pending question: requestId=${request.request.id}`,
          error,
        );
      }

      return;
    }

    const { error } = await opencodeClient.permission.reply({
      requestID: request.request.id,
      directory,
      reply: "reject",
      message: INTERACTIVE_PERMISSION_REJECT_MESSAGE,
    });

    if (error) {
      logger.warn(
        `[ScheduledTaskExecutor] Failed to reject pending permission: requestId=${request.request.id}`,
        error,
      );
    }
  } catch (error) {
    logger.warn(
      `[ScheduledTaskExecutor] Failed to reject pending interactive request: requestId=${request.request.id}`,
      error,
    );
  }
}

async function abortScheduledTaskSession(sessionId: string, directory: string): Promise<void> {
  try {
    const { error } = await opencodeClient.session.abort({ sessionID: sessionId, directory });
    if (error) {
      logger.warn(
        `[ScheduledTaskExecutor] Failed to abort interactive scheduled task session: sessionId=${sessionId}`,
        error,
      );
    }
  } catch (error) {
    logger.warn(
      `[ScheduledTaskExecutor] Failed to abort interactive scheduled task session: sessionId=${sessionId}`,
      error,
    );
  }
}

async function failIfInteractiveRequest(
  taskId: string,
  sessionId: string,
  directory: string,
): Promise<void> {
  const interactiveRequest = await loadPendingInteractiveRequest(sessionId, directory);
  if (!interactiveRequest) {
    return;
  }

  logger.warn("[ScheduledTaskExecutor] Scheduled task requested interactive action", {
    taskId,
    sessionId,
    directory,
    kind: interactiveRequest.kind,
    requestId: interactiveRequest.request.id,
    ...(interactiveRequest.kind === "question"
      ? { questionCount: interactiveRequest.request.questions?.length ?? 0 }
      : {
          permission: interactiveRequest.request.permission,
          patterns: interactiveRequest.request.patterns,
        }),
  });

  await rejectInteractiveRequest(interactiveRequest, directory);
  await abortScheduledTaskSession(sessionId, directory);
  throw new ScheduledTaskInteractiveRequestError(interactiveRequest.kind);
}

async function loadAssistantResult(
  sessionId: string,
  directory: string,
  startedAtMs: number,
): Promise<ReturnType<typeof extractAssistantResult>> {
  const { data: messages, error: messagesError } = await opencodeClient.session.messages({
    sessionID: sessionId,
    directory,
  });

  if (messagesError || !messages) {
    throw messagesError || new Error("Failed to load scheduled task messages");
  }

  return extractAssistantResult(findLatestAssistantMessage(messages, startedAtMs));
}

async function waitForScheduledTaskResult(
  taskId: string,
  sessionId: string,
  directory: string,
  startedAtMs: number,
): Promise<string> {
  const executionTimeoutMs = getExecutionTimeoutMs();
  let idlePollsWithoutResult = 0;
  let startupPollsWithoutActivity = 0;
  let hasObservedActivity = false;
  let completedEmptyResultReadCount = 0;

  while (true) {
    if (Date.now() - startedAtMs >= executionTimeoutMs) {
      throw new Error(createExecutionTimeoutMessage());
    }

    await failIfInteractiveRequest(taskId, sessionId, directory);

    const assistantResult = await loadAssistantResult(sessionId, directory, startedAtMs);

    if (assistantResult.errorMessage) {
      throw new Error(assistantResult.errorMessage);
    }

    if (assistantResult.completed) {
      if (assistantResult.resultText) {
        return assistantResult.resultText;
      }

      completedEmptyResultReadCount += 1;
      if (completedEmptyResultReadCount > MAX_COMPLETED_EMPTY_RESULT_RECHECKS) {
        logEmptyAssistantResponseDiagnostics(
          taskId,
          sessionId,
          directory,
          assistantResult.message,
          completedEmptyResultReadCount,
        );
        throw new ScheduledTaskEmptyAssistantResponseError();
      }

      await sleep(COMPLETED_EMPTY_RESULT_RECHECK_INTERVAL_MS);
      continue;
    }

    completedEmptyResultReadCount = 0;

    const { data: statuses, error: statusError } = await opencodeClient.session.status({
      directory,
    });
    if (statusError || !statuses) {
      throw statusError || new Error("Failed to load scheduled task status");
    }

    const sessionStatus = statuses[sessionId];
    const sessionIsActive = sessionStatus !== undefined && sessionStatus.type !== "idle";

    if (sessionIsActive) {
      hasObservedActivity = true;
      idlePollsWithoutResult = 0;
      startupPollsWithoutActivity = 0;
    } else {
      const confirmedAssistantResult = await loadAssistantResult(sessionId, directory, startedAtMs);

      if (confirmedAssistantResult.errorMessage) {
        throw new Error(confirmedAssistantResult.errorMessage);
      }

      if (confirmedAssistantResult.completed) {
        if (confirmedAssistantResult.resultText) {
          return confirmedAssistantResult.resultText;
        }

        completedEmptyResultReadCount += 1;
        if (completedEmptyResultReadCount > MAX_COMPLETED_EMPTY_RESULT_RECHECKS) {
          logEmptyAssistantResponseDiagnostics(
            taskId,
            sessionId,
            directory,
            confirmedAssistantResult.message,
            completedEmptyResultReadCount,
          );
          throw new ScheduledTaskEmptyAssistantResponseError();
        }

        await sleep(COMPLETED_EMPTY_RESULT_RECHECK_INTERVAL_MS);
        continue;
      }

      if (hasObservedActivity) {
        idlePollsWithoutResult += 1;
        if (idlePollsWithoutResult >= MAX_IDLE_POLLS_WITHOUT_RESULT) {
          throw new Error("Scheduled task finished without a completed assistant response");
        }
      } else {
        startupPollsWithoutActivity += 1;
        if (startupPollsWithoutActivity >= MAX_STARTUP_POLLS_WITHOUT_ACTIVITY) {
          throw new Error("Scheduled task did not start producing a response in time");
        }
      }
    }

    await sleep(EXECUTION_POLL_INTERVAL_MS);
  }
}

async function waitForBoundSessionIdle(
  sessionId: string,
  directory: string,
  startedAtMs: number,
): Promise<void> {
  while (Date.now() - startedAtMs < getExecutionTimeoutMs()) {
    const { data: statuses, error } = await opencodeClient.session.status({ directory });
    if (error || !statuses) {
      throw error || new Error("Failed to load bound session status");
    }

    const status = statuses[sessionId]?.type;
    if (status !== "busy" && status !== "retry") {
      return;
    }

    await sleep(EXECUTION_POLL_INTERVAL_MS);
  }

  throw new Error(createExecutionTimeoutMessage());
}

async function executeScheduledTaskInBoundSession(
  task: ScheduledTask,
): Promise<ScheduledTaskExecutionResult> {
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.parse(startedAt);
  let promptStarted = false;

  try {
    if (!task.sessionId || !task.sessionTitle) {
      throw new Error("Scheduled task is not bound to a session. Recreate the task.");
    }

    await waitForBoundSessionIdle(task.sessionId, task.projectWorktree, startedAtMs);
    markScheduledTaskSessionActive(task.sessionId);
    const responseStartedAtMs = Date.now();

    const promptOptions: {
      sessionID: string;
      directory: string;
      parts: Array<{ type: "text"; text: string }>;
      agent: string;
      model?: { providerID: string; modelID: string };
      variant?: string;
    } = {
      sessionID: task.sessionId,
      directory: task.projectWorktree,
      parts: [{ type: "text", text: task.prompt }],
      agent: SCHEDULED_TASK_AGENT,
    };

    if (task.model.providerID && task.model.modelID) {
      promptOptions.model = {
        providerID: task.model.providerID,
        modelID: task.model.modelID,
      };
    }

    if (task.model.variant) {
      promptOptions.variant = task.model.variant;
    }

    const { error: promptError } = await opencodeClient.session.promptAsync(promptOptions);

    if (promptError) {
      throw promptError || new Error("Scheduled task prompt execution failed");
    }
    promptStarted = true;

    const resultText = await waitForScheduledTaskResult(
      task.id,
      task.sessionId,
      task.projectWorktree,
      responseStartedAtMs,
    );

    return {
      taskId: task.id,
      status: "success",
      startedAt,
      finishedAt: new Date().toISOString(),
      resultText,
      errorMessage: null,
    };
  } catch (error) {
    const errorMessage = toErrorMessage(error);
    if (promptStarted && !(error instanceof ScheduledTaskInteractiveRequestError)) {
      await abortScheduledTaskSession(task.sessionId, task.projectWorktree);
    }

    logger.warn(
      `[ScheduledTaskExecutor] Task execution failed: id=${task.id}, message=${errorMessage}`,
    );

    return {
      taskId: task.id,
      status: "error",
      startedAt,
      finishedAt: new Date().toISOString(),
      resultText: null,
      errorMessage,
    };
  } finally {
    markScheduledTaskSessionInactive(task.sessionId);
  }
}

const sessionExecutionQueues = new Map<string, Promise<void>>();

export function executeScheduledTask(task: ScheduledTask): Promise<ScheduledTaskExecutionResult> {
  const previous = sessionExecutionQueues.get(task.sessionId) ?? Promise.resolve();
  const result = previous
    .catch(() => undefined)
    .then(() => executeScheduledTaskInBoundSession(task));
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  sessionExecutionQueues.set(task.sessionId, tail);
  void tail.finally(() => {
    if (sessionExecutionQueues.get(task.sessionId) === tail) {
      sessionExecutionQueues.delete(task.sessionId);
    }
  });
  return result;
}
