import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Context } from "grammy";
import type { Event } from "@opencode-ai/sdk/v2";
import { setRuntimeMode } from "../../../src/runtime/mode.js";
import { resetSingletonState } from "../../helpers/reset-singleton-state.js";

const mocked = vi.hoisted(() => ({
  subscribeToEvents: vi.fn(),
  stopEventListening: vi.fn(),
  missionSessionIdle: vi.fn(),
  missionSessionError: vi.fn(),
  missionPermissionRequest: vi.fn(),
  setMissionPermissionRecovery: vi.fn(),
  missionPermissionRecoveryCallback: null as ((recovery: unknown) => Promise<void>) | null,
  setMissionSessionFailure: vi.fn(),
  missionSessionFailureCallback: null as ((failure: unknown) => Promise<void>) | null,
  sessionMessages: vi.fn(),
}));

vi.mock("../../../src/opencode/events.js", () => ({
  subscribeToEvents: mocked.subscribeToEvents,
  stopEventListening: mocked.stopEventListening,
}));

vi.mock("../../../src/app/services/mission-runtime-service.js", () => ({
  missionRuntime: {
    handleSessionIdle: mocked.missionSessionIdle,
    handleSessionError: mocked.missionSessionError,
    handlePermissionRequest: mocked.missionPermissionRequest,
    setOnPermissionRecovery: mocked.setMissionPermissionRecovery,
    setOnSessionFailure: mocked.setMissionSessionFailure,
  },
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: { messages: mocked.sessionMessages },
  },
}));

type FakeBotApi = {
  sendMessage: ReturnType<typeof vi.fn>;
  sendMessageDraft: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
  deleteMessage: ReturnType<typeof vi.fn>;
  sendDocument: ReturnType<typeof vi.fn>;
};

function createFakeBot(): { bot: Bot<Context>; api: FakeBotApi } {
  const api: FakeBotApi = {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 100 }),
    sendMessageDraft: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    sendDocument: vi.fn().mockResolvedValue({ message_id: 101 }),
  };

  return { bot: { api } as unknown as Bot<Context>, api };
}

function emitAssistantMessage(summaryAggregator: { processEvent(event: Event): void }): void {
  summaryAggregator.processEvent({
    type: "message.updated",
    properties: {
      info: {
        id: "message-1",
        sessionID: "session-1",
        role: "assistant",
        time: { created: Date.now() },
      },
    },
  } as unknown as Event);
}

function emitWriteTool(summaryAggregator: { processEvent(event: Event): void }): void {
  summaryAggregator.processEvent({
    type: "message.part.updated",
    properties: {
      part: {
        id: "part-1",
        sessionID: "session-1",
        messageID: "message-1",
        type: "tool",
        callID: "call-write",
        tool: "write",
        state: {
          status: "completed",
          input: {
            filePath: "src/file.ts",
            content: "const value = 1;\n",
          },
          metadata: {},
        },
      },
    },
  } as unknown as Event);
}

function emitThinkingPart(
  summaryAggregator: { processEvent(event: Event): void },
  text: string,
): void {
  summaryAggregator.processEvent({
    type: "message.part.updated",
    properties: {
      part: {
        id: "reasoning-1",
        sessionID: "session-1",
        messageID: "message-1",
        type: "reasoning",
        text,
      },
    },
  } as unknown as Event);
}

function emitAssistantTextPart(
  summaryAggregator: { processEvent(event: Event): void },
  text: string,
): void {
  summaryAggregator.processEvent({
    type: "message.part.updated",
    properties: {
      part: {
        id: "text-1",
        sessionID: "session-1",
        messageID: "message-1",
        type: "text",
        text,
      },
    },
  } as unknown as Event);
}

function emitAssistantCompleted(summaryAggregator: { processEvent(event: Event): void }): void {
  summaryAggregator.processEvent({
    type: "message.updated",
    properties: {
      info: {
        id: "message-1",
        sessionID: "session-1",
        role: "assistant",
        agent: "test-agent",
        providerID: "test-provider",
        modelID: "test-model",
        time: { created: Date.now() - 1000, completed: Date.now() },
      },
    },
  } as unknown as Event);
}

