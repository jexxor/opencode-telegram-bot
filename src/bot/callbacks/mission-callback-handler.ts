import type { Bot, Context } from "grammy";
import { config } from "../../config.js";
import {
  clearAllInteractionState,
  interactionManager,
} from "../../app/managers/interaction-manager.js";
import { missionCreationManager } from "../../app/managers/mission-creation-manager.js";
import { listMissionAgents, type MissionAgent } from "../../app/services/mission-agent-service.js";
import { getBrowserRoots, isWithinAllowedRoot } from "../../app/services/file-browser-service.js";
import { getProjectsIncludingWorktrees } from "../../app/services/project-service.js";
import { missionRuntime } from "../../app/services/mission-runtime-service.js";
import { syncSessionDirectoryCache } from "../../app/services/session-cache-service.js";
import { setCurrentSession } from "../../app/services/session-service.js";
import { attachToSession } from "../../app/services/attach-service.js";
import { switchToProject } from "../../app/services/project-switch-service.js";
import {
  getMission,
  getMissionParents,
  listMissions,
  updateMission,
} from "../../app/stores/mission-store.js";
import { opencodeClient } from "../../opencode/client.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";
import { fetchCurrentAgent } from "../../app/services/agent-selection-service.js";
import { getCurrentProject } from "../../app/stores/settings-store.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";
import { createProjectSwitchPresentation } from "../services/project-switch-presentation.js";
import { sendSessionPreview } from "./session-callback-handler.js";
import {
  clearOpenPathIndex,
  decodeOpenPathFromCallback,
  decodeOpenPathWithPageCallback,
} from "../menus/file-browser-menu.js";
import {
  addMission,
  createMissionFromState,
  loadMissionRootPage,
} from "../commands/mission-command.js";
import {
  buildMissionDeleteKeyboard,
  buildMissionDetailsKeyboard,
  buildMissionDetailsText,
  buildMissionDirectoryRootsKeyboard,
  buildMissionProjectKeyboard,
  buildMissionRootKeyboard,
  buildMissionSubMissionKeyboard,
  buildMissionsListKeyboard,
  formatSelectedRoots,
  formatSelectedSubMissions,
  MISSION_CANCEL,
  MISSION_CREATE_PREFIX,
  MISSION_DIRECTORY_NAV_PREFIX,
  MISSION_DIRECTORY_PAGE_PREFIX,
  MISSION_DIRECTORY_ROOTS,
  MISSION_DIRECTORY_SELECT_PREFIX,
  MISSION_PROJECT_PAGE_PREFIX,
  MISSION_PROJECT_SELECT_PREFIX,
  MISSION_ROOT_OK,
  MISSION_ROOT_PAGE_PREFIX,
  MISSION_ROOT_SELECT_PREFIX,
  MISSION_ROOT_PROJECTS,
  MISSION_SUB_OK,
  MISSION_SUB_PAGE_PREFIX,
  MISSION_SUB_REMOVE_PREFIX,
  MISSION_SUB_SAVE,
  MISSION_SUB_SELECT_PREFIX,
  MISSION_UNDO,
  renderMissionDirectoryView,
  MISSIONS_BACK,
  MISSIONS_AGENT_PREFIX,
  MISSIONS_CLOSE,
  MISSIONS_DELETE_CONFIRM_PREFIX,
  MISSIONS_DELETE_PREFIX,
  MISSIONS_DESCRIPTION_PREFIX,
  MISSIONS_CREATE_ROOT_PREFIX,
  MISSIONS_EDIT_ROOT_PREFIX,
  MISSIONS_EDIT_SUB_PREFIX,
  MISSIONS_OPEN_PREFIX,
  MISSIONS_PAGE_PREFIX,
  MISSIONS_PAUSE_PREFIX,
  MISSIONS_PREFIX,
  MISSIONS_RENAME_PREFIX,
  MISSIONS_REFRESH_PREFIX,
  MISSIONS_RESUME_PREFIX,
  MISSIONS_RUN_PREFIX,
  MISSIONS_STOP_PREFIX,
} from "../menus/mission-menu.js";

