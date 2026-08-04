import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { agentLoopCreationManager } from "../../../src/app/managers/agent-loop-creation-manager.js";
import { interactionManager } from "../../../src/app/managers/interaction-manager.js";
import type { AgentLoop } from "../../../src/app/types/loop.js";
import { t } from "../../../src/i18n/index.js";

const mocked = vi.hoisted(() => ({
  addLoop: vi.fn(),
  registerLoop: vi.fn(),
  sessionList: vi.fn(),
  sessionGet: vi.fn(),
}));

vi.mock("../../../src/config.js", () => ({
  config: { bot: { sessionsListLimit: 10 } },
}));
vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getCurrentProject: () => ({ id: "project-1", worktree: "/repo" }),
}));
vi.mock("../../../src/app/services/agent-selection-service.js", () => ({
  getStoredAgent: () => "build",
  resolveProjectAgent: async () => "build",
}));
vi.mock("../../../src/app/services/model-selection-service.js", () => ({
  getStoredModel: () => ({ providerID: "openai", modelID: "gpt-5" }),
}));
vi.mock("../../../src/app/stores/agent-loop-store.js", () => ({
  addAgentLoop: mocked.addLoop,
  getAgentLoop: vi.fn(),
  listAgentLoops: vi.fn(() => []),
}));
vi.mock("../../../src/app/services/agent-loop-runtime-service.js", () => ({
  agentLoopRuntime: {
    registerLoop: mocked.registerLoop,
    runNow: vi.fn(),
    stop: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: { list: mocked.sessionList, get: mocked.sessionGet },
  },
}));

import { handleLoopCallback } from "../../../src/bot/callbacks/agent-loop-callback-handler.js";
import { handleLoopTextInput, loopCommand } from "../../../src/bot/commands/loop-command.js";
import {
  buildLoopDetailsText,
  buildLoopsListKeyboard,
  LOOPS_OPEN_PREFIX,
  LOOPS_PAGE_PREFIX,
} from "../../../src/bot/menus/agent-loop-menu.js";

function commandContext(): Context {
  return {
    chat: { id: 1 },
    reply: vi.fn().mockResolvedValue({ message_id: 10 }),
  } as unknown as Context;
}

