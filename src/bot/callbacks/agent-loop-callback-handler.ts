import type { Context } from "grammy";
import { config } from "../../config.js";
import { agentLoopCreationManager } from "../../app/managers/agent-loop-creation-manager.js";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import { agentLoopRuntime } from "../../app/services/agent-loop-runtime-service.js";
import { getAgentLoop, listAgentLoops } from "../../app/stores/agent-loop-store.js";
import { opencodeClient } from "../../opencode/client.js";
import { t } from "../../i18n/index.js";
import { loadLoopSessionPage } from "../commands/loop-command.js";
import {
  buildLoopDetailsKeyboard,
  buildLoopDetailsText,
  buildLoopSessionKeyboard,
  buildLoopsListKeyboard,
  formatSelectedLoopSteps,
  LOOP_CALLBACK_PREFIX,
  LOOP_CANCEL,
  LOOP_OK,
  LOOP_PAGE_PREFIX,
  LOOP_SELECT_PREFIX,
  LOOP_UNDO,
  LOOPS_BACK,
  LOOPS_CALLBACK_PREFIX,
  LOOPS_CLOSE,
  LOOPS_DELETE_PREFIX,
  LOOPS_OPEN_PREFIX,
  LOOPS_PAGE_PREFIX,
  LOOPS_RUN_PREFIX,
  LOOPS_STOP_PREFIX,
} from "../menus/agent-loop-menu.js";

function getMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  return message && "message_id" in message ? message.message_id : null;
}

function hasActiveFlow(ctx: Context, flow: string): boolean {
  const state = interactionManager.getSnapshot();
  return (
    state?.kind === "custom" &&
    state.metadata.flow === flow &&
    state.metadata.messageId === getMessageId(ctx)
  );
}

async function renderCreationMenu(ctx: Context): Promise<void> {
  const state = agentLoopCreationManager.getState();
  if (!state) return;
  const page = await loadLoopSessionPage(state.projectWorktree, state.page);
  await ctx.editMessageText(
    `${t("loop.select")}\n\n${formatSelectedLoopSteps(state.steps)}`,
    {
      reply_markup: buildLoopSessionKeyboard(
        page.sessions,
        state.page,
        page.hasNext,
        state.steps.length > 0,
      ),
    },
  );
}

export async function handleLoopCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith(LOOP_CALLBACK_PREFIX)) return false;
  if (!hasActiveFlow(ctx, "loop-create")) {
    await ctx.answerCallbackQuery({ text: t("inline.inactive_callback"), show_alert: true });
    return true;
  }
  const state = agentLoopCreationManager.getState();
  if (!state || state.stage !== "selecting_sessions") return true;

  if (data === LOOP_CANCEL) {
    agentLoopCreationManager.clear();
    interactionManager.clear("loop_cancelled");
    await ctx.answerCallbackQuery({ text: t("inline.cancelled_callback") });
    await ctx.deleteMessage().catch(() => {});
    return true;
  }
  if (data === LOOP_UNDO) {
    agentLoopCreationManager.undoStep();
    await renderCreationMenu(ctx);
    await ctx.answerCallbackQuery();
    return true;
  }
  if (data === LOOP_OK) {
    if (state.steps.length === 0) {
      await ctx.answerCallbackQuery({ text: t("loop.selected.required"), show_alert: true });
      return true;
    }
    agentLoopCreationManager.awaitInterval();
    interactionManager.transition({
      expectedInput: "text",
      metadata: { flow: "loop-create", stage: "interval", messageId: state.messageId },
    });
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(t("loop.interval"));
    return true;
  }
  if (data.startsWith(LOOP_PAGE_PREFIX)) {
    const page = Number(data.slice(LOOP_PAGE_PREFIX.length));
    if (Number.isInteger(page) && page >= 0) {
      agentLoopCreationManager.setPage(page);
      await renderCreationMenu(ctx);
    }
    await ctx.answerCallbackQuery();
    return true;
  }
  if (data.startsWith(LOOP_SELECT_PREFIX)) {
    const sessionId = data.slice(LOOP_SELECT_PREFIX.length);
    const { data: session, error } = await opencodeClient.session.get({
      sessionID: sessionId,
      directory: state.projectWorktree,
    });
    if (error || !session) {
      await ctx.answerCallbackQuery({ text: t("sessions.fetch_error"), show_alert: true });
      return true;
    }
    agentLoopCreationManager.addStep({
      id: session.id,
      title: session.title,
      directory: session.directory || state.projectWorktree,
    });
    await renderCreationMenu(ctx);
    await ctx.answerCallbackQuery();
    return true;
  }
  return true;
}