interface MissionCallbackDeps {
  bot: Bot<Context>;
  ensureEventSubscription: (directory: string) => Promise<void>;
}

const MISSION_PANEL_REFRESH_INTERVAL_MS = 3_000;
let missionPanelRefreshTimer: ReturnType<typeof setInterval> | null = null;
let missionPanelRefreshGeneration = 0;

function stopMissionPanelRefresh(): void {
  missionPanelRefreshGeneration += 1;
  if (missionPanelRefreshTimer) clearInterval(missionPanelRefreshTimer);
  missionPanelRefreshTimer = null;
}

function getMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  return message && "message_id" in message ? message.message_id : null;
}

function hasActiveFlow(ctx: Context, flow: string): boolean {
  const interaction = interactionManager.getSnapshot();
  return (
    interaction?.kind === "custom" &&
    interaction.metadata.flow === flow &&
    interaction.metadata.messageId === getMessageId(ctx)
  );
}

function isMessageNotModifiedError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("message is not modified");
}

async function editMissionMessage(view: string, operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (!isMessageNotModifiedError(error)) throw error;
    logger.debug(`[Mission] Message already current: view=${view}`);
  }
}

async function renderMissionDirectory(ctx: Context, directory: string, page = 0): Promise<void> {
  const view = await renderMissionDirectoryView(directory, page);
  if ("error" in view) {
    await editMissionMessage("create-root-directory-error", () =>
      ctx.editMessageText(t("open.scan_error", { error: view.error })),
    );
    return;
  }
  await editMissionMessage("create-root-directory", () =>
    ctx.editMessageText(view.text, { reply_markup: view.keyboard }),
  );
}

async function renderMissionDirectoryRoots(ctx: Context): Promise<void> {
  await editMissionMessage("create-root-directories", () =>
    ctx.editMessageText(t("mission.create_sessions.select_directory"), {
      reply_markup: buildMissionDirectoryRootsKeyboard(),
    }),
  );
}

async function renderSubMissions(ctx: Context): Promise<void> {
  const state = missionCreationManager.getState();
  if (!state) return;
  const editMode = state.stage === "edit_sub_missions";
  const missions = listMissions().filter((mission) => mission.id !== state.missionId);
  await editMissionMessage("sub-missions", () =>
    ctx.editMessageText(
      `${t("mission.sub_missions")}\n\n${formatSelectedSubMissions(state.subMissionIds, missions)}`,
      {
        reply_markup: buildMissionSubMissionKeyboard(
          missions,
          state.page,
          config.bot.sessionsListLimit,
          state.subMissionIds,
          editMode,
        ),
      },
    ),
  );
}

async function renderProjects(ctx: Context): Promise<void> {
  const state = missionCreationManager.getState();
  if (!state) return;
  await syncSessionDirectoryCache();
  const projects = await getProjectsIncludingWorktrees();
  await editMissionMessage("root-projects", () =>
    ctx.editMessageText(
      `${t("mission.root_projects")}\n\n${formatSelectedRoots(state.rootSessions)}`,
      {
        reply_markup: buildMissionProjectKeyboard(
          projects,
          state.page,
          config.bot.projectsListLimit,
        ),
      },
    ),
  );
}

async function renderRoots(ctx: Context): Promise<void> {
  const state = missionCreationManager.getState();
  if (!state) return;
  if (!state.selectionProjectWorktree) return;
  const page = await loadMissionRootPage(state.selectionProjectWorktree, state.page);
  await editMissionMessage("root-sessions", () =>
    ctx.editMessageText(
      `${t("mission.root_sessions")}\n\n${formatSelectedRoots(state.rootSessions)}`,
      {
        reply_markup: buildMissionRootKeyboard(
          page.sessions,
          state.rootSessions,
          state.page,
          page.hasNext,
        ),
      },
    ),
  );
}

