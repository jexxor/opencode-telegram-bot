import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  prompts: [] as Array<Record<string, unknown>>,
  status: vi.fn(),
  promptAsync: vi.fn(),
  abort: vi.fn(),
  remove: vi.fn(async (id: string) => {
    mocked.prompts = mocked.prompts.filter((prompt) => prompt.id !== id);
  }),
  markBusy: vi.fn(),
  markIdle: vi.fn(),
  startRun: vi.fn(),
  clearRun: vi.fn(),
  getRun: vi.fn(() => null),
  registerSession: vi.fn(),
  markWorking: vi.fn(),
  markFinished: vi.fn(),
  registerSuppression: vi.fn(),
  loopStatus: "running",
  loopRunStartedAt: "run-1",
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: { status: mocked.status, promptAsync: mocked.promptAsync, abort: mocked.abort },
  },
}));

vi.mock("../../../src/app/stores/session-prompt-queue-store.js", () => ({
  listQueuedSessionPrompts: () => mocked.prompts.map((prompt) => ({ ...prompt })),
  removeQueuedSessionPrompt: mocked.remove,
}));

vi.mock("../../../src/app/stores/agent-loop-store.js", () => ({
  getAgentLoop: (id: string) =>
    id === "loop-1"
      ? { id, status: mocked.loopStatus, runStartedAt: mocked.loopRunStartedAt }
      : null,
}));

vi.mock("../../../src/app/managers/foreground-session-state-manager.js", () => ({
  foregroundSessionState: {
    markBusy: mocked.markBusy,
    markIdle: mocked.markIdle,
  },
}));

vi.mock("../../../src/app/managers/assistant-run-state-manager.js", () => ({
  assistantRunState: {
    startRun: mocked.startRun,
    clearRun: mocked.clearRun,
    getRun: mocked.getRun,
  },
}));

vi.mock("../../../src/app/managers/session-status-manager.js", () => ({
  sessionStatusManager: {
    register: mocked.registerSession,
    markWorking: mocked.markWorking,
    markFinished: mocked.markFinished,
    __resetForTests: vi.fn(),
  },
}));

vi.mock("../../../src/app/managers/external-input-suppression-manager.js", () => ({
  externalUserInputSuppressionManager: {
    register: mocked.registerSuppression,
  },
}));

vi.mock("../../../src/app/services/attach-service.js", () => ({
  markAttachedSessionBusy: vi.fn().mockResolvedValue(undefined),
  markAttachedSessionIdle: vi.fn().mockResolvedValue(undefined),
}));

import { SessionPromptQueueRuntime } from "../../../src/app/services/session-prompt-queue-runtime-service.js";

describe("SessionPromptQueueRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.prompts = [
      {
        id: "first",
        sessionId: "session-1",
        sessionTitle: "Session one",
        directory: "/one",
        text: "first task",
        agent: "build",
        agentLoopId: "loop-1",
        agentLoopRunStartedAt: "run-1",
        model: { providerID: "provider", modelID: "model" },
        createdAt: "2026-08-02T00:00:00.000Z",
      },
      {
        id: "second",
        sessionId: "session-1",
        sessionTitle: "Session one",
        directory: "/one",
        text: "second task",
        agent: "build",
        model: { providerID: "provider", modelID: "model" },
        createdAt: "2026-08-02T00:01:00.000Z",
      },
    ];
    mocked.status.mockResolvedValue({ data: {} });
    mocked.promptAsync.mockResolvedValue({});
    mocked.abort.mockResolvedValue({});
    mocked.loopStatus = "running";
    mocked.loopRunStartedAt = "run-1";
  });

  it("dispatches only the first queued prompt for a session", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const runtime = new SessionPromptQueueRuntime();
    runtime.initialize({ api: { sendMessage } } as never, 123);

    await vi.waitFor(() => expect(mocked.promptAsync).toHaveBeenCalledTimes(1));
    expect(mocked.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: "session-1",
        directory: "/one",
        parts: [{ type: "text", text: "first task" }],
      }),
    );
    expect(mocked.remove).toHaveBeenCalledWith("first");
    expect(mocked.startRun).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        configuredAgent: "build",
        configuredProviderID: "provider",
        configuredModelID: "model",
        agentLoopId: "loop-1",
      }),
    );
    runtime.shutdown();
  });

  it("keeps the prompt queued while its session is busy", async () => {
    mocked.status.mockResolvedValue({ data: { "session-1": { type: "busy" } } });
    const runtime = new SessionPromptQueueRuntime();
    runtime.initialize({ api: { sendMessage: vi.fn() } } as never, 123);

    await vi.waitFor(() => expect(mocked.status).toHaveBeenCalled());
    expect(mocked.promptAsync).not.toHaveBeenCalled();
    expect(mocked.remove).not.toHaveBeenCalled();
    runtime.shutdown();
  });

  it("removes a queued prompt when its originating loop has stopped", async () => {
    mocked.loopStatus = "stopped";
    const runtime = new SessionPromptQueueRuntime();
    runtime.initialize({ api: { sendMessage: vi.fn() } } as never, 123);

    await vi.waitFor(() => expect(mocked.remove).toHaveBeenCalledWith("first"));
    expect(mocked.promptAsync).not.toHaveBeenCalled();
    runtime.shutdown();
  });

  it("removes a queued prompt from an older loop generation", async () => {
    mocked.prompts[0].agentLoopRunStartedAt = "old-run";
    const runtime = new SessionPromptQueueRuntime();
    runtime.initialize({ api: { sendMessage: vi.fn() } } as never, 123);

    await vi.waitFor(() => expect(mocked.remove).toHaveBeenCalledWith("first"));
    expect(mocked.promptAsync).not.toHaveBeenCalled();
    runtime.shutdown();
  });

  it("aborts a loop prompt when the loop stops while promptAsync is in flight", async () => {
    let releasePrompt: () => void = () => undefined;
    mocked.promptAsync.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releasePrompt = () => resolve({});
        }),
    );
    const runtime = new SessionPromptQueueRuntime();
    runtime.initialize({ api: { sendMessage: vi.fn() } } as never, 123);
    await vi.waitFor(() => expect(mocked.promptAsync).toHaveBeenCalledOnce());

    mocked.loopStatus = "stopped";
    releasePrompt();

    await vi.waitFor(() =>
      expect(mocked.abort).toHaveBeenCalledWith({ sessionID: "session-1", directory: "/one" }),
    );
    expect(mocked.clearRun).toHaveBeenCalledWith(
      "session-1",
      "queued_loop_stopped_after_dispatch",
    );
    expect(mocked.remove).toHaveBeenCalledWith("first");
    runtime.shutdown();
  });
});
