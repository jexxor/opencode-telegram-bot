import { InlineKeyboard } from "grammy";
import path from "node:path";
import {
  buildEntryLabel,
  buildTreeHeader,
  getBrowserRoots,
  isAllowedRoot,
  MAX_ENTRIES_PER_PAGE,
  pathToDisplayPath,
  scanDirectory,
} from "../../app/services/file-browser-service.js";
import type { Mission } from "../../app/types/mission.js";
import type { MissionAgent } from "../../app/services/mission-agent-service.js";
import { formatSessionActivityStatus } from "../../app/managers/session-status-manager.js";
import type { ProjectInfo } from "../../app/types/project.js";
import type { SessionInfo } from "../../app/types/session.js";
import { t } from "../../i18n/index.js";
import { encodeOpenPathForCallback, encodeOpenPathWithPageCallback } from "./file-browser-menu.js";
import { buildProjectPathButtonLabel } from "./project-selection-menu.js";

export const MISSION_CREATE_PREFIX = "mission-create:";
export const MISSION_SUB_SELECT_PREFIX = `${MISSION_CREATE_PREFIX}sub:`;
export const MISSION_SUB_REMOVE_PREFIX = `${MISSION_CREATE_PREFIX}sub-remove:`;
export const MISSION_SUB_PAGE_PREFIX = `${MISSION_CREATE_PREFIX}sub-page:`;
export const MISSION_PROJECT_SELECT_PREFIX = `${MISSION_CREATE_PREFIX}project:`;
export const MISSION_PROJECT_PAGE_PREFIX = `${MISSION_CREATE_PREFIX}project-page:`;
export const MISSION_ROOT_SELECT_PREFIX = `${MISSION_CREATE_PREFIX}root:`;
export const MISSION_ROOT_PAGE_PREFIX = `${MISSION_CREATE_PREFIX}page:`;
export const MISSION_ROOT_PROJECTS = `${MISSION_CREATE_PREFIX}projects`;
export const MISSION_UNDO = `${MISSION_CREATE_PREFIX}undo`;
export const MISSION_SUB_OK = `${MISSION_CREATE_PREFIX}sub-ok`;
export const MISSION_SUB_SAVE = `${MISSION_CREATE_PREFIX}sub-save`;
export const MISSION_ROOT_OK = `${MISSION_CREATE_PREFIX}root-ok`;
export const MISSION_DIRECTORY_NAV_PREFIX = `${MISSION_CREATE_PREFIX}dir-nav:`;
export const MISSION_DIRECTORY_PAGE_PREFIX = `${MISSION_CREATE_PREFIX}dir-page:`;
export const MISSION_DIRECTORY_SELECT_PREFIX = `${MISSION_CREATE_PREFIX}dir-select:`;
export const MISSION_DIRECTORY_ROOTS = `${MISSION_CREATE_PREFIX}dir-roots`;
export const MISSION_CANCEL = `${MISSION_CREATE_PREFIX}cancel`;

export const MISSIONS_PREFIX = "missions:";
export const MISSIONS_OPEN_PREFIX = `${MISSIONS_PREFIX}open:`;
export const MISSIONS_RUN_PREFIX = `${MISSIONS_PREFIX}run:`;
export const MISSIONS_PAUSE_PREFIX = `${MISSIONS_PREFIX}pause:`;
export const MISSIONS_RESUME_PREFIX = `${MISSIONS_PREFIX}resume:`;
export const MISSIONS_STOP_PREFIX = `${MISSIONS_PREFIX}stop:`;
export const MISSIONS_RENAME_PREFIX = `${MISSIONS_PREFIX}rename:`;
export const MISSIONS_DESCRIPTION_PREFIX = `${MISSIONS_PREFIX}description:`;
export const MISSIONS_EDIT_SUB_PREFIX = `${MISSIONS_PREFIX}edit-sub:`;
export const MISSIONS_EDIT_ROOT_PREFIX = `${MISSIONS_PREFIX}edit-root:`;
export const MISSIONS_CREATE_ROOT_PREFIX = `${MISSIONS_PREFIX}create-root:`;
export const MISSIONS_DELETE_PREFIX = `${MISSIONS_PREFIX}delete:`;
export const MISSIONS_DELETE_CONFIRM_PREFIX = `${MISSIONS_PREFIX}delete-confirm:`;
export const MISSIONS_REFRESH_PREFIX = `${MISSIONS_PREFIX}refresh:`;
export const MISSIONS_AGENT_PREFIX = `${MISSIONS_PREFIX}agent:`;
export const MISSIONS_PAGE_PREFIX = `${MISSIONS_PREFIX}page:`;
export const MISSIONS_BACK = `${MISSIONS_PREFIX}back`;
export const MISSIONS_CLOSE = `${MISSIONS_PREFIX}close`;

