import type { Bot, Context } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { logger } from "../../utils/logger.js";
import {
  listQueuedSessionPrompts,
  removeQueuedSessionPrompt,
} from "../stores/session-prompt-queue-store.js";
import type { QueuedSessionPrompt } from "../types/session.js";
import { t } from "../../i18n/index.js";
import { foregroundSessionState } from "../managers/foreground-session-state-manager.js";
import { assistantRunState } from "../managers/assistant-run-state-manager.js";
import { sessionStatusManager } from "../managers/session-status-manager.js";
import { externalUserInputSuppressionManager } from "../managers/external-input-suppression-manager.js";
import { getAgentLoop } from "../stores/agent-loop-store.js";
import { markAttachedSessionBusy, markAttachedSessionIdle } from "./attach-service.js";

const POLL_INTERVAL_MS = 2_000;

function isActiveLoopPrompt(prompt: QueuedSessionPrompt): boolean {
  if (!prompt.agentLoopId) return true;
  const loop = getAgentLoop(prompt.agentLoopId);
  return (
    loop?.status === "running" &&
    (!prompt.agentLoopRunStartedAt || loop.runStartedAt === prompt.agentLoopRunStartedAt)
  );
}

export class SessionPromptQueueRuntime {
  private timer: ReturnType<typeof setInterval> | null = null;
  private bot: Bot<Context> | null = null;
  private chatId: number | null = null;
  private processingSessionIds = new Set<string>();

  initialize(bot: Bot<Context>, chatId: number): void {
    this.bot = bot;
    this.chatId = chatId;
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => void this.flush(), POLL_INTERVAL_MS);
    this.timer.unref?.();
    void this.flush();
  }

  notifyQueueChanged(): void {
    void this.flush();
  }

  shutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.processingSessionIds.clear();
    this.bot = null;
    this.chatId = null;
  }

  private async flush(): Promise<void> {
    const firstBySession = new Map<string, QueuedSessionPrompt>();
    for (const prompt of listQueuedSessionPrompts()) {
      if (!firstBySession.has(prompt.sessionId)) {
        firstBySession.set(prompt.sessionId, prompt);
      }
    }

    await Promise.all([...firstBySession.values()].map((prompt) => this.tryDispatch(prompt)));
  }

  private async tryDispatch(prompt: QueuedSessionPrompt): Promise<void> {
    if (this.processingSessionIds.has(prompt.sessionId)) {
      return;
    }
    this.processingSessionIds.add(prompt.sessionId);
    let runStarted = false;

    try {
      if (!isActiveLoopPrompt(prompt)) {
        await removeQueuedSessionPrompt(prompt.id);
        return;
      }

      if (assistantRunState.getRun(prompt.sessionId)) {
        return;
      }

      const { data: statuses, error: statusError } = await opencodeClient.session.status({
        directory: prompt.directory,
      });
      if (statusError || !statuses) {
        return;
      }

      const status = (statuses as Record<string, { type?: string }>)[prompt.sessionId];
      if (status?.type === "busy") {
        return;
      }

      sessionStatusManager.register({
        id: prompt.sessionId,
        title: prompt.sessionTitle,
        directory: prompt.directory,
      });
      foregroundSessionState.markBusy(prompt.sessionId, prompt.directory);
      sessionStatusManager.markWorking(prompt.sessionId);
      assistantRunState.startRun(prompt.sessionId, {
        startedAt: Date.now(),
        configuredAgent: prompt.agent,
        configuredProviderID: prompt.model.providerID,
        configuredModelID: prompt.model.modelID,
        ...(prompt.agentLoopId ? { agentLoopId: prompt.agentLoopId } : {}),
        ...(prompt.agentLoopRunStartedAt
          ? { agentLoopRunStartedAt: prompt.agentLoopRunStartedAt }
          : {}),
      });
      externalUserInputSuppressionManager.register(prompt.sessionId, prompt.text);
      runStarted = true;
      await markAttachedSessionBusy(prompt.sessionId);

      if (!isActiveLoopPrompt(prompt)) {
        foregroundSessionState.markIdle(prompt.sessionId);
        sessionStatusManager.markFinished(prompt.sessionId);
        assistantRunState.clearRun(prompt.sessionId, "queued_loop_stopped");
        await markAttachedSessionIdle(prompt.sessionId);
        await removeQueuedSessionPrompt(prompt.id);
        runStarted = false;
        return;
      }

      const { error } = await opencodeClient.session.promptAsync({
        sessionID: prompt.sessionId,
        directory: prompt.directory,
        parts: [{ type: "text", text: prompt.text }],
        agent: prompt.agent,
        ...(prompt.model.providerID && prompt.model.modelID
          ? {
              model: {
                providerID: prompt.model.providerID,
                modelID: prompt.model.modelID,
              },
            }
          : {}),
        ...(prompt.model.variant ? { variant: prompt.model.variant } : {}),
      });
      if (error) {
        foregroundSessionState.markIdle(prompt.sessionId);
        sessionStatusManager.markFinished(prompt.sessionId);
        assistantRunState.clearRun(prompt.sessionId, "queued_prompt_api_error");
        await markAttachedSessionIdle(prompt.sessionId);
        runStarted = false;
        logger.warn(
          `[SessionPromptQueue] Failed to dispatch queued prompt: id=${prompt.id}, session=${prompt.sessionId}`,
          error,
        );
        return;
      }

      if (!isActiveLoopPrompt(prompt)) {
        const { error: abortError } = await opencodeClient.session.abort({
          sessionID: prompt.sessionId,
          directory: prompt.directory,
        });
        if (abortError) {
          logger.warn(
            `[SessionPromptQueue] Failed to abort stale loop prompt: id=${prompt.id}, session=${prompt.sessionId}`,
            abortError,
          );
        }
        foregroundSessionState.markIdle(prompt.sessionId);
        sessionStatusManager.markFinished(prompt.sessionId);
        assistantRunState.clearRun(prompt.sessionId, "queued_loop_stopped_after_dispatch");
        await markAttachedSessionIdle(prompt.sessionId);
        await removeQueuedSessionPrompt(prompt.id);
        runStarted = false;
        return;
      }

      await removeQueuedSessionPrompt(prompt.id);
      logger.info(
        `[SessionPromptQueue] Dispatched queued prompt: id=${prompt.id}, session=${prompt.sessionId}, directory=${prompt.directory}`,
      );
      await this.bot?.api
        .sendMessage(this.chatId!, t("bot.prompt_queue_started", { session: prompt.sessionTitle }))
        .catch((error) => logger.warn("[SessionPromptQueue] Failed to send start notification", error));
    } catch (error) {
      if (runStarted) {
        foregroundSessionState.markIdle(prompt.sessionId);
        sessionStatusManager.markFinished(prompt.sessionId);
        assistantRunState.clearRun(prompt.sessionId, "queued_prompt_dispatch_error");
        await markAttachedSessionIdle(prompt.sessionId);
      }
      logger.warn(
        `[SessionPromptQueue] Failed to process queued prompt: id=${prompt.id}, session=${prompt.sessionId}`,
        error,
      );
    } finally {
      this.processingSessionIds.delete(prompt.sessionId);
    }
  }
}

export const sessionPromptQueueRuntime = new SessionPromptQueueRuntime();