function wouldCreateCycle(missionId: string, candidateId: string): boolean {
  const missionsById = new Map(listMissions().map((mission) => [mission.id, mission]));
  const pending = [candidateId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const currentId = pending.pop()!;
    if (currentId === missionId) return true;
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    pending.push(...(missionsById.get(currentId)?.subMissionIds ?? []));
  }
  return false;
}

async function saveMissionStructure(ctx: Context, listPage: number): Promise<boolean> {
  const state = missionCreationManager.getState();
  if (!state?.missionId) return false;
  const mission = getMission(state.missionId);
  if (!mission) return false;
  if (mission.status === "running" || mission.status === "paused") {
    await ctx.answerCallbackQuery({ text: t("mission.edit_locked"), show_alert: true });
    return true;
  }
  let updated = false;
  await updateMission(state.missionId, (current) => {
    if (current.status === "running" || current.status === "paused") return current;
    updated = true;
    return {
      ...current,
      subMissionIds: [...state.subMissionIds],
      rootSessions: state.rootSessions.map((session) => ({ ...session })),
      updatedAt: new Date().toISOString(),
    };
  });
  if (!updated) {
    await ctx.answerCallbackQuery({ text: t("mission.edit_locked"), show_alert: true });
    return true;
  }
  const missionId = state.missionId;
  missionCreationManager.clear();
  await showMissionDetails(ctx, missionId, listPage);
  await ctx.answerCallbackQuery({ text: t("mission.updated") });
  return true;
}

async function saveCreatedMission(ctx: Context): Promise<boolean> {
  const mission = createMissionFromState();
  if (!mission) {
    await ctx.answerCallbackQuery({ text: t("callback.processing_error"), show_alert: true });
    return true;
  }
  await addMission(mission);
  missionCreationManager.clear();
  interactionManager.clear("mission_created");
  await ctx.answerCallbackQuery({ text: t("mission.created") });
  await editMissionMessage("created", () => ctx.editMessageText(t("mission.created")));
  return true;
}

