import { randomUUID } from "node:crypto";
import type { CommandContext, Context } from "grammy";
import { config } from "../../config.js";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import { missionCreationManager } from "../../app/managers/mission-creation-manager.js";
import { missionRuntime } from "../../app/services/mission-runtime-service.js";
import { upsertSessionDirectory } from "../../app/services/session-cache-service.js";
import {
  addMission,
  getMission,
  listMissions,
  updateMission,
} from "../../app/stores/mission-store.js";
import type { Mission } from "../../app/types/mission.js";
import type { SessionInfo } from "../../app/types/session.js";
import { opencodeClient } from "../../opencode/client.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import {
  buildMissionSubMissionKeyboard,
  buildMissionsListKeyboard,
  formatSelectedSubMissions,
} from "../menus/mission-menu.js";

const SESSION_FETCH_EXTRA_COUNT = 1;

export async function loadMissionRootPage(directory: string, page: number) {
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

export async function missionCommand(ctx: CommandContext<Context>): Promise<void> {
  missionCreationManager.start();
  const message = await ctx.reply(t("mission.name"));
  missionCreationManager.update((state) => {
    state.messageId = message.message_id;
  });
  interactionManager.start({
    kind: "custom",
    expectedInput: "text",
    metadata: { flow: "mission-create", stage: "name", messageId: message.message_id },
  });
}

export async function missionsCommand(ctx: CommandContext<Context>): Promise<void> {
  const missions = listMissions();
  if (missions.length === 0) {
    await ctx.reply(t("missions.empty"));
    return;
  }
  const message = await ctx.reply(t("missions.select"), {
    reply_markup: buildMissionsListKeyboard(missions, 0, config.bot.sessionsListLimit),
  });
  interactionManager.start({
    kind: "custom",
    expectedInput: "callback",
    metadata: {
      flow: "missions",
      stage: "list",
      messageId: message.message_id,
      page: 0,
    },
  });
}

function transitionToText(stage: string, messageId: number | null): void {
  interactionManager.transition({
    expectedInput: "text",
    metadata: { flow: "missions", stage, messageId },
  });
}

export async function handleMissionTextInput(ctx: Context): Promise<boolean> {
  const state = missionCreationManager.getState();
  const text = ctx.message?.text?.trim();
  if (!state || !text || text.startsWith("/")) return false;
  const interaction = interactionManager.getSnapshot();
  if (
    interaction?.kind !== "custom" ||
    (interaction.metadata.flow !== "mission-create" && interaction.metadata.flow !== "missions")
  ) {
    missionCreationManager.clear();
    return false;
  }

  if (state.stage === "name") {
    if (text.length > 100) {
      await ctx.reply(t("mission.name.invalid"));
      return true;
    }
    missionCreationManager.update((current) => {
      current.name = text;
      current.stage = "description";
    });
    interactionManager.transition({
      expectedInput: "text",
      metadata: { flow: "mission-create", stage: "description", messageId: state.messageId },
    });
    await ctx.reply(t("mission.description"));
    return true;
  }

  if (state.stage === "description") {
    if (text.length > 2000) {
      await ctx.reply(t("mission.description.invalid"));
      return true;
    }
    const description = text === "-" ? "" : text;
    const available = listMissions();
    missionCreationManager.update((current) => {
      current.description = description;
      current.stage = "sub_missions";
    });
    const message = await ctx.reply(
      `${t("mission.sub_missions")}\n\n${formatSelectedSubMissions([], available)}`,
      {
        reply_markup: buildMissionSubMissionKeyboard(
          available,
          0,
          config.bot.sessionsListLimit,
          [],
        ),
      },
    );
    missionCreationManager.update((current) => {
      current.messageId = message.message_id;
    });
    interactionManager.transition({
      expectedInput: "callback",
      metadata: { flow: "mission-create", stage: "sub_missions", messageId: message.message_id },
    });
    return true;
  }

  if (state.stage === "create_root_count" && state.missionId && state.selectionProjectWorktree) {
    const requestedCount = Number(text);
    if (!Number.isSafeInteger(requestedCount) || requestedCount < 0) {
      await ctx.reply(t("mission.create_sessions.count_invalid"));
      return true;
    }

    const mission = getMission(state.missionId);
    if (!mission) {
      missionCreationManager.clear();
      interactionManager.clear("mission_missing");
      await ctx.reply(t("missions.not_found"));
      return true;
    }
    if (mission.status === "running" || mission.status === "paused") {
      missionCreationManager.clear();
      interactionManager.clear("mission_edit_locked");
      await ctx.reply(t("mission.edit_locked"));
      return true;
    }

    const count = requestedCount === 0 ? 1 : requestedCount;
    const directory = state.selectionProjectWorktree;
    const createdSessions: SessionInfo[] = [];
    let creationError: unknown = null;
    for (let index = 0; index < count; index += 1) {
      const title = index === 0 ? mission.name : `${mission.name} ${index + 1}`;
      try {
        const { data: session, error } = await opencodeClient.session.create({
          directory,
          title,
        });
        if (error || !session) throw error || new Error("Session creation returned no data");
        createdSessions.push({
          id: session.id,
          title: session.title || title,
          directory: session.directory || directory,
        });
      } catch (error) {
        creationError = error;
        break;
      }
    }

    if (createdSessions.length > 0) {
      await updateMission(mission.id, (current) => ({
        ...current,
        rootSessions: [...current.rootSessions, ...createdSessions],
        updatedAt: new Date().toISOString(),
      }));
      await upsertSessionDirectory(directory, Date.now());
    }

    missionCreationManager.clear();
    interactionManager.clear("mission_root_sessions_created");
    if (creationError) {
      logger.error(
        `[Mission] Failed to create root session swarm: mission=${mission.id}, directory=${directory}, created=${createdSessions.length}, requested=${count}`,
        creationError,
      );
      await ctx.reply(
        createdSessions.length > 0
          ? t("mission.create_sessions.partial", {
              created: createdSessions.length,
              requested: count,
            })
          : t("mission.create_sessions.error"),
      );
      return true;
    }

    await ctx.reply(
      t("mission.create_sessions.success", {
        count: createdSessions.length,
        directory,
      }),
    );
    return true;
  }

  if (state.stage === "run_timeout") {
    const timeout = Number(text);
    if (!Number.isSafeInteger(timeout) || timeout < 0) {
      await ctx.reply(t("mission.run_timeout.invalid"));
      return true;
    }
    missionCreationManager.update((current) => {
      current.timeoutMinutes = timeout === 0 ? null : timeout;
      current.stage = "run_count";
    });
    transitionToText("run_count", state.messageId);
    await ctx.reply(t("mission.run_count"));
    return true;
  }

  if (state.stage === "run_count" && state.missionId) {
    const count = Number(text);
    if (!Number.isSafeInteger(count) || count < 0) {
      await ctx.reply(t("mission.run_count.invalid"));
      return true;
    }
    missionCreationManager.update((current) => {
      current.runCount = count === 0 ? 1 : count;
      current.stage = "run_prompt";
    });
    transitionToText("run_prompt", state.messageId);
    await ctx.reply(t("mission.run_prompt"));
    return true;
  }

  if (state.stage === "run_prompt" && state.missionId && state.runCount) {
    const mission = await missionRuntime.run(state.missionId, {
      timeoutMinutes: state.timeoutMinutes,
      runs: state.runCount,
      prompt: text,
    });
    missionCreationManager.clear();
    interactionManager.clear("mission_started");
    await ctx.reply(mission ? t("mission.started") : t("missions.not_found"));
    return true;
  }

  if ((state.stage === "edit_name" || state.stage === "edit_description") && state.missionId) {
    if (state.stage === "edit_name" && text.length > 100) {
      await ctx.reply(t("mission.name.invalid"));
      return true;
    }
    if (state.stage === "edit_description" && text.length > 2000) {
      await ctx.reply(t("mission.description.invalid"));
      return true;
    }
    await updateMission(state.missionId, (mission) => ({
      ...mission,
      ...(state.stage === "edit_name" ? { name: text } : { description: text === "-" ? "" : text }),
      updatedAt: new Date().toISOString(),
    }));
    missionCreationManager.clear();
    interactionManager.clear("mission_updated");
    await ctx.reply(t("mission.updated"));
    return true;
  }

  return false;
}

export function createMissionFromState(): Mission | null {
  const state = missionCreationManager.getState();
  if (!state || !state.name) {
    return null;
  }
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: state.name,
    description: state.description,
    subMissionIds: state.subMissionIds,
    rootSessions: state.rootSessions,
    status: "idle",
    requestedRuns: 1,
    completedRuns: 0,
    totalSessionRuns: 0,
    failedSessionRuns: 0,
    timeoutMinutes: null,
    runStartedAt: null,
    runFinishedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

export { addMission };