function truncate(value: string, length = 48): string {
  return value.length <= length ? value : `${value.slice(0, length - 3)}...`;
}

function buildMissionProjectLabel(project: ProjectInfo): string {
  return buildProjectPathButtonLabel(project.worktree);
}

export function formatSelectedSubMissions(ids: string[], missions: Mission[]): string {
  if (ids.length === 0) return t("mission.selected_sub.empty");
  const startIndex = Math.max(0, ids.length - 30);
  const selected = ids
    .slice(startIndex)
    .map(
      (id, index) =>
        `${startIndex + index + 1}. ${missions.find((mission) => mission.id === id)?.name ?? id}`,
    )
    .join("\n");
  return startIndex > 0 ? `...\n${selected}` : selected;
}

export function formatSelectedRoots(sessions: SessionInfo[]): string {
  if (sessions.length === 0) return t("mission.selected_roots.empty");
  const startIndex = Math.max(0, sessions.length - 30);
  const selected = sessions
    .slice(startIndex)
    .map((session, index) => `${startIndex + index + 1}. ${session.title} [${session.directory}]`)
    .join("\n");
  return startIndex > 0 ? `...\n${selected}` : selected;
}

export function buildMissionSubMissionKeyboard(
  missions: Mission[],
  page: number,
  pageSize: number,
  selectedIds: string[],
  editMode = false,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const totalPages = Math.max(1, Math.ceil(missions.length / pageSize));
  const normalizedPage = Math.min(Math.max(0, page), totalPages - 1);
  const startIndex = normalizedPage * pageSize;
  missions.slice(startIndex, startIndex + pageSize).forEach((mission) => {
    if (editMode) {
      const selectedCount = selectedIds.filter((id) => id === mission.id).length;
      if (selectedCount > 0) {
        keyboard.text(`- (${selectedCount})`, `${MISSION_SUB_REMOVE_PREFIX}${mission.id}`);
      }
      keyboard
        .text(`+ ${truncate(mission.name, 39)}`, `${MISSION_SUB_SELECT_PREFIX}${mission.id}`)
        .row();
      return;
    }
    keyboard.text(truncate(mission.name), `${MISSION_SUB_SELECT_PREFIX}${mission.id}`).row();
  });
  if (normalizedPage > 0) {
    keyboard.text(
      t("sessions.button.prev_page"),
      `${MISSION_SUB_PAGE_PREFIX}${normalizedPage - 1}`,
    );
  }
  if (normalizedPage < totalPages - 1) {
    keyboard.text(
      t("sessions.button.next_page"),
      `${MISSION_SUB_PAGE_PREFIX}${normalizedPage + 1}`,
    );
  }
  if (totalPages > 1) keyboard.row();
  if (!editMode && selectedIds.length > 0) keyboard.text(t("mission.button.undo"), MISSION_UNDO);
  keyboard
    .text(editMode ? t("mission.button.save") : t("mission.button.choose_roots"), MISSION_SUB_OK)
    .row();
  if (!editMode) {
    keyboard.text(t("mission.button.save_now"), MISSION_SUB_SAVE).row();
  }
  keyboard.text(t("inline.button.cancel"), MISSION_CANCEL);
  return keyboard;
}