export async function handleMissionCreateCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith(MISSION_CREATE_PREFIX)) return false;
  const state = missionCreationManager.getState();
  const expectedFlow = state?.missionId ? "missions" : "mission-create";
  if (!state || !hasActiveFlow(ctx, expectedFlow)) {
    await ctx.answerCallbackQuery({ text: t("inline.inactive_callback"), show_alert: true });
    return true;
  }
  const metadata = interactionManager.getSnapshot()?.metadata;
  const listPage = typeof metadata?.page === "number" ? metadata.page : 0;

  if (data === MISSION_CANCEL) {
    if (state.missionId) {
      const missionId = state.missionId;
      clearOpenPathIndex();
      missionCreationManager.clear();
      await showMissionDetails(ctx, missionId, listPage);
      await ctx.answerCallbackQuery({ text: t("inline.cancelled_callback") });
      return true;
    }
    missionCreationManager.clear();
    interactionManager.clear("mission_cancelled");
    await ctx.answerCallbackQuery({ text: t("inline.cancelled_callback") });
    await ctx.deleteMessage().catch(() => {});
    return true;
  }

  if (state.stage === "create_root_directory") {
    if (data === MISSION_DIRECTORY_ROOTS) {
      await renderMissionDirectoryRoots(ctx);
      await ctx.answerCallbackQuery();
      return true;
    }

    const pageInfo = decodeOpenPathWithPageCallback(data, MISSION_DIRECTORY_PAGE_PREFIX);
    if (pageInfo) {
      if (!isWithinAllowedRoot(pageInfo.path)) {
        await ctx.answerCallbackQuery({ text: t("open.access_denied"), show_alert: true });
        return true;
      }
      await renderMissionDirectory(ctx, pageInfo.path, pageInfo.page);
      await ctx.answerCallbackQuery();
      return true;
    }

    const navPath = decodeOpenPathFromCallback(MISSION_DIRECTORY_NAV_PREFIX, data);
    if (navPath !== null) {
      if (!isWithinAllowedRoot(navPath)) {
        await ctx.answerCallbackQuery({ text: t("open.access_denied"), show_alert: true });
        return true;
      }
      await renderMissionDirectory(ctx, navPath);
      await ctx.answerCallbackQuery();
      return true;
    }

    const selectedPath = decodeOpenPathFromCallback(MISSION_DIRECTORY_SELECT_PREFIX, data);
    if (selectedPath !== null) {
      if (!isWithinAllowedRoot(selectedPath)) {
        await ctx.answerCallbackQuery({ text: t("open.access_denied"), show_alert: true });
        return true;
      }
      clearOpenPathIndex();
      missionCreationManager.update((current) => {
        current.selectionProjectWorktree = selectedPath;
        current.stage = "create_root_count";
      });
      interactionManager.transition({
        expectedInput: "text",
        metadata: {
          flow: "missions",
          stage: "create_root_count",
          messageId: state.messageId,
          missionId: state.missionId,
          page: listPage,
        },
      });
      await editMissionMessage("create-root-count", () =>
        ctx.editMessageText(t("mission.create_sessions.count", { directory: selectedPath })),
      );
      await ctx.answerCallbackQuery();
      return true;
    }
  }

  if (state.stage === "sub_missions" || state.stage === "edit_sub_missions") {
    if (data.startsWith(MISSION_SUB_PAGE_PREFIX)) {
      const page = Number(data.slice(MISSION_SUB_PAGE_PREFIX.length));
      if (Number.isInteger(page) && page >= 0) {
        missionCreationManager.update((current) => {
          current.page = page;
        });
        await renderSubMissions(ctx);
      }
      await ctx.answerCallbackQuery();
      return true;
    }
    if (data.startsWith(MISSION_SUB_SELECT_PREFIX)) {
      const missionId = data.slice(MISSION_SUB_SELECT_PREFIX.length);
      const mission = getMission(missionId);
      if (
        mission &&
        missionId !== state.missionId &&
        (!state.missionId || !wouldCreateCycle(state.missionId, missionId))
      ) {
        missionCreationManager.update((current) => current.subMissionIds.push(missionId));
        await renderSubMissions(ctx);
      } else if (state.missionId && mission && wouldCreateCycle(state.missionId, missionId)) {
        await ctx.answerCallbackQuery({ text: t("mission.cycle_forbidden"), show_alert: true });
        return true;
      }
      await ctx.answerCallbackQuery();
      return true;
    }
    if (data.startsWith(MISSION_SUB_REMOVE_PREFIX) && state.stage === "edit_sub_missions") {
      const missionId = data.slice(MISSION_SUB_REMOVE_PREFIX.length);
      missionCreationManager.update((current) => {
        const index = current.subMissionIds.lastIndexOf(missionId);
        if (index >= 0) current.subMissionIds.splice(index, 1);
      });
      await renderSubMissions(ctx);
      await ctx.answerCallbackQuery();
      return true;
    }
    if (data === MISSION_UNDO) {
      missionCreationManager.update((current) => current.subMissionIds.pop());
      await renderSubMissions(ctx);
      await ctx.answerCallbackQuery();
      return true;
    }
    if (data === MISSION_SUB_OK) {
      if (state.stage === "edit_sub_missions") {
        return saveMissionStructure(ctx, listPage);
      }
      missionCreationManager.update((current) => {
        current.stage = "root_projects";
        current.page = 0;
      });
      interactionManager.transition({
        expectedInput: "callback",
        metadata: { flow: "mission-create", stage: "root_projects", messageId: state.messageId },
      });
      await renderProjects(ctx);
      await ctx.answerCallbackQuery();
      return true;
    }
    if (data === MISSION_SUB_SAVE && state.stage === "sub_missions") {
      return saveCreatedMission(ctx);
    }
  }

  if (state.stage === "root_projects" || state.stage === "edit_root_projects") {
    if (data.startsWith(MISSION_PROJECT_PAGE_PREFIX)) {
      const page = Number(data.slice(MISSION_PROJECT_PAGE_PREFIX.length));
      if (Number.isInteger(page) && page >= 0) {
        missionCreationManager.update((current) => {
          current.page = page;
        });
        await renderProjects(ctx);
      }
      await ctx.answerCallbackQuery();
      return true;
    }
    if (data.startsWith(MISSION_PROJECT_SELECT_PREFIX)) {
      const projectId = data.slice(MISSION_PROJECT_SELECT_PREFIX.length);
      const project = (await getProjectsIncludingWorktrees()).find(
        (candidate) => candidate.id === projectId,
      );
      if (!project) {
        await ctx.answerCallbackQuery({ text: t("projects.fetch_error"), show_alert: true });
        return true;
      }
      missionCreationManager.update((current) => {
        current.selectionProjectWorktree = project.worktree;
        current.stage = current.missionId ? "edit_root_sessions" : "root_sessions";
        current.page = 0;
      });
      await renderRoots(ctx);
      await ctx.answerCallbackQuery();
      return true;
    }
    if (data === MISSION_ROOT_OK) {
      if (state.stage === "edit_root_projects") return saveMissionStructure(ctx, listPage);
      return saveCreatedMission(ctx);
    }
  }

  if (state.stage === "root_sessions" || state.stage === "edit_root_sessions") {
    if (data.startsWith(MISSION_ROOT_PAGE_PREFIX)) {
      const page = Number(data.slice(MISSION_ROOT_PAGE_PREFIX.length));
      if (Number.isInteger(page) && page >= 0) {
        missionCreationManager.update((current) => {
          current.page = page;
        });
        await renderRoots(ctx);
      }
      await ctx.answerCallbackQuery();
      return true;
    }
    if (data === MISSION_ROOT_PROJECTS) {
      missionCreationManager.update((current) => {
        current.stage = current.missionId ? "edit_root_projects" : "root_projects";
        current.selectionProjectWorktree = null;
        current.page = 0;
      });
      await renderProjects(ctx);
      await ctx.answerCallbackQuery();
      return true;
    }
    if (data.startsWith(MISSION_ROOT_SELECT_PREFIX)) {
      const sessionId = data.slice(MISSION_ROOT_SELECT_PREFIX.length);
      if (!state.selectionProjectWorktree) return true;
      const { data: session, error } = await opencodeClient.session.get({
        sessionID: sessionId,
        directory: state.selectionProjectWorktree,
      });
      if (error || !session) {
        await ctx.answerCallbackQuery({ text: t("sessions.fetch_error"), show_alert: true });
        return true;
      }
      missionCreationManager.update((current) => {
        const directory = session.directory || state.selectionProjectWorktree!;
        const index = current.rootSessions.findIndex(
          (item) => item.id === session.id && item.directory === directory,
        );
        if (index >= 0) current.rootSessions.splice(index, 1);
        else {
          current.rootSessions.push({
            id: session.id,
            title: session.title,
            directory,
          });
        }
      });
      await renderRoots(ctx);
      await ctx.answerCallbackQuery();
      return true;
    }
    if (data === MISSION_ROOT_OK) {
      if (state.stage === "edit_root_sessions") return saveMissionStructure(ctx, listPage);
      return saveCreatedMission(ctx);
    }
  }

  await ctx.answerCallbackQuery();
  return true;
}

