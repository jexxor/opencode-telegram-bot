import type { Context } from "grammy";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import type {
  BlockReason,
  ExpectedInput,
  GuardDecision,
  IncomingInputType,
  InteractionState,
} from "../../app/types/interaction.js";
import { foregroundSessionState } from "../../app/managers/foreground-session-state-manager.js";
import { attachManager } from "../../app/managers/attach-manager.js";
import { getCurrentSession } from "../../app/services/session-service.js";

const BUSY_ALLOWED_COMMANDS = [
  "/abort",
  "/detach",
  "/status",
  "/help",
  "/sessions",
  "/working",
  "/projects",
  "/loop",
  "/loops",
  "/new",
] as const;
const BUSY_ALLOWED_COMMAND_SET = new Set<string>(BUSY_ALLOWED_COMMANDS);

function isBusyAllowedCommand(command?: string): boolean {
  return Boolean(command && BUSY_ALLOWED_COMMAND_SET.has(command));
}

function allowsBusyInteraction(state: InteractionState | null): boolean {
  return (
    state?.kind === "question" ||
    state?.kind === "permission" ||
    (state?.kind === "custom" &&
      (state.metadata.flow === "loop-create" || state.metadata.flow === "loops"))
  );
}

function allowsBusySessionSelection(ctx: Context): boolean {
  const callbackData = ctx.callbackQuery?.data;
  return (
    typeof callbackData === "string" &&
    (callbackData.startsWith("session:") ||
      callbackData.startsWith("background-session:") ||
      callbackData.startsWith("project:") ||
      callbackData.startsWith("projects:page:") ||
      callbackData.startsWith("loop:") ||
      callbackData.startsWith("loops:"))
  );
}

function normalizeIncomingCommand(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const token = trimmed.split(/\s+/)[0];
  const withoutMention = token.split("@")[0].toLowerCase();

  if (withoutMention.length <= 1) {
    return null;
  }

  return withoutMention;
}

function classifyIncomingInput(ctx: Context): {
  inputType: IncomingInputType;
  command?: string;
} {
  if (ctx.callbackQuery?.data) {
    return { inputType: "callback" };
  }

  const text = ctx.message?.text;
  if (typeof text === "string") {
    const command = normalizeIncomingCommand(text);
    if (command) {
      return { inputType: "command", command };
    }

    return { inputType: "text" };
  }

  // Photo, voice, audio, and other non-text messages are classified as "other"
  if (ctx.message?.photo) {
    return { inputType: "other" };
  }

  return { inputType: "other" };
}

function getExpectedInputBlockReason(expectedInput: ExpectedInput): BlockReason {
  switch (expectedInput) {
    case "callback":
      return "expected_callback";
    case "command":
      return "expected_command";
    case "text":
    case "mixed":
      return "expected_text";
  }
}

function createAllowDecision(
  inputType: IncomingInputType,
  state: InteractionState | null,
  command?: string,
  busy?: boolean,
): GuardDecision {
  return {
    allow: true,
    inputType,
    state,
    command,
    busy,
  };
}

function createBlockDecision(
  inputType: IncomingInputType,
  state: InteractionState,
  reason: BlockReason,
  command?: string,
  busy?: boolean,
): GuardDecision {
  return {
    allow: false,
    inputType,
    state,
    reason,
    command,
    busy,
  };
}

function createBusyBlockDecision(
  inputType: IncomingInputType,
  state: InteractionState | null,
  reason: BlockReason,
  command?: string,
): GuardDecision {
  return {
    allow: false,
    inputType,
    state,
    reason,
    command,
    busy: true,
  };
}

function isAllowedRenameCancelCallback(ctx: Context, state: InteractionState): boolean {
  return (
    state.kind === "rename" &&
    state.expectedInput === "text" &&
    ctx.callbackQuery?.data === "rename:cancel"
  );
}

function isAllowedTaskCallback(ctx: Context, state: InteractionState): boolean {
  return (
    state.kind === "task" &&
    (ctx.callbackQuery?.data === "task:cancel" || ctx.callbackQuery?.data === "task:retry-schedule")
  );
}

export function resolveInteractionGuardDecision(ctx: Context): GuardDecision {
  const state = interactionManager.getSnapshot();
  const { inputType, command } = classifyIncomingInput(ctx);
  const currentSession = getCurrentSession();
  const isBusy =
    attachManager.isBusy() ||
    (currentSession === null
      ? foregroundSessionState.isBusy()
      : foregroundSessionState
          .getBusySessions()
          .some((session) => session.sessionId === currentSession.id));

  if (state && interactionManager.isExpired()) {
    interactionManager.clear("expired");
    return createBlockDecision(inputType, state, "expired", command, isBusy);
  }

  if (isBusy) {
    if (inputType === "callback" && allowsBusySessionSelection(ctx)) {
      return createAllowDecision(inputType, state, command, true);
    }

    if (inputType === "command") {
      if (isBusyAllowedCommand(command)) {
        return createAllowDecision(inputType, state, command, true);
      }

      return createBusyBlockDecision(inputType, state, "command_not_allowed", command);
    }

    if (inputType === "text" && !state) {
      return createAllowDecision(inputType, null, command, true);
    }

    if (state && allowsBusyInteraction(state)) {
      if (state.expectedInput === "mixed") {
        if (inputType === "callback" || inputType === "text") {
          return createAllowDecision(inputType, state, command, true);
        }

        return createBusyBlockDecision(inputType, state, "expected_text", command);
      }

      if (state.expectedInput === inputType) {
        return createAllowDecision(inputType, state, command, true);
      }

      return createBusyBlockDecision(
        inputType,
        state,
        getExpectedInputBlockReason(state.expectedInput),
        command,
      );
    }

    return createBusyBlockDecision(inputType, state, "expected_text", command);
  }

  if (!state) {
    return createAllowDecision(inputType, null, command);
  }

  if (inputType === "command") {
    if (command === "/start") {
      return createAllowDecision(inputType, state, command);
    }

    if (command && state.allowedCommands.includes(command)) {
      return createAllowDecision(inputType, state, command);
    }

    return createBlockDecision(inputType, state, "command_not_allowed", command);
  }

  if (state.expectedInput === "mixed") {
    if (inputType === "callback" || inputType === "text") {
      return createAllowDecision(inputType, state, command);
    }

    return createBlockDecision(inputType, state, "expected_text", command);
  }

  if (inputType === "callback" && isAllowedRenameCancelCallback(ctx, state)) {
    return createAllowDecision(inputType, state, command);
  }

  if (inputType === "callback" && isAllowedTaskCallback(ctx, state)) {
    return createAllowDecision(inputType, state, command);
  }

  if (state.expectedInput === inputType) {
    return createAllowDecision(inputType, state, command);
  }

  return createBlockDecision(
    inputType,
    state,
    getExpectedInputBlockReason(state.expectedInput),
    command,
  );
}
