import { beforeEach, describe, expect, it, vi } from "vitest";
import { cloneAgentLoop, type AgentLoop } from "../../../src/app/types/loop.js";

const mocked = vi.hoisted(() => ({
  loops: [] as AgentLoop[],
  queued: [] as Array<Record<string, unknown>>,
  notify: vi.fn(),
  addPrompt: vi.fn(),
  removeByLoop: vi.fn(),
}));

vi.mock("../../../src/app/stores/agent-loop-store.js", () => ({
  listAgentLoops: () => mocked.loops.map((loop) => structuredClone(loop)),
  getAgentLoop: (id: string) => {
    const loop = mocked.loops.find((item) => item.id === id);
    return loop ? structuredClone(loop) : null;
  },
  updateAgentLoop: async (id: string, updater: (loop: AgentLoop) => AgentLoop) => {
    const index = mocked.loops.findIndex((loop) => loop.id === id);
    if (index < 0) return null;
    mocked.loops[index] = structuredClone(updater(structuredClone(mocked.loops[index])));
    return structuredClone(mocked.loops[index]);
  },
  removeAgentLoop: async (id: string) => {
    const before = mocked.loops.length;
    mocked.loops = mocked.loops.filter((loop) => loop.id !== id);
    return mocked.loops.length !== before;
  },
}));

vi.mock("../../../src/app/stores/session-prompt-queue-store.js", () => ({
  addQueuedSessionPrompt: async (prompt: Record<string, unknown>) => {
    return mocked.addPrompt(prompt);
  },
  removeQueuedSessionPrompt: async (promptId: string) => {
    mocked.queued = mocked.queued.filter((prompt) => prompt.id !== promptId);
  },
  removeQueuedSessionPromptsByAgentLoopId: async (agentLoopId: string) => {
    mocked.removeByLoop(agentLoopId);
    mocked.queued = mocked.queued.filter((prompt) => prompt.agentLoopId !== agentLoopId);
  },
}));

vi.mock("../../../src/app/services/session-prompt-queue-runtime-service.js", () => ({
  sessionPromptQueueRuntime: { notifyQueueChanged: mocked.notify },
}));

import { AgentLoopRuntime } from "../../../src/app/services/agent-loop-runtime-service.js";

function createLoop(): AgentLoop {
  return {
    id: "loop-1",
    projectId: "project-1",
    projectWorktree: "/repo",
    steps: [
      { id: "s1", title: "Session 1", directory: "/repo" },
      { id: "s1", title: "Session 1", directory: "/repo" },
      { id: "s2", title: "Session 2", directory: "/repo" },
    ],
    intervalMinutes: 15,
    timeoutMinutes: null,
    prompt: "Proceed with next iteration",
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-5", variant: null },
    status: "running",
    currentStepIndex: 0,
    completedCycles: 0,
    runStartedAt: "2026-08-12T10:00:00.000Z",
    runStoppedAt: null,
    nextRunAt: "2026-08-12T10:00:00.000Z",
    expiresAt: null,
    lastRunAt: null,
    stopReason: null,
    createdAt: "2026-08-12T10:00:00.000Z",
  };
}