async function showMissionsList(ctx: Context, page = 0): Promise<void> {
  const missions = listMissions();
  if (missions.length === 0) {
    interactionManager.clear("missions_empty");
    await editMissionMessage("empty", () => ctx.editMessageText(t("missions.empty")));
    return;
  }
  const totalPages = Math.max(1, Math.ceil(missions.length / config.bot.sessionsListLimit));
  const normalizedPage = Math.min(Math.max(0, page), totalPages - 1);
  await editMissionMessage("list", () =>
    ctx.editMessageText(t("missions.select"), {
      reply_markup: buildMissionsListKeyboard(
        missions,
        normalizedPage,
        config.bot.sessionsListLimit,
      ),
    }),
  );
  interactionManager.transition({
    expectedInput: "callback",
    metadata: {
      flow: "missions",
      stage: "list",
      messageId: getMessageId(ctx),
      page: normalizedPage,
    },
  });
}

async function showMissionDetails(
  ctx: Context,
  missionId: string,
  listPage: number,
): Promise<boolean> {
  const missions = listMissions();
  const mission = missions.find((candidate) => candidate.id === missionId);
  if (!mission) return false;
  const agents = await listMissionAgents(missionId, missions);
  const text = buildMissionDetailsText(mission, missions, agents);
  const keyboard = buildMissionDetailsKeyboard(mission, agents);
  await editMissionMessage("details", () =>
    ctx.editMessageText(text, {
      reply_markup: keyboard,
    }),
  );
  interactionManager.transition({
    expectedInput: "callback",
    metadata: {
      flow: "missions",
      stage: "detail",
      messageId: getMessageId(ctx),
      missionId,
      page: listPage,
    },
  });
  startMissionPanelRefresh(ctx, missionId, text, JSON.stringify(keyboard.inline_keyboard));
  return true;
}