export function buildMissionProjectKeyboard(
  projects: ProjectInfo[],
  page: number,
  pageSize: number,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const totalPages = Math.max(1, Math.ceil(projects.length / pageSize));
  const normalizedPage = Math.min(Math.max(0, page), totalPages - 1);
  const startIndex = normalizedPage * pageSize;
  projects.slice(startIndex, startIndex + pageSize).forEach((project) => {
    keyboard
      .text(buildMissionProjectLabel(project), `${MISSION_PROJECT_SELECT_PREFIX}${project.id}`)
      .row();
  });
  if (normalizedPage > 0) {
    keyboard.text(
      t("sessions.button.prev_page"),
      `${MISSION_PROJECT_PAGE_PREFIX}${normalizedPage - 1}`,
    );
  }
  if (normalizedPage < totalPages - 1) {
    keyboard.text(
      t("sessions.button.next_page"),
      `${MISSION_PROJECT_PAGE_PREFIX}${normalizedPage + 1}`,
    );
  }
  if (totalPages > 1) keyboard.row();
  keyboard.text(t("mission.button.save_without_roots"), MISSION_ROOT_OK).row();
  keyboard.text(t("inline.button.cancel"), MISSION_CANCEL);
  return keyboard;
}

export function buildMissionRootKeyboard(
  sessions: SessionInfo[],
  selected: SessionInfo[],
  page: number,
  hasNext: boolean,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const selectedKeys = new Set(selected.map((session) => `${session.directory}\0${session.id}`));
  sessions.forEach((session) => {
    const marker = selectedKeys.has(`${session.directory}\0${session.id}`) ? "[x]" : "[ ]";
    keyboard
      .text(
        `${marker} ${truncate(session.title, 42)}`,
        `${MISSION_ROOT_SELECT_PREFIX}${session.id}`,
      )
      .row();
  });
  if (page > 0)
    keyboard.text(t("sessions.button.prev_page"), `${MISSION_ROOT_PAGE_PREFIX}${page - 1}`);
  if (hasNext)
    keyboard.text(t("sessions.button.next_page"), `${MISSION_ROOT_PAGE_PREFIX}${page + 1}`);
  if (page > 0 || hasNext) keyboard.row();
  keyboard.text(t("mission.button.projects"), MISSION_ROOT_PROJECTS).row();
  keyboard
    .text(
      t(selected.length === 0 ? "mission.button.save_without_roots" : "mission.button.save"),
      MISSION_ROOT_OK,
    )
    .row();
  keyboard.text(t("inline.button.cancel"), MISSION_CANCEL);
  return keyboard;
}

function buildMissionDirectoryKeyboard(
  entries: Array<{ name: string; fullPath: string }>,
  currentPath: string,
  hasParent: boolean,
  page: number,
  totalCount: number,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const totalPages = Math.max(1, Math.ceil(totalCount / MAX_ENTRIES_PER_PAGE));
  for (const entry of entries) {
    keyboard
      .text(
        truncate(buildEntryLabel(entry), 54),
        encodeOpenPathForCallback(MISSION_DIRECTORY_NAV_PREFIX, entry.fullPath),
      )
      .row();
  }

  const showUp = hasParent && !isAllowedRoot(currentPath);
  const showRoots = getBrowserRoots().length > 1;
  if (showUp || showRoots) {
    if (showUp) {
      keyboard.text(
        t("open.back"),
        encodeOpenPathForCallback(MISSION_DIRECTORY_NAV_PREFIX, path.dirname(currentPath)),
      );
    }
    if (showRoots) keyboard.text(t("open.roots"), MISSION_DIRECTORY_ROOTS);
    keyboard.row();
  }

  if (totalPages > 1) {
    if (page > 0) {
      keyboard.text(
        t("open.prev_page"),
        encodeOpenPathWithPageCallback(MISSION_DIRECTORY_PAGE_PREFIX, currentPath, page - 1),
      );
    }
    if (page < totalPages - 1) {
      keyboard.text(
        t("open.next_page"),
        encodeOpenPathWithPageCallback(MISSION_DIRECTORY_PAGE_PREFIX, currentPath, page + 1),
      );
    }
    keyboard.row();
  }

  keyboard
    .text(
      t("mission.button.select_directory"),
      encodeOpenPathForCallback(MISSION_DIRECTORY_SELECT_PREFIX, currentPath),
    )
    .row()
    .text(t("inline.button.cancel"), MISSION_CANCEL);
  return keyboard;
}