function callbackContext(data: string): Context {
  return {
    callbackQuery: { data, message: { message_id: 10 } } as Context["callbackQuery"],
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

function textContext(text: string): Context {
  return {
    chat: { id: 1 },
    message: { text } as Context["message"],
    reply: vi.fn().mockResolvedValue({ message_id: 11 }),
  } as unknown as Context;
}

describe("/loop", () => {
  beforeEach(() => {
    agentLoopCreationManager.__resetForTests();
    interactionManager.clear("test");
    vi.clearAllMocks();
    mocked.sessionList.mockResolvedValue({
      data: [{ id: "s1", title: "Session 1", directory: "/repo" }],
      error: null,
    });
    mocked.sessionGet.mockResolvedValue({
      data: { id: "s1", title: "Session 1", directory: "/repo" },
      error: null,
    });
  });

  it("preserves duplicate selection and creates a loop with shared prompt", async () => {
    await loopCommand(commandContext() as never);
    await handleLoopCallback(callbackContext("loop:select:s1"));
    await handleLoopCallback(callbackContext("loop:select:s1"));
    await handleLoopCallback(callbackContext("loop:ok"));
    await handleLoopTextInput(textContext("15"));
    await handleLoopTextInput(textContext("60"));
    await handleLoopTextInput(textContext("Proceed with next iteration"));

    expect(mocked.addLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: [
          { id: "s1", title: "Session 1", directory: "/repo" },
          { id: "s1", title: "Session 1", directory: "/repo" },
        ],
        intervalMinutes: 15,
        timeoutMinutes: 60,
        prompt: "Proceed with next iteration",
        currentStepIndex: 0,
        completedCycles: 0,
        runStartedAt: expect.any(String),
        runStoppedAt: null,
        status: "running",
        stopReason: null,
      }),
    );
    expect(mocked.registerLoop).toHaveBeenCalled();
    expect(agentLoopCreationManager.getState()).toBeNull();
  });

  it("accepts zero to create a loop without a timeout", async () => {
    await loopCommand(commandContext() as never);
    await handleLoopCallback(callbackContext("loop:select:s1"));
    await handleLoopCallback(callbackContext("loop:ok"));
    await handleLoopTextInput(textContext("15"));
    await handleLoopTextInput(textContext("0"));
    await handleLoopTextInput(textContext("Keep working"));

    expect(mocked.addLoop).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMinutes: null, expiresAt: null }),
    );
  });

  it("rejects loop intervals that cannot produce a valid next run date", async () => {
    await loopCommand(commandContext() as never);
    await handleLoopCallback(callbackContext("loop:select:s1"));
    await handleLoopCallback(callbackContext("loop:ok"));
    const ctx = textContext(String(Number.MAX_SAFE_INTEGER));

    expect(await handleLoopTextInput(ctx)).toBe(true);
    expect(ctx.reply).toHaveBeenCalled();
    expect(agentLoopCreationManager.getState()?.stage).toBe("awaiting_interval");
  });

  it("shows completed cycles and frozen elapsed minutes in loop details", () => {
    const loop: AgentLoop = {
      id: "loop-1",
      projectId: "project-1",
      projectWorktree: "/repo",
      steps: [{ id: "s1", title: "Session 1", directory: "/repo" }],
      intervalMinutes: 15,
      timeoutMinutes: 60,
      prompt: "Keep working",
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5", variant: null },
      status: "stopped",
      currentStepIndex: 0,
      completedCycles: 3,
      runStartedAt: "2026-08-12T10:00:00.000Z",
      runStoppedAt: "2026-08-12T10:12:59.000Z",
      nextRunAt: null,
      expiresAt: null,
      lastRunAt: "2026-08-12T10:10:00.000Z",
      stopReason: "manual",
      createdAt: "2026-08-12T10:00:00.000Z",
    };

    expect(buildLoopDetailsText(loop)).toBe(
      t("loops.details", {
        status: "stopped",
        sequence: "Session 1",
        interval: 15,
        timeout: 60,
        completedCycles: 3,
        elapsedMinutes: 12,
        prompt: "Keep working",
        nextRunAt: "-",
        expiresAt: "-",
        stopReason: "manual",
      }),
    );
  });

  it("paginates loop keyboards", () => {
    const loops = Array.from({ length: 25 }, (_, index) => ({
      id: `loop-${index}`,
      projectId: "project-1",
      projectWorktree: "/repo",
      steps: [{ id: `s-${index}`, title: `Session ${index}`, directory: "/repo" }],
      intervalMinutes: 15,
      timeoutMinutes: null,
      prompt: "Continue",
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5", variant: null },
      status: "stopped" as const,
      currentStepIndex: 0,
      completedCycles: 0,
      runStartedAt: "2026-08-12T10:00:00.000Z",
      runStoppedAt: "2026-08-12T10:00:00.000Z",
      nextRunAt: null,
      expiresAt: null,
      lastRunAt: null,
      stopReason: "manual" as const,
      createdAt: "2026-08-12T10:00:00.000Z",
    }));

    const keyboard = buildLoopsListKeyboard(loops, 1, 10);
    const callbacks = keyboard.inline_keyboard
      .flat()
      .map((button) => ("callback_data" in button ? button.callback_data : undefined))
      .filter((value): value is string => Boolean(value));

    expect(callbacks.filter((value) => value.startsWith(LOOPS_OPEN_PREFIX))).toEqual(
      loops.slice(10, 20).map((loop) => `${LOOPS_OPEN_PREFIX}${loop.id}`),
    );
    expect(callbacks).toContain(`${LOOPS_PAGE_PREFIX}0`);
    expect(callbacks).toContain(`${LOOPS_PAGE_PREFIX}2`);
  });
});