function startMissionPanelRefresh(
  ctx: Context,
  missionId: string,
  initialText: string,
  initialKeyboard: string,
): void {
  stopMissionPanelRefresh();
  const generation = missionPanelRefreshGeneration;
  const chatId = ctx.chat?.id;
  const messageId = getMessageId(ctx);
  if (!chatId || !messageId) return;

  let previousText = initialText;
  let previousKeyboard = initialKeyboard;
  let refreshing = false;
  missionPanelRefreshTimer = setInterval(() => {
    if (refreshing || generation !== missionPanelRefreshGeneration) return;
    const metadata = interactionManager.getSnapshot()?.metadata;
    if (
      metadata?.flow !== "missions" ||
      metadata.stage !== "detail" ||
      metadata.missionId !== missionId ||
      metadata.messageId !== messageId
    ) {
      if (generation === missionPanelRefreshGeneration) stopMissionPanelRefresh();
      return;
    }

    refreshing = true;
    void (async () => {
      const missions = listMissions();
      const mission = missions.find((candidate) => candidate.id === missionId);
      if (!mission) {
        if (generation === missionPanelRefreshGeneration) stopMissionPanelRefresh();
        return;
      }
      const agents = await listMissionAgents(missionId, missions);
      const text = buildMissionDetailsText(mission, missions, agents);
      const keyboard = buildMissionDetailsKeyboard(mission, agents);
      const serializedKeyboard = JSON.stringify(keyboard.inline_keyboard);
      if (text === previousText && serializedKeyboard === previousKeyboard) return;
      if (generation !== missionPanelRefreshGeneration) return;
      await ctx.api.editMessageText(chatId, messageId, text, { reply_markup: keyboard });
      previousText = text;
      previousKeyboard = serializedKeyboard;
    })()
      .catch((error) => {
        if (generation === missionPanelRefreshGeneration && !isMessageNotModifiedError(error)) {
          stopMissionPanelRefresh();
          logger.debug(`[Mission] Stopped panel refresh: mission=${missionId}`, error);
        }
      })
      .finally(() => {
        refreshing = false;
      });
  }, MISSION_PANEL_REFRESH_INTERVAL_MS);
  missionPanelRefreshTimer.unref?.();
}