export async function renderMissionDirectoryView(directory: string, page = 0) {
  const result = await scanDirectory(directory, page);
  if ("error" in result) return result;
  const totalPages = Math.max(1, Math.ceil(result.totalCount / MAX_ENTRIES_PER_PAGE));
  return {
    text: buildTreeHeader(result.displayPath, result.totalCount, result.page, totalPages),
    keyboard: buildMissionDirectoryKeyboard(
      result.entries,
      result.currentPath,
      result.hasParent,
      result.page,
      result.totalCount,
    ),
  };
}

export function buildMissionDirectoryRootsKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const root of getBrowserRoots()) {
    keyboard
      .text(
        truncate(`📂 ${pathToDisplayPath(root)}`, 54),
        encodeOpenPathForCallback(MISSION_DIRECTORY_NAV_PREFIX, root),
      )
      .row();
  }
  keyboard.text(t("inline.button.cancel"), MISSION_CANCEL);
  return keyboard;
}

function statusMarker(status: Mission["status"]): string {
  if (status === "running") return "🚀";
  if (status === "paused") return "⏸️";
  if (status === "stopped") return "⏹️";
  if (status === "completed") return "✅";
  if (status === "failed") return "❌";
  return "⚪";
}

function buildMissionListLabel(mission: Mission): string {
  const marker = statusMarker(mission.status);
  const counts = `(${mission.subMissionIds.length}|${mission.rootSessions.length})`;
  const maxNameLength = Math.max(3, 64 - marker.length - counts.length - 2);
  return `${marker} ${truncate(mission.name, maxNameLength)} ${counts}`;
}

function formatMissionStatus(status: Mission["status"]): string {
  switch (status) {
    case "running":
      return t("mission.status.running");
    case "paused":
      return t("mission.status.paused");
    case "stopped":
      return t("mission.status.stopped");
    case "completed":
      return t("mission.status.completed");
    case "failed":
      return t("mission.status.failed");
    default:
      return t("mission.status.idle");
  }
}

export function buildMissionsListKeyboard(
  missions: Mission[],
  page: number,
  pageSize: number,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const totalPages = Math.max(1, Math.ceil(missions.length / pageSize));
  const normalizedPage = Math.min(Math.max(0, page), totalPages - 1);
  const startIndex = normalizedPage * pageSize;
  missions.slice(startIndex, startIndex + pageSize).forEach((mission) => {
    keyboard.text(buildMissionListLabel(mission), `${MISSIONS_OPEN_PREFIX}${mission.id}`).row();
  });
  if (normalizedPage > 0) {
    keyboard.text(t("sessions.button.prev_page"), `${MISSIONS_PAGE_PREFIX}${normalizedPage - 1}`);
  }
  if (normalizedPage < totalPages - 1) {
    keyboard.text(t("sessions.button.next_page"), `${MISSIONS_PAGE_PREFIX}${normalizedPage + 1}`);
  }
  if (totalPages > 1) keyboard.row();
  keyboard.text(t("inline.button.close"), MISSIONS_CLOSE);
  return keyboard;
}