async function showLoopsList(ctx: Context, page = 0): Promise<void> {
  const loops = listAgentLoops();
  if (loops.length === 0) {
    interactionManager.clear("loops_empty");
    await ctx.editMessageText(t("loops.empty"));
    return;
  }
  const totalPages = Math.max(1, Math.ceil(loops.length / config.bot.sessionsListLimit));
  const normalizedPage = Math.min(Math.max(0, page), totalPages - 1);
  await ctx.editMessageText(t("loops.select"), {
    reply_markup: buildLoopsListKeyboard(loops, normalizedPage, config.bot.sessionsListLimit),
  });
  interactionManager.transition({
    expectedInput: "callback",
    metadata: { flow: "loops", stage: "list", messageId: getMessageId(ctx), page: normalizedPage },
  });
}

export async function handleLoopsCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith(LOOPS_CALLBACK_PREFIX)) return false;
  if (!hasActiveFlow(ctx, "loops")) {
    await ctx.answerCallbackQuery({ text: t("inline.inactive_callback"), show_alert: true });
    return true;
  }
  const interaction = interactionManager.getSnapshot();
  const listPage =
    interaction?.kind === "custom" && typeof interaction.metadata.page === "number"
      ? interaction.metadata.page
      : 0;
  if (data === LOOPS_CLOSE) {
    interactionManager.clear("loops_closed");
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => {});
    return true;
  }
  if (data === LOOPS_BACK) {
    await showLoopsList(ctx, listPage);
    await ctx.answerCallbackQuery();
    return true;
  }
  if (data.startsWith(LOOPS_PAGE_PREFIX)) {
    const page = Number(data.slice(LOOPS_PAGE_PREFIX.length));
    if (Number.isInteger(page) && page >= 0) await showLoopsList(ctx, page);
    await ctx.answerCallbackQuery();
    return true;
  }

  const prefixes = [LOOPS_OPEN_PREFIX, LOOPS_RUN_PREFIX, LOOPS_STOP_PREFIX, LOOPS_DELETE_PREFIX];
  const prefix = prefixes.find((candidate) => data.startsWith(candidate));
  if (!prefix) return true;
  const loopId = data.slice(prefix.length);
  if (prefix === LOOPS_DELETE_PREFIX) {
    await agentLoopRuntime.delete(loopId);
    await showLoopsList(ctx, listPage);
    await ctx.answerCallbackQuery({ text: t("loops.deleted") });
    return true;
  }
  if (prefix === LOOPS_RUN_PREFIX) await agentLoopRuntime.runNow(loopId);
  if (prefix === LOOPS_STOP_PREFIX) await agentLoopRuntime.stop(loopId);
  const loop = getAgentLoop(loopId);
  if (!loop) {
    await showLoopsList(ctx, listPage);
    await ctx.answerCallbackQuery({ text: t("inline.inactive_callback") });
    return true;
  }
  await ctx.editMessageText(buildLoopDetailsText(loop), {
    reply_markup: buildLoopDetailsKeyboard(loop),
  });
  interactionManager.transition({
    expectedInput: "callback",
    metadata: {
      flow: "loops",
      stage: "detail",
      messageId: getMessageId(ctx),
      loopId,
      page: listPage,
    },
  });
  await ctx.answerCallbackQuery();
  return true;
}