async function selectMissionAgent(
  ctx: Context,
  deps: MissionCallbackDeps,
  agent: MissionAgent,
): Promise<void> {
  if (!ctx.chat) throw new Error("Mission agent selection requires a chat");
  const currentProject = getCurrentProject();
  if (currentProject?.worktree !== agent.directory) {
    const projects = await getProjectsIncludingWorktrees();
    const project = projects.find((candidate) => candidate.worktree === agent.directory) ?? {
      id: `mission:${agent.directory}`,
      name: agent.directory,
      worktree: agent.directory,
    };
    await switchToProject(ctx, project, "mission_agent_switched", {
      ensureEventSubscription: deps.ensureEventSubscription,
      presentation: createProjectSwitchPresentation(),
    });
  } else {
    clearAllInteractionState("mission_agent_switched");
  }

  const session = {
    id: agent.id,
    title: agent.title,
    directory: agent.directory,
  };
  setCurrentSession(session);
  await attachToSession({
    bot: deps.bot,
    chatId: ctx.chat.id,
    session,
    ensureEventSubscription: deps.ensureEventSubscription,
  });
  keyboardManager.updateAgent(await fetchCurrentAgent({ syncFromSession: true }));
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => {});
  await ctx.reply(t("sessions.selected", { title: agent.title }), {
    reply_markup: keyboardManager.getKeyboard(),
  });
  safeBackgroundTask({
    taskName: "missions.sendAgentPreview",
    task: () =>
      sendSessionPreview(ctx.api, ctx.chat!.id, null, agent.title, agent.id, agent.directory),
  });
}