export function buildMissionDetailsText(
  mission: Mission,
  missions: Mission[],
  agents: MissionAgent[] = [],
): string {
  const subMissions = mission.subMissionIds
    .map((id) => missions.find((candidate) => candidate.id === id)?.name ?? id)
    .join(", ");
  const roots = mission.rootSessions.map((session) => session.title).join(", ");
  return t("missions.details", {
    name: mission.name,
    description: mission.description || "-",
    status: formatMissionStatus(mission.status),
    subMissions: subMissions ? truncate(subMissions, 700) : "-",
    roots: roots ? truncate(roots, 700) : "-",
    agents: agents.length,
    workingAgents: agents.filter((agent) => agent.status === "working").length,
    accessAgents: agents.filter((agent) => agent.status === "access_request").length,
    doneAgents: agents.filter((agent) => agent.status === "finished").length,
    requestedRuns: mission.requestedRuns,
    completedRuns: mission.completedRuns,
    sessionRuns: mission.totalSessionRuns,
    failedRuns: mission.failedSessionRuns,
    timeout:
      mission.timeoutMinutes === null
        ? t("mission.timeout.none")
        : t("mission.timeout.minutes", { minutes: mission.timeoutMinutes }),
    startedAt: mission.runStartedAt ?? "-",
    finishedAt: mission.runFinishedAt ?? "-",
    error: mission.lastError ?? "-",
  });
}

export function buildMissionDetailsKeyboard(
  mission: Mission,
  agents: MissionAgent[] = [],
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const agent of agents) {
    keyboard
      .text(
        truncate(
          `${formatSessionActivityStatus(agent.status)} ${agent.missionName}: ${agent.title}`,
          64,
        ),
        `${MISSIONS_AGENT_PREFIX}${agent.id}`,
      )
      .row();
  }
  if (mission.status === "running") {
    keyboard
      .text(t("missions.button.pause"), `${MISSIONS_PAUSE_PREFIX}${mission.id}`)
      .text(t("missions.button.stop"), `${MISSIONS_STOP_PREFIX}${mission.id}`)
      .row();
  } else if (mission.status === "paused") {
    keyboard
      .text(t("missions.button.resume"), `${MISSIONS_RESUME_PREFIX}${mission.id}`)
      .text(t("missions.button.stop"), `${MISSIONS_STOP_PREFIX}${mission.id}`)
      .row();
  } else {
    keyboard.text(t("missions.button.run"), `${MISSIONS_RUN_PREFIX}${mission.id}`).row();
  }
  keyboard
    .text(t("missions.button.rename"), `${MISSIONS_RENAME_PREFIX}${mission.id}`)
    .text(t("missions.button.description"), `${MISSIONS_DESCRIPTION_PREFIX}${mission.id}`)
    .row();
  if (mission.status !== "running" && mission.status !== "paused") {
    keyboard
      .text(t("missions.button.sub_missions"), `${MISSIONS_EDIT_SUB_PREFIX}${mission.id}`)
      .text(t("missions.button.root_sessions"), `${MISSIONS_EDIT_ROOT_PREFIX}${mission.id}`)
      .row()
      .text(t("missions.button.create_sessions"), `${MISSIONS_CREATE_ROOT_PREFIX}${mission.id}`)
      .row();
  }
  keyboard
    .text(t("missions.button.delete"), `${MISSIONS_DELETE_PREFIX}${mission.id}`)
    .row()
    .text(t("missions.button.refresh"), `${MISSIONS_REFRESH_PREFIX}${mission.id}`)
    .row()
    .text(t("missions.button.back"), MISSIONS_BACK);
  return keyboard;
}

export function buildMissionDeleteKeyboard(missionId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(t("missions.button.delete_confirm"), `${MISSIONS_DELETE_CONFIRM_PREFIX}${missionId}`)
    .row()
    .text(t("missions.button.back"), `${MISSIONS_OPEN_PREFIX}${missionId}`);
}
