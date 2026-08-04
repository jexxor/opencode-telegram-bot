import { InlineKeyboard } from "grammy";
import { getGitWorktreeContext } from "../../app/services/worktree-service.js";
import { t } from "../../i18n/index.js";
import { getCurrentProject } from "../../app/stores/settings-store.js";
import { logger } from "../../utils/logger.js";
import { config } from "../../config.js";
import type { ProjectInfo } from "../../app/types/project.js";

const MAX_INLINE_BUTTON_LABEL_LENGTH = 64;
export const PROJECT_PAGE_CALLBACK_PREFIX = "projects:page:";

interface ProjectsPaginationRange {
  page: number;
  totalPages: number;
  startIndex: number;
  endIndex: number;
}

export function getProjectFolderName(worktree: string): string {
  const normalized = worktree.replace(/[\\/]+$/g, "");

  if (!normalized) {
    return worktree;
  }

  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? normalized;
}

export function buildProjectButtonLabel(index: number, worktree: string): string {
  const folderName = getProjectFolderName(worktree);
  return `${index + 1}. ${folderName} [${worktree}]`;
}

export function buildProjectPathButtonLabel(
  worktree: string,
  options: { prefix?: string; maxLength?: number } = {},
): string {
  const maxLength = options.maxLength ?? MAX_INLINE_BUTTON_LABEL_LENGTH;
  const folderName = getProjectFolderName(worktree);
  const prefix = `${options.prefix ?? ""}📁 ${folderName}`;
  const context = worktree.replace(/[\\/]+$/g, "");
  const separator = " · ";
  const availableContextLength = Math.max(8, maxLength - prefix.length - separator.length);
  const availablePrefixLength = maxLength - availableContextLength - separator.length;
  const displayPrefix =
    prefix.length <= availablePrefixLength
      ? prefix
      : `${prefix.slice(0, Math.max(0, availablePrefixLength - 3))}...`;
  const contextPrefixLength = Math.max(4, Math.floor((availableContextLength - 1) / 3));
  const contextSuffixLength = availableContextLength - contextPrefixLength - 1;
  const displayContext =
    context.length <= availableContextLength
      ? context
      : `${context.slice(0, contextPrefixLength)}…${context.slice(-contextSuffixLength)}`;
  return `${displayPrefix}${separator}${displayContext}`;
}

export function parseProjectPageCallback(data: string): number | null {
  if (!data.startsWith(PROJECT_PAGE_CALLBACK_PREFIX)) {
    return null;
  }

  const rawPage = data.slice(PROJECT_PAGE_CALLBACK_PREFIX.length);
  if (!/^\d+$/.test(rawPage)) {
    return null;
  }

  return Number.parseInt(rawPage, 10);
}

export function calculateProjectsPaginationRange(
  totalProjects: number,
  page: number,
  pageSize: number,
): ProjectsPaginationRange {
  const safePageSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(totalProjects / safePageSize));
  const normalizedPage = Math.min(Math.max(0, page), totalPages - 1);
  const startIndex = normalizedPage * safePageSize;
  const endIndex = Math.min(startIndex + safePageSize, totalProjects);

  return {
    page: normalizedPage,
    totalPages,
    startIndex,
    endIndex,
  };
}

function buildProjectsMenuText(
  currentProjectName: string | null,
  page: number,
  totalPages: number,
): string {
  const baseText = currentProjectName
    ? t("projects.select_with_current", {
        project: currentProjectName,
      })
    : t("projects.select");

  if (totalPages <= 1) {
    return baseText;
  }

  return `${baseText}\n\n${t("projects.page_indicator", {
    current: String(page + 1),
    total: String(totalPages),
  })}`;
}

function worktreeKey(worktree: string): string {
  return process.platform === "win32" ? worktree.toLowerCase() : worktree;
}

async function getActiveProjectWorktree(): Promise<string | null> {
  const currentProject = getCurrentProject();
  if (!currentProject) {
    return null;
  }

  try {
    const worktreeContext = await getGitWorktreeContext(currentProject.worktree);
    if (worktreeContext) {
      return worktreeContext.mainProjectPath;
    }
  } catch (error) {
    logger.debug("[Projects] Could not resolve active git worktree metadata:", error);
  }

  return currentProject.worktree;
}

async function buildProjectsKeyboard(
  projects: ProjectInfo[],
  page: number,
): Promise<InlineKeyboard> {
  const keyboard = new InlineKeyboard();
  const currentProject = getCurrentProject();
  const activeProjectWorktree = await getActiveProjectWorktree();
  const pageSize = config.bot.projectsListLimit;
  const {
    page: normalizedPage,
    totalPages,
    startIndex,
    endIndex,
  } = calculateProjectsPaginationRange(projects.length, page, pageSize);

  projects.slice(startIndex, endIndex).forEach((project, index) => {
    const isActive =
      currentProject &&
      (project.id === currentProject.id ||
        project.worktree === currentProject.worktree ||
        (activeProjectWorktree !== null &&
          worktreeKey(project.worktree) === worktreeKey(activeProjectWorktree)));
    const prefix = `${isActive ? "✅ " : ""}${startIndex + index + 1}. `;
    const label = buildProjectPathButtonLabel(project.worktree, { prefix });
    keyboard.text(label, `project:${project.id}`).row();
  });

  if (totalPages > 1) {
    if (normalizedPage > 0) {
      keyboard.text(
        t("projects.prev_page"),
        `${PROJECT_PAGE_CALLBACK_PREFIX}${normalizedPage - 1}`,
      );
    }

    if (normalizedPage < totalPages - 1) {
      keyboard.text(
        t("projects.next_page"),
        `${PROJECT_PAGE_CALLBACK_PREFIX}${normalizedPage + 1}`,
      );
    }
  }

  return keyboard;
}

export async function buildProjectsMenuView(
  projects: ProjectInfo[],
  page: number,
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const currentProject = getCurrentProject();
  const pageSize = config.bot.projectsListLimit;
  const { page: normalizedPage, totalPages } = calculateProjectsPaginationRange(
    projects.length,
    page,
    pageSize,
  );
  const currentProjectName = currentProject?.name || currentProject?.worktree || null;

  return {
    text: buildProjectsMenuText(currentProjectName, normalizedPage, totalPages),
    keyboard: await buildProjectsKeyboard(projects, normalizedPage),
  };
}