export async function handleMissionsCallback(
  ctx: Context,
  deps?: MissionCallbackDeps,
): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith(MISSIONS_PREFIX)) return false;
  if (!hasActiveFlow(ctx, "missions")) {
    await ctx.answerCallbackQuery({ text: t("inline.inactive_callback"), show_alert: true });
    return true;
  }
  stopMissionPanelRefresh();
  const metadata = interactionManager.getSnapshot()?.metadata;
  const listPage = typeof metadata?.page === "number" ? metadata.page : 0;

  if (data.startsWith(MISSIONS_AGENT_PREFIX)) {
    const missionId = typeof metadata?.missionId === "string" ? metadata.missionId : null;
    const agentId = data.slice(MISSIONS_AGENT_PREFIX.length);
    const agent = missionId
      ? (await listMissionAgents(missionId, listMissions())).find(
          (candidate) => candidate.id === agentId,
        )
      : null;
    if (!agent || !deps) {
      await ctx.answerCallbackQuery({ text: t("missions.not_found"), show_alert: true });
      return true;
    }
    await selectMissionAgent(ctx, deps, agent);
    return true;
  }

  if (data === MISSIONS_CLOSE) {
    interactionManager.clear("missions_closed");
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => {});
    return true;
  }
  if (data === MISSIONS_BACK) {
    await showMissionsList(ctx, listPage);
    await ctx.answerCallbackQuery();
    return true;
  }
  if (data.startsWith(MISSIONS_PAGE_PREFIX)) {
    const page = Number(data.slice(MISSIONS_PAGE_PREFIX.length));
    if (Number.isInteger(page) && page >= 0) await showMissionsList(ctx, page);
    await ctx.answerCallbackQuery();
    return true;
  }

  const actions = [
    MISSIONS_DELETE_CONFIRM_PREFIX,
    MISSIONS_CREATE_ROOT_PREFIX,
    MISSIONS_EDIT_ROOT_PREFIX,
    MISSIONS_EDIT_SUB_PREFIX,
    MISSIONS_DESCRIPTION_PREFIX,
    MISSIONS_RENAME_PREFIX,
    MISSIONS_REFRESH_PREFIX,
    MISSIONS_RESUME_PREFIX,
    MISSIONS_PAUSE_PREFIX,
    MISSIONS_DELETE_PREFIX,
    MISSIONS_STOP_PREFIX,
    MISSIONS_RUN_PREFIX,
    MISSIONS_OPEN_PREFIX,
  ];
  const action = actions.find((prefix) => data.startsWith(prefix));
  if (!action) return true;
  const missionId = data.slice(action.length);
  const mission = getMission(missionId);
  if (!mission) {
    await ctx.answerCallbackQuery({ text: t("missions.not_found"), show_alert: true });
    return true;
  }

  if (action === MISSIONS_RUN_PREFIX) {
    missionCreationManager.startAction(mission, "run_timeout", getMessageId(ctx));
    interactionManager.transition({
      expectedInput: "text",
      metadata: { flow: "missions", stage: "run_timeout", messageId: getMessageId(ctx) },
    });
    await editMissionMessage("run-timeout", () => ctx.editMessageText(t("mission.run_timeout")));
  } else if (action === MISSIONS_PAUSE_PREFIX) {
    await missionRuntime.pause(missionId);
    await showMissionDetails(ctx, missionId, listPage);
  } else if (action === MISSIONS_RESUME_PREFIX) {
    await missionRuntime.resume(missionId);
    await showMissionDetails(ctx, missionId, listPage);
  } else if (action === MISSIONS_STOP_PREFIX) {
    await missionRuntime.stop(missionId);
    await showMissionDetails(ctx, missionId, listPage);
  } else if (action === MISSIONS_CREATE_ROOT_PREFIX) {
    if (mission.status === "running" || mission.status === "paused") {
      await ctx.answerCallbackQuery({ text: t("mission.edit_locked"), show_alert: true });
      return true;
    }
    clearOpenPathIndex();
    missionCreationManager.startAction(mission, "create_root_directory", getMessageId(ctx));
    interactionManager.transition({
      expectedInput: "callback",
      metadata: {
        flow: "missions",
        stage: "create_root_directory",
        messageId: getMessageId(ctx),
        missionId,
        page: listPage,
      },
    });
    const roots = getBrowserRoots();
    if (roots.length === 1) await renderMissionDirectory(ctx, roots[0]);
    else await renderMissionDirectoryRoots(ctx);
  } else if (action === MISSIONS_EDIT_SUB_PREFIX || action === MISSIONS_EDIT_ROOT_PREFIX) {
    if (mission.status === "running" || mission.status === "paused") {
      await ctx.answerCallbackQuery({ text: t("mission.edit_locked"), show_alert: true });
      return true;
    }
    const stage = action === MISSIONS_EDIT_SUB_PREFIX ? "edit_sub_missions" : "edit_root_projects";
    missionCreationManager.startAction(mission, stage, getMessageId(ctx));
    interactionManager.transition({
      expectedInput: "callback",
      metadata: {
        flow: "missions",
        stage,
        messageId: getMessageId(ctx),
        missionId,
        page: listPage,
      },
    });
    if (stage === "edit_sub_missions") await renderSubMissions(ctx);
    else await renderProjects(ctx);
  } else if (action === MISSIONS_RENAME_PREFIX || action === MISSIONS_DESCRIPTION_PREFIX) {
    const stage = action === MISSIONS_RENAME_PREFIX ? "edit_name" : "edit_description";
    missionCreationManager.startAction(mission, stage, getMessageId(ctx));
    interactionManager.transition({
      expectedInput: "text",
      metadata: { flow: "missions", stage, messageId: getMessageId(ctx) },
    });
    await editMissionMessage("edit-text", () =>
      ctx.editMessageText(
        action === MISSIONS_RENAME_PREFIX ? t("mission.edit_name") : t("mission.edit_description"),
      ),
    );
  } else if (action === MISSIONS_DELETE_PREFIX) {
    const parents = getMissionParents(missionId)
      .map((parent) => parent.name)
      .join(", ");
    await editMissionMessage("delete", () =>
      ctx.editMessageText(
        t("missions.delete_warning", { parents: parents || t("missions.delete_no_parents") }),
        { reply_markup: buildMissionDeleteKeyboard(missionId) },
      ),
    );
    interactionManager.transition({
      expectedInput: "callback",
      metadata: {
        flow: "missions",
        stage: "delete",
        messageId: getMessageId(ctx),
        missionId,
        page: listPage,
      },
    });
  } else if (action === MISSIONS_DELETE_CONFIRM_PREFIX) {
    await missionRuntime.delete(missionId);
    await showMissionsList(ctx, listPage);
  } else {
    await showMissionDetails(ctx, missionId, listPage);
  }

  await ctx.answerCallbackQuery();
  return true;
}
