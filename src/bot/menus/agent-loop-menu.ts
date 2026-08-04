import { InlineKeyboard } from "grammy";
import type { AgentLoop } from "../../app/types/loop.js";
import type { SessionInfo } from "../../app/types/session.js";
import { t } from "../../i18n/index.js";

export const LOOP_CALLBACK_PREFIX = "loop:";
export const LOOP_SELECT_PREFIX = `${LOOP_CALLBACK_PREFIX}select:`;
export const LOOP_PAGE_PREFIX = `${LOOP_CALLBACK_PREFIX}page:`;
export const LOOP_UNDO = `${LOOP_CALLBACK_PREFIX}undo`;
export const LOOP_OK = `${LOOP_CALLBACK_PREFIX}ok`;
export const LOOP_CANCEL = `${LOOP_CALLBACK_PREFIX}cancel`;
export const LOOPS_CALLBACK_PREFIX = "loops:";
export const LOOPS_OPEN_PREFIX = `${LOOPS_CALLBACK_PREFIX}open:`;
export const LOOPS_RUN_PREFIX = `${LOOPS_CALLBACK_PREFIX}run:`;
export const LOOPS_STOP_PREFIX = `${LOOPS_CALLBACK_PREFIX}stop:`;
export const LOOPS_DELETE_PREFIX = `${LOOPS_CALLBACK_PREFIX}delete:`;
export const LOOPS_PAGE_PREFIX = `${LOOPS_CALLBACK_PREFIX}page:`;
export const LOOPS_BACK = `${LOOPS_CALLBACK_PREFIX}back`;
export const LOOPS_CLOSE = `${LOOPS_CALLBACK_PREFIX}close`;

function truncate(value: string, length = 48): string {
  return value.length <= length ? value : `${value.slice(0, length - 3)}...`;
}

export function formatSelectedLoopSteps(steps: SessionInfo[]): string {
  if (steps.length === 0) return t("loop.selected.empty");
  const startIndex = Math.max(0, steps.length - 30);
  const selected = steps
    .slice(startIndex)
    .map((step, index) => `${startIndex + index + 1}. ${step.title}`)
    .join("\n");
  return startIndex > 0 ? `...\n${selected}` : selected;
}

export function buildLoopSessionKeyboard(
  sessions: SessionInfo[],
  page: number,
  hasNext: boolean,
  hasSelections: boolean,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  sessions.forEach((session) => {
    keyboard.text(truncate(session.title), `${LOOP_SELECT_PREFIX}${session.id}`).row();
  });
  if (page > 0) keyboard.text(t("sessions.button.prev_page"), `${LOOP_PAGE_PREFIX}${page - 1}`);
  if (hasNext) keyboard.text(t("sessions.button.next_page"), `${LOOP_PAGE_PREFIX}${page + 1}`);
  if (page > 0 || hasNext) keyboard.row();
  if (hasSelections) {
    keyboard.text(t("loop.button.undo"), LOOP_UNDO).text(t("loop.button.ok"), LOOP_OK).row();
  }
  keyboard.text(t("inline.button.cancel"), LOOP_CANCEL);
  return keyboard;
}

function formatLoopSequence(loop: AgentLoop): string {
  return loop.steps.map((step) => step.title).join(" → ");
}

function getElapsedMinutes(loop: AgentLoop): number {
  const startedAt = Date.parse(loop.runStartedAt);
  const endedAt = loop.runStoppedAt ? Date.parse(loop.runStoppedAt) : Date.now();
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt)) return 0;
  return Math.max(0, Math.floor((endedAt - startedAt) / 60_000));
}

export function buildLoopsListKeyboard(
  loops: AgentLoop[],
  page: number,
  pageSize: number,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const totalPages = Math.max(1, Math.ceil(loops.length / pageSize));
  const normalizedPage = Math.min(Math.max(0, page), totalPages - 1);
  const startIndex = normalizedPage * pageSize;
  loops.slice(startIndex, startIndex + pageSize).forEach((loop) => {
    const marker = loop.status === "running" ? "▶️" : "⏸";
    keyboard
      .text(`${marker} ${truncate(formatLoopSequence(loop))}`, `${LOOPS_OPEN_PREFIX}${loop.id}`)
      .row();
  });
  if (normalizedPage > 0) {
    keyboard.text(t("sessions.button.prev_page"), `${LOOPS_PAGE_PREFIX}${normalizedPage - 1}`);
  }
  if (normalizedPage < totalPages - 1) {
    keyboard.text(t("sessions.button.next_page"), `${LOOPS_PAGE_PREFIX}${normalizedPage + 1}`);
  }
  if (totalPages > 1) keyboard.row();
  keyboard.text(t("inline.button.close"), LOOPS_CLOSE);
  return keyboard;
}

export function buildLoopDetailsText(loop: AgentLoop): string {
  return t("loops.details", {
    status: loop.status,
    sequence: truncate(formatLoopSequence(loop), 700),
    interval: loop.intervalMinutes,
    timeout: loop.timeoutMinutes ?? "-",
    completedCycles: loop.completedCycles,
    elapsedMinutes: getElapsedMinutes(loop),
    prompt: truncate(loop.prompt, 2000),
    nextRunAt: loop.nextRunAt ?? "-",
    expiresAt: loop.expiresAt ?? "-",
    stopReason: loop.stopReason ?? "-",
  });
}

export function buildLoopDetailsKeyboard(loop: AgentLoop): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (loop.status === "running") {
    keyboard.text(t("loops.button.stop"), `${LOOPS_STOP_PREFIX}${loop.id}`);
  } else {
    keyboard.text(t("loops.button.run"), `${LOOPS_RUN_PREFIX}${loop.id}`);
  }
  keyboard.row().text(t("loops.button.delete"), `${LOOPS_DELETE_PREFIX}${loop.id}`).row();
  keyboard.text(t("loops.button.back"), LOOPS_BACK);
  return keyboard;
}
