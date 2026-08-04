import { randomUUID } from "node:crypto";
import type { CommandContext, Context } from "grammy";
import { config } from "../../config.js";
import { agentLoopCreationManager } from "../../app/managers/agent-loop-creation-manager.js";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import { resolveProjectAgent, getStoredAgent } from "../../app/services/agent-selection-service.js";
import { agentLoopRuntime } from "../../app/services/agent-loop-runtime-service.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { getCurrentProject } from "../../app/stores/settings-store.js";
import { addAgentLoop } from "../../app/stores/agent-loop-store.js";
import { createScheduledTaskModel } from "../../app/types/scheduled-task.js";
import { opencodeClient } from "../../opencode/client.js";
import { t } from "../../i18n/index.js";
import {
  buildLoopSessionKeyboard,
  formatSelectedLoopSteps,
} from "../menus/agent-loop-menu.js";

const SESSION_FETCH_EXTRA_COUNT = 1;

function isValidLoopMinutes(value: number, allowZero = false): boolean {
  const minimum = allowZero ? 0 : 1;
  return (
    Number.isSafeInteger(value) &&
    value >= minimum &&
    Number.isFinite(new Date(Date.now() + value * 60_000).getTime())
  );
}

export async function loadLoopSessionPage(directory: string, page: number) {
  const pageSize = config.bot.sessionsListLimit;
  const end = (page + 1) * pageSize;
  const { data, error } = await opencodeClient.session.list({
    directory,
    roots: true,
    limit: end + SESSION_FETCH_EXTRA_COUNT,
  });
  if (error || !data) throw error || new Error("Failed to load sessions");
  return {
    sessions: data.slice(page * pageSize, end).map((session) => ({
      id: session.id,
      title: session.title,
      directory: session.directory || directory,
    })),
    hasNext: data.length > end,
  };
}

export async function loopCommand(ctx: CommandContext<Context>): Promise<void> {
  const project = getCurrentProject();
  if (!project) {
    await ctx.reply(t("bot.project_not_selected"));
    return;
  }
  const page = await loadLoopSessionPage(project.worktree, 0);
  if (page.sessions.length === 0) {
    await ctx.reply(t("sessions.empty"));
    return;
  }
  const agent = await resolveProjectAgent(getStoredAgent());
  const model = createScheduledTaskModel(getStoredModel());
  agentLoopCreationManager.start(project.id, project.worktree, agent, model);
  const message = await ctx.reply(
    `${t("loop.select")}\n\n${formatSelectedLoopSteps([])}`,
    { reply_markup: buildLoopSessionKeyboard(page.sessions, 0, page.hasNext, false) },
  );
  agentLoopCreationManager.setMessageId(message.message_id);
  interactionManager.start({
    kind: "custom",
    expectedInput: "callback",
    metadata: { flow: "loop-create", stage: "select", messageId: message.message_id },
  });
}

export async function handleLoopTextInput(ctx: Context): Promise<boolean> {
  const state = agentLoopCreationManager.getState();
  const text = ctx.message?.text;
  if (!state || !text || text.startsWith("/")) return false;
  if (state.stage === "awaiting_interval") {
    const interval = Number(text.trim());
    if (!isValidLoopMinutes(interval)) {
      await ctx.reply(t("loop.interval.invalid"));
      return true;
    }
    agentLoopCreationManager.setInterval(interval);
    interactionManager.transition({
      expectedInput: "text",
      metadata: { flow: "loop-create", stage: "timeout", messageId: state.messageId },
    });
    await ctx.reply(t("loop.timeout"));
    return true;
  }
  if (state.stage === "awaiting_timeout") {
    const timeout = Number(text.trim());
    if (!isValidLoopMinutes(timeout, true)) {
      await ctx.reply(t("loop.timeout.invalid"));
      return true;
    }
    agentLoopCreationManager.setTimeoutMinutes(timeout === 0 ? null : timeout);
    interactionManager.transition({
      expectedInput: "text",
      metadata: { flow: "loop-create", stage: "prompt", messageId: state.messageId },
    });
    await ctx.reply(t("loop.prompt"));
    return true;
  }
  if (state.stage !== "awaiting_prompt" || !state.intervalMinutes) return false;
  const prompt = text.trim();
  if (!prompt) {
    await ctx.reply(t("loop.prompt.invalid"));
    return true;
  }
  const now = new Date().toISOString();
  const loop = {
    id: randomUUID(),
    projectId: state.projectId,
    projectWorktree: state.projectWorktree,
    steps: state.steps,
    intervalMinutes: state.intervalMinutes,
    timeoutMinutes: state.timeoutMinutes,
    prompt,
    agent: state.agent,
    model: state.model,
    status: "running" as const,
    currentStepIndex: 0,
    completedCycles: 0,
    runStartedAt: now,
    runStoppedAt: null,
    nextRunAt: now,
    expiresAt: state.timeoutMinutes
      ? new Date(Date.now() + state.timeoutMinutes * 60_000).toISOString()
      : null,
    lastRunAt: null,
    stopReason: null,
    createdAt: now,
  };
  await addAgentLoop(loop);
  agentLoopRuntime.registerLoop(loop);
  agentLoopCreationManager.clear();
  interactionManager.clear("loop_created");
  await ctx.reply(t("loop.created", { count: loop.steps.length, interval: loop.intervalMinutes }));
  return true;
}