function emitSessionIdle(summaryAggregator: { processEvent(event: Event): void }): void {
  summaryAggregator.processEvent({
    type: "session.idle",
    properties: { sessionID: "session-1" },
  } as unknown as Event);
}

function emitPermissionAsked(
  summaryAggregator: { processEvent(event: Event): void },
  requestID: string,
  patterns: string[] = ["D:/shared/*"],
): void {
  summaryAggregator.processEvent({
    type: "permission.asked",
    properties: {
      id: requestID,
      sessionID: "session-1",
      permission: "external_directory",
      patterns,
      metadata: {},
      always: ["D:/shared/*"],
    },
  } as unknown as Event);
}

function emitPermissionReplied(
  summaryAggregator: { processEvent(event: Event): void },
  requestID: string,
): void {
  summaryAggregator.processEvent({
    type: "permission.replied",
    properties: {
      sessionID: "session-1",
      requestID,
      reply: "always",
    },
  } as unknown as Event);
}

describe("bot/services/event-subscription-service", () => {
  let tempHome: string;
  let activeService: { cleanup(reason: string): void } | null = null;

  beforeEach(async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-telegram-token");
    vi.stubEnv("TELEGRAM_ALLOWED_USER_ID", "123456789");
    vi.stubEnv("OPENCODE_MODEL_PROVIDER", "test-provider");
    vi.stubEnv("OPENCODE_MODEL_ID", "test-model");
    vi.stubEnv("RESPONSE_STREAM_THROTTLE_MS", "1");
    vi.stubEnv("OPENCODE_TELEGRAM_HOME", await mkdtemp(path.join(os.tmpdir(), "event-service-")));
    tempHome = process.env.OPENCODE_TELEGRAM_HOME!;
    setRuntimeMode("installed");

    mocked.subscribeToEvents.mockReset();
    mocked.stopEventListening.mockReset();
    mocked.missionSessionIdle.mockReset();
    mocked.missionSessionError.mockReset();
    mocked.missionPermissionRequest.mockReset().mockResolvedValue({ handled: false });
    mocked.missionPermissionRecoveryCallback = null;
    mocked.setMissionPermissionRecovery.mockReset().mockImplementation((callback) => {
      mocked.missionPermissionRecoveryCallback = callback;
    });
    mocked.missionSessionFailureCallback = null;
    mocked.setMissionSessionFailure.mockReset().mockImplementation((callback) => {
      mocked.missionSessionFailureCallback = callback;
    });
    mocked.sessionMessages.mockReset();
    mocked.subscribeToEvents.mockResolvedValue(undefined);

    const settingsStore = await import("../../../src/app/stores/settings-store.js");
    settingsStore.__resetSettingsForTests();
    await resetSingletonState();
  });

  afterEach(async () => {
    activeService?.cleanup("test_cleanup");
    activeService = null;

    const settingsStore = await import("../../../src/app/stores/settings-store.js");
    await settingsStore.flushSettings();
    settingsStore.__resetSettingsForTests();
    vi.unstubAllEnvs();
    await rm(tempHome, { recursive: true, force: true });
  });

  async function setupService(
    sendDiffFileAttachments: boolean,
    options: {
      responseStreamingMode?: "edit" | "draft";
      showThinkingContent?: boolean;
      showAssistantRunFooter?: boolean;
      startAssistantRun?: boolean;
      agentLoopId?: string;
      agentLoopRunStartedAt?: string;
    } = {},
  ): Promise<{
    api: FakeBotApi;
    summaryAggregator: { setSession(sessionId: string): void; processEvent(event: Event): void };
  }> {
    const [
      { createEventSubscriptionService },
      { summaryAggregator },
      sessionService,
      settingsStore,
      { assistantRunState },
    ] = await Promise.all([
        import("../../../src/bot/services/event-subscription-service.js"),
        import("../../../src/app/managers/summary-aggregation-manager.js"),
        import("../../../src/app/services/session-service.js"),
        import("../../../src/app/stores/settings-store.js"),
        import("../../../src/app/managers/assistant-run-state-manager.js"),
      ]);

    sessionService.setCurrentSession({
      id: "session-1",
      title: "Test session",
      directory: "D:/repo",
    });
    settingsStore.setCompactOutputMode(false);
    settingsStore.setSendDiffFileAttachments(sendDiffFileAttachments);
    settingsStore.setResponseStreamingMode(options.responseStreamingMode ?? "edit");
    settingsStore.setShowThinkingContent(options.showThinkingContent ?? true);
    settingsStore.setShowAssistantRunFooter(options.showAssistantRunFooter ?? true);

    const { bot, api } = createFakeBot();
    const service = createEventSubscriptionService();
    activeService = service;
    service.clearRuntimeState("test_setup");
    if (options.startAssistantRun) {
      assistantRunState.startRun("session-1", {
        startedAt: Date.now() - 1000,
        configuredAgent: "test-agent",
        configuredProviderID: "test-provider",
        configuredModelID: "test-model",
        ...(options.agentLoopId ? { agentLoopId: options.agentLoopId } : {}),
        ...(options.agentLoopRunStartedAt
          ? { agentLoopRunStartedAt: options.agentLoopRunStartedAt }
          : {}),
      });
    }
    service.setTelegramContext(bot, 42);
    await service.ensureEventSubscription("D:/repo");
    summaryAggregator.setSession("session-1");
    emitAssistantMessage(summaryAggregator);

    return { api, summaryAggregator };
  }

  it("sends write tool output as a document attachment when diff files are enabled", async () => {
    const { api, summaryAggregator } = await setupService(true);

    emitWriteTool(summaryAggregator);

    await vi.waitFor(() => {
      expect(api.sendDocument).toHaveBeenCalledTimes(1);
    });
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("streams write tool call text without document attachment when diff files are disabled", async () => {
    const { api, summaryAggregator } = await setupService(false);

    emitWriteTool(summaryAggregator);
    emitSessionIdle(summaryAggregator);

    await vi.waitFor(
      () => {
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
      },
      { timeout: 3000 },
    );
    expect(api.sendMessage.mock.calls[0][1]).toContain("write");
    expect(api.sendDocument).not.toHaveBeenCalled();
  });

  it("uses edit streaming for visible thinking content when assistant responses use draft mode", async () => {
    const { api, summaryAggregator } = await setupService(true, {
      responseStreamingMode: "draft",
      showThinkingContent: true,
    });

    emitThinkingPart(summaryAggregator, "First thought");

    await vi.waitFor(
      () => {
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
      },
      { timeout: 3000 },
    );

    emitThinkingPart(summaryAggregator, "First thought\nSecond thought");

    await vi.waitFor(
      () => {
        expect(api.editMessageText).toHaveBeenCalledTimes(1);
      },
      { timeout: 3000 },
    );
    expect(api.sendMessageDraft).not.toHaveBeenCalled();
  });

  it("keeps hidden thinking as a separate non-draft message", async () => {
    const { api, summaryAggregator } = await setupService(true, {
      responseStreamingMode: "draft",
      showThinkingContent: false,
    });

    emitThinkingPart(summaryAggregator, "Hidden thought");

    await vi.waitFor(() => {
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
    });
    expect(api.editMessageText).not.toHaveBeenCalled();
    expect(api.sendMessageDraft).not.toHaveBeenCalled();
  });

  it("does not send assistant run footer when it is disabled", async () => {
    const { api, summaryAggregator } = await setupService(true, {
      responseStreamingMode: "edit",
      showAssistantRunFooter: false,
      startAssistantRun: true,
    });

    emitAssistantTextPart(summaryAggregator, "Final answer");
    emitAssistantCompleted(summaryAggregator);
    emitSessionIdle(summaryAggregator);

    await vi.waitFor(
      () => {
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
      },
      { timeout: 3000 },
    );
    expect(api.sendMessage.mock.calls[0][1]).toBe("Final answer");
  });

  it("forwards a terminal marker to the originating agent loop", async () => {
    const { agentLoopRuntime } = await import(
      "../../../src/app/services/agent-loop-runtime-service.js"
    );
    const handleAssistantResponse = vi
      .spyOn(agentLoopRuntime, "handleAssistantResponse")
      .mockResolvedValue(true);
    const { summaryAggregator } = await setupService(true, {
      startAssistantRun: true,
      agentLoopId: "loop-1",
      agentLoopRunStartedAt: "run-1",
    });

    emitAssistantTextPart(summaryAggregator, "STOP_LOOP_REASON_TERMINAL");
    emitAssistantCompleted(summaryAggregator);

    await vi.waitFor(() => {
      expect(handleAssistantResponse).toHaveBeenCalledWith(
        "loop-1",
        "STOP_LOOP_REASON_TERMINAL",
        "run-1",
      );
    });
    handleAssistantResponse.mockRestore();
  });

  it("forwards terminal markers from background loop sessions", async () => {
    const { agentLoopRuntime } = await import(
      "../../../src/app/services/agent-loop-runtime-service.js"
    );
    const handleAssistantResponse = vi
      .spyOn(agentLoopRuntime, "handleAssistantResponse")
      .mockResolvedValue(true);
    await setupService(true);
    const { assistantRunState } = await import(
      "../../../src/app/managers/assistant-run-state-manager.js"
    );
    assistantRunState.startRun("background-session", {
      startedAt: Date.now(),
      agentLoopId: "loop-1",
      agentLoopRunStartedAt: "run-1",
    });
    mocked.sessionMessages.mockResolvedValue({
      data: [
        {
          info: { id: "message-1", role: "assistant" },
          parts: [{ type: "text", text: "STOP_LOOP_REASON_TERMINAL" }],
        },
      ],
      error: null,
    });
    const eventCallback = mocked.subscribeToEvents.mock.calls.at(-1)?.[1] as
      | ((event: Event) => void)
      | undefined;

    eventCallback!({
      type: "message.updated",
      properties: {
        info: {
          id: "message-1",
          sessionID: "background-session",
          role: "assistant",
          time: { completed: Date.now() },
        },
      },
    } as unknown as Event);

    await vi.waitFor(() =>
      expect(handleAssistantResponse).toHaveBeenCalledWith(
        "loop-1",
        "STOP_LOOP_REASON_TERMINAL",
        "run-1",
      ),
    );
    handleAssistantResponse.mockRestore();
  });

  it("notifies the final draft response when assistant run footer is disabled", async () => {
    const { api, summaryAggregator } = await setupService(true, {
      responseStreamingMode: "draft",
      showAssistantRunFooter: false,
      startAssistantRun: true,
    });

    emitAssistantTextPart(summaryAggregator, "Final answer");
    emitAssistantCompleted(summaryAggregator);
    emitSessionIdle(summaryAggregator);

    await vi.waitFor(
      () => {
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
      },
      { timeout: 3000 },
    );
    expect(api.sendMessage.mock.calls[0][1]).toBe("Final answer");
    expect(api.sendMessage.mock.calls[0][2]?.disable_notification).toBeUndefined();
    expect(api.sendMessageDraft).not.toHaveBeenCalled();
  });

  it("keeps the final draft response silent when assistant run footer is enabled", async () => {
    const { api, summaryAggregator } = await setupService(true, {
      responseStreamingMode: "draft",
      showAssistantRunFooter: true,
      startAssistantRun: true,
    });

    emitAssistantTextPart(summaryAggregator, "Final answer");
    emitAssistantCompleted(summaryAggregator);
    emitSessionIdle(summaryAggregator);

    await vi.waitFor(
      () => {
        expect(api.sendMessage).toHaveBeenCalledTimes(2);
      },
      { timeout: 3000 },
    );
    expect(api.sendMessage.mock.calls[0][1]).toBe("Final answer");
    expect(api.sendMessage.mock.calls[0][2]).toEqual({ disable_notification: true });
    expect(api.sendMessage.mock.calls[1][1]).toContain("test-provider/test-model");
    expect(api.sendMessageDraft).not.toHaveBeenCalled();
  });

  it("sends the run footer when session idle arrives before assistant completion", async () => {
    const { api, summaryAggregator } = await setupService(true, {
      responseStreamingMode: "edit",
      showAssistantRunFooter: true,
      startAssistantRun: true,
    });

    emitAssistantTextPart(summaryAggregator, "Final answer");
    emitSessionIdle(summaryAggregator);
    await new Promise<void>((resolve) => setImmediate(resolve));
    emitAssistantCompleted(summaryAggregator);

    await vi.waitFor(
      () => {
        expect(api.sendMessage).toHaveBeenCalledTimes(2);
      },
      { timeout: 3000 },
    );
    expect(api.sendMessage.mock.calls[0][1]).toBe("Final answer");
    expect(api.sendMessage.mock.calls[1][1]).toContain("test-provider/test-model");
  });

  it("does not stream scheduled-run events from a bound session", async () => {
    const { api } = await setupService(true);
    const { markScheduledTaskSessionActive } = await import(
      "../../../src/app/managers/scheduled-task-active-session-manager.js"
    );
    markScheduledTaskSessionActive("session-1");
    const eventCallback = mocked.subscribeToEvents.mock.calls.at(-1)?.[1] as
      | ((event: Event) => void)
      | undefined;
    expect(eventCallback).toBeTypeOf("function");

    eventCallback!({
      type: "message.part.updated",
      properties: {
        part: {
          id: "scheduled-text",
          sessionID: "session-1",
          messageID: "scheduled-message",
          type: "text",
          text: "Scheduled result",
        },
      },
    } as unknown as Event);
    eventCallback!({
      type: "message.updated",
      properties: {
        info: {
          id: "scheduled-message",
          sessionID: "session-1",
          role: "assistant",
          time: { created: Date.now(), completed: Date.now() },
        },
      },
    } as unknown as Event);
    eventCallback!({
      type: "session.idle",
      properties: { sessionID: "session-1" },
    } as unknown as Event);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("forwards raw child-session completion events to mission runtime", async () => {
    await setupService(true);
    const eventCallback = mocked.subscribeToEvents.mock.calls.at(-1)?.[1] as
      | ((event: Event) => void)
      | undefined;

    eventCallback!({
      type: "session.idle",
      properties: { sessionID: "child-session" },
    } as unknown as Event);
    eventCallback!({
      type: "session.error",
      properties: {
        sessionID: "failed-child",
        error: { data: { message: "child failed" } },
      },
    } as unknown as Event);

    await vi.waitFor(() => {
      expect(mocked.missionSessionIdle).toHaveBeenCalledWith("child-session");
      expect(mocked.missionSessionError).toHaveBeenCalledWith("failed-child", "child failed");
    });
  });

  it("suppresses mission access prompts and notifies about the relaunched agent", async () => {
    const { api } = await setupService(true);
    const recovery = {
      handled: true,
      outcome: "relaunched",
      sessionTitle: "Worker",
      retry: 1,
      retryLimit: 2,
    };
    mocked.missionPermissionRequest.mockImplementation(async () => {
      await mocked.missionPermissionRecoveryCallback?.(recovery);
      return recovery;
    });
    const eventCallback = mocked.subscribeToEvents.mock.calls.at(-1)?.[1] as
      ((event: Event) => void) | undefined;

    eventCallback!({
      type: "permission.asked",
      properties: {
        id: "permission-1",
        sessionID: "mission-session",
        permission: "external_directory",
        patterns: ["/parent/*"],
        metadata: {},
        always: [],
      },
    } as unknown as Event);

    await vi.waitFor(() => {
      expect(mocked.missionPermissionRequest).toHaveBeenCalled();
      expect(api.sendMessage).toHaveBeenCalledWith(42, expect.stringContaining("🔴"));
    });
    const { permissionManager } = await import("../../../src/app/managers/permission-manager.js");
    expect(permissionManager.isActive()).toBe(false);
  });

  it("sends a red notification when one mission session fails locally", async () => {
    const { api } = await setupService(true);

    await mocked.missionSessionFailureCallback?.({
      sessionTitle: "Worker",
      message: "model unavailable",
    });

    expect(api.sendMessage).toHaveBeenCalledWith(
      42,
      expect.stringMatching(/🔴.*Worker.*model unavailable/),
    );
  });

  it("clears permission prompts when OpenCode resolves pending requests", async () => {
    const { api, summaryAggregator } = await setupService(true);
    const [{ permissionManager }, { interactionManager }] = await Promise.all([
      import("../../../src/app/managers/permission-manager.js"),
      import("../../../src/app/managers/interaction-manager.js"),
    ]);
    api.sendMessage
      .mockResolvedValueOnce({ message_id: 500 })
      .mockResolvedValueOnce({ message_id: 501 });

    emitPermissionAsked(summaryAggregator, "permission-1");
    emitPermissionAsked(summaryAggregator, "permission-2", ["D:/other/*"]);

    await vi.waitFor(() => {
      expect(permissionManager.getPendingCount()).toBe(2);
    });

    emitPermissionReplied(summaryAggregator, "permission-2");

    await vi.waitFor(() => {
      expect(permissionManager.getPendingCount()).toBe(1);
    });
    expect(api.deleteMessage).toHaveBeenCalledWith(42, 501);
    expect(permissionManager.getRequestID(500)).toBe("permission-1");
    expect(interactionManager.getSnapshot()?.metadata.pendingCount).toBe(1);

    emitPermissionReplied(summaryAggregator, "permission-1");

    await vi.waitFor(() => {
      expect(permissionManager.isActive()).toBe(false);
      expect(interactionManager.getSnapshot()).toBeNull();
    });
    expect(api.deleteMessage).toHaveBeenCalledWith(42, 500);
  });

  it("discards a permission prompt resolved while its Telegram message is being sent", async () => {
    const { api, summaryAggregator } = await setupService(true);
    const [{ permissionManager }, { interactionManager }] = await Promise.all([
      import("../../../src/app/managers/permission-manager.js"),
      import("../../../src/app/managers/interaction-manager.js"),
    ]);
    let resolveSend: (message: { message_id: number }) => void = () => {};
    const pendingSend = new Promise<{ message_id: number }>((resolve) => {
      resolveSend = resolve;
    });
    api.sendMessage.mockReturnValueOnce(pendingSend);

    emitPermissionAsked(summaryAggregator, "permission-race");
    await vi.waitFor(() => {
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
    });

    emitPermissionReplied(summaryAggregator, "permission-race");
    await vi.waitFor(() => {
      expect(permissionManager.isResolved("permission-race")).toBe(true);
    });

    resolveSend({ message_id: 502 });

    await vi.waitFor(() => {
      expect(api.deleteMessage).toHaveBeenCalledWith(42, 502);
    });
    expect(permissionManager.isActive()).toBe(false);
    expect(interactionManager.getSnapshot()).toBeNull();
  });

  it("does not replace a newer interaction when a permission is resolved", async () => {
    const { api, summaryAggregator } = await setupService(true);
    const [{ permissionManager }, { interactionManager }] = await Promise.all([
      import("../../../src/app/managers/permission-manager.js"),
      import("../../../src/app/managers/interaction-manager.js"),
    ]);
    api.sendMessage
      .mockResolvedValueOnce({ message_id: 510 })
      .mockResolvedValueOnce({ message_id: 511 });
    emitPermissionAsked(summaryAggregator, "permission-1");
    emitPermissionAsked(summaryAggregator, "permission-2", ["D:/other/*"]);
    await vi.waitFor(() => {
      expect(permissionManager.getPendingCount()).toBe(2);
    });
    interactionManager.start({ kind: "rename", expectedInput: "text" });

    emitPermissionReplied(summaryAggregator, "permission-2");

    await vi.waitFor(() => {
      expect(permissionManager.getPendingCount()).toBe(1);
    });
    expect(interactionManager.getSnapshot()?.kind).toBe("rename");
  });
});