describe("AgentLoopRuntime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T10:00:00.000Z"));
    mocked.loops = [createLoop()];
    mocked.queued = [];
    mocked.notify.mockReset();
    mocked.addPrompt.mockReset();
    mocked.removeByLoop.mockReset();
    mocked.addPrompt.mockImplementation(async (prompt: Record<string, unknown>) => {
      mocked.queued.push(prompt);
      return mocked.queued.length;
    });
  });

  it("queues duplicate-preserving steps at fixed intervals and repeats", async () => {
    const runtime = new AgentLoopRuntime();
    runtime.initialize();

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await vi.advanceTimersByTimeAsync(15 * 60_000);

    expect(mocked.queued.map((prompt) => prompt.sessionId)).toEqual(["s1", "s1", "s2", "s1"]);
    expect(
      mocked.queued.every(
        (prompt) =>
          String(prompt.text).startsWith("Proceed with next iteration\n\n") &&
          String(prompt.text).includes("STOP_LOOP_REASON_TERMINAL") &&
          prompt.agentLoopId === "loop-1" &&
          prompt.agentLoopRunStartedAt === "2026-08-12T10:00:00.000Z",
      ),
    ).toBe(true);
    expect(mocked.loops[0].completedCycles).toBe(1);
    runtime.shutdown();
    vi.useRealTimers();
  });

  it("stops future steps and runNow restarts from the first step", async () => {
    const runtime = new AgentLoopRuntime();
    runtime.initialize();
    await vi.advanceTimersByTimeAsync(0);
    await runtime.stop("loop-1");
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(mocked.queued).toEqual([]);

    await runtime.runNow("loop-1");
    expect(mocked.removeByLoop).toHaveBeenCalledWith("loop-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(mocked.queued.map((prompt) => prompt.sessionId)).toEqual(["s1"]);

    await runtime.delete("loop-1");
    expect(mocked.loops).toEqual([]);
    expect(mocked.queued).toEqual([]);
    runtime.shutdown();
    vi.useRealTimers();
  });

  it("does not overwrite stop state when a queue write is in flight", async () => {
    let releaseWrite: () => void = () => {};
    mocked.addPrompt.mockImplementationOnce(async (prompt: Record<string, unknown>) => {
      mocked.queued.push(prompt);
      await new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      return mocked.queued.length;
    });
    const runtime = new AgentLoopRuntime();
    runtime.initialize();
    await vi.advanceTimersByTimeAsync(0);

    await runtime.stop("loop-1");
    releaseWrite();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expect(mocked.loops[0]).toMatchObject({ status: "stopped", nextRunAt: null });
    expect(mocked.queued).toHaveLength(0);
    runtime.shutdown();
    vi.useRealTimers();
  });

  it("reschedules a new run when an old dispatch fails in flight", async () => {
    let rejectWrite: (error: Error) => void = () => undefined;
    mocked.addPrompt.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectWrite = reject;
        }),
    );
    const runtime = new AgentLoopRuntime();
    runtime.initialize();
    await vi.advanceTimersByTimeAsync(0);

    await runtime.stop("loop-1");
    vi.setSystemTime(new Date("2026-08-12T11:00:00.000Z"));
    await runtime.runNow("loop-1");
    await vi.advanceTimersByTimeAsync(0);
    rejectWrite(new Error("old queue write failed"));
    await vi.advanceTimersByTimeAsync(0);

    expect(mocked.addPrompt).toHaveBeenCalledTimes(2);
    expect(mocked.queued).toHaveLength(1);
    expect(mocked.queued[0].agentLoopRunStartedAt).toBe("2026-08-12T11:00:00.000Z");
    runtime.shutdown();
    vi.useRealTimers();
  });

  it("stops when the optional timeout expires", async () => {
    mocked.loops[0] = {
      ...createLoop(),
      timeoutMinutes: 20,
      expiresAt: "2026-08-12T10:20:00.000Z",
    };
    const runtime = new AgentLoopRuntime();
    runtime.initialize();

    await vi.advanceTimersByTimeAsync(20 * 60_000);

    expect(mocked.queued).toEqual([]);
    expect(mocked.loops[0]).toMatchObject({
      status: "stopped",
      nextRunAt: null,
      expiresAt: null,
      stopReason: "timeout",
    });
    runtime.shutdown();
    vi.useRealTimers();
  });

  it("resets timeout on Run and stops on terminal marker", async () => {
    mocked.loops[0] = {
      ...createLoop(),
      status: "stopped",
      completedCycles: 4,
      runStartedAt: "2026-08-12T08:00:00.000Z",
      runStoppedAt: "2026-08-12T09:00:00.000Z",
      timeoutMinutes: 20,
      nextRunAt: null,
      expiresAt: null,
      stopReason: "manual",
    };
    const runtime = new AgentLoopRuntime();
    runtime.initialize();

    await runtime.runNow("loop-1");
    expect(mocked.loops[0]).toMatchObject({
      status: "running",
      completedCycles: 0,
      runStartedAt: "2026-08-12T10:00:00.000Z",
      runStoppedAt: null,
      expiresAt: "2026-08-12T10:20:00.000Z",
      stopReason: null,
    });
    expect(await runtime.handleAssistantResponse("loop-1", "STOP_LOOP_REASON_TERMINAL")).toBe(
      true,
    );
    expect(mocked.loops[0]).toMatchObject({
      status: "stopped",
      nextRunAt: null,
      expiresAt: null,
      runStoppedAt: "2026-08-12T10:00:00.000Z",
      stopReason: "terminal",
    });
    expect(mocked.queued).toEqual([]);
    runtime.shutdown();
    vi.useRealTimers();
  });

  it("requires the terminal marker on its own line", async () => {
    const runtime = new AgentLoopRuntime();
    runtime.initialize();

    expect(
      await runtime.handleAssistantResponse(
        "loop-1",
        "Do not emit STOP_LOOP_REASON_TERMINAL until work is complete.",
      ),
    ).toBe(false);
    expect(mocked.loops[0].status).toBe("running");

    expect(
      await runtime.handleAssistantResponse(
        "loop-1",
        "All work complete.\nSTOP_LOOP_REASON_TERMINAL\n",
      ),
    ).toBe(true);
    expect(mocked.loops[0].status).toBe("stopped");
    runtime.shutdown();
    vi.useRealTimers();
  });

  it("ignores a terminal marker from an older loop run", async () => {
    const runtime = new AgentLoopRuntime();
    runtime.initialize();
    await vi.advanceTimersByTimeAsync(0);
    await runtime.stop("loop-1");
    vi.setSystemTime(new Date("2026-08-12T11:00:00.000Z"));
    await runtime.runNow("loop-1");

    expect(
      await runtime.handleAssistantResponse(
        "loop-1",
        "STOP_LOOP_REASON_TERMINAL",
        "2026-08-12T10:00:00.000Z",
      ),
    ).toBe(false);
    expect(mocked.loops[0].status).toBe("running");

    await vi.advanceTimersByTimeAsync(0);
    expect(mocked.queued).toHaveLength(1);
    runtime.shutdown();
    vi.useRealTimers();
  });

  it("expires immediately after restart without dispatching an overdue step", async () => {
    mocked.loops[0] = {
      ...createLoop(),
      timeoutMinutes: 10,
      expiresAt: "2026-08-12T10:10:00.000Z",
    };
    vi.setSystemTime(new Date("2026-08-12T10:20:00.000Z"));
    const runtime = new AgentLoopRuntime();
    runtime.initialize();

    await vi.advanceTimersByTimeAsync(0);

    expect(mocked.queued).toEqual([]);
    expect(mocked.loops[0]).toMatchObject({
      status: "stopped",
      stopReason: "timeout",
      runStoppedAt: "2026-08-12T10:10:00.000Z",
    });
    runtime.shutdown();
    vi.useRealTimers();
  });

  it("freezes elapsed run time when stopped manually", async () => {
    const runtime = new AgentLoopRuntime();
    runtime.initialize();
    await vi.advanceTimersByTimeAsync(7 * 60_000);

    await runtime.stop("loop-1");

    expect(mocked.loops[0].runStoppedAt).toBe("2026-08-12T10:07:00.000Z");
    runtime.shutdown();
    vi.useRealTimers();
  });

  it("normalizes metrics for loops persisted before metrics were added", () => {
    const legacyLoop = createLoop() as Partial<AgentLoop>;
    delete legacyLoop.completedCycles;
    delete legacyLoop.runStartedAt;
    delete legacyLoop.runStoppedAt;

    expect(cloneAgentLoop(legacyLoop as AgentLoop)).toMatchObject({
      completedCycles: 0,
      runStartedAt: legacyLoop.createdAt,
      runStoppedAt: null,
    });
  });
});
