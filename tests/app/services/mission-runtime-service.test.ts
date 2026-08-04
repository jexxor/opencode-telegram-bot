import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mission } from "../../../src/app/types/mission.js";

const mocked = vi.hoisted(() => ({
  missions: [] as Mission[],
  prompts: [] as string[],
  promptDirectories: [] as string[],
  promptTexts: [] as string[],
  activePrompts: new Set<string>(),
  externallyBusy: new Set<string>(),
  promptErrors: new Set<string>(),
  completedPrompts: new Set<string>(),
  toolCallOnlyCompletions: new Set<string>(),
  autoComplete: true,
  maxActivePrompts: 0,
  onPromptCompleted: null as ((sessionId: string) => void) | null,
  promptGateSession: null as string | null,
  releasePrompt: null as (() => void) | null,
  children: vi.fn(),
  sessionGet: vi.fn(),
  permissionList: vi.fn(),
  permissionReply: vi.fn(),
  abort: vi.fn(),
}));

vi.mock("../../../src/config.js", () => ({
  config: { bot: { missionConcurrencyLimit: 2 } },
}));
vi.mock("../../../src/app/services/agent-selection-service.js", () => ({
  getStoredAgent: () => "build",
  resolveProjectAgent: async () => "build",
}));
vi.mock("../../../src/app/services/model-selection-service.js", () => ({
  getStoredModel: () => ({ providerID: "openai", modelID: "gpt-5", variant: null }),
}));
vi.mock("../../../src/app/stores/mission-store.js", () => ({
  listMissions: () => structuredClone(mocked.missions),
  getMission: (id: string) => {
    const mission = mocked.missions.find((item) => item.id === id);
    return mission ? structuredClone(mission) : null;
  },
  updateMission: async (id: string, updater: (mission: Mission) => Mission) => {
    const index = mocked.missions.findIndex((mission) => mission.id === id);
    if (index < 0) return null;
    mocked.missions[index] = structuredClone(updater(structuredClone(mocked.missions[index])));
    return structuredClone(mocked.missions[index]);
  },
  removeMissionCascade: vi.fn(async () => true),
}));
vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: {
      children: mocked.children,
      get: mocked.sessionGet,
      status: vi.fn(async () => {
        const data: Record<string, { type: string }> = {};
        for (const sessionId of [...mocked.externallyBusy, ...mocked.activePrompts]) {
          data[sessionId] = { type: "busy" };
        }
        return { data, error: null };
      }),
      promptAsync: vi.fn(
        async ({
          sessionID,
          directory,
          parts,
        }: {
          sessionID: string;
          directory: string;
          parts: Array<{ text: string }>;
        }) => {
          mocked.prompts.push(sessionID);
          mocked.promptDirectories.push(directory);
          mocked.promptTexts.push(parts[0].text);
          mocked.completedPrompts.delete(sessionID);
          if (mocked.promptGateSession === sessionID) {
            await new Promise<void>((resolve) => {
              mocked.releasePrompt = resolve;
            });
          }
          if (mocked.promptErrors.has(sessionID)) return { error: new Error("prompt failed") };
          mocked.activePrompts.add(sessionID);
          mocked.maxActivePrompts = Math.max(mocked.maxActivePrompts, mocked.activePrompts.size);
          if (mocked.autoComplete) {
            setTimeout(() => {
              mocked.activePrompts.delete(sessionID);
              mocked.completedPrompts.add(sessionID);
              mocked.onPromptCompleted?.(sessionID);
            }, 10);
          }
          return { error: null };
        },
      ),
      messages: vi.fn(async ({ sessionID }: { sessionID: string }) => ({
        data: mocked.completedPrompts.has(sessionID)
          ? [
              {
                info: {
                  role: "assistant",
                  time: { created: Date.now(), completed: Date.now() },
                  finish: mocked.toolCallOnlyCompletions.has(sessionID) ? "tool-calls" : "stop",
                },
                parts: [{ type: "text", text: "Complete" }],
              },
            ]
          : [],
        error: null,
      })),
      abort: mocked.abort,
    },
    permission: {
      list: mocked.permissionList,
      reply: mocked.permissionReply,
    },
  },
}));

import { MissionRuntime } from "../../../src/app/services/mission-runtime-service.js";

function createMission(id: string, subMissionIds: string[], rootSessionId: string): Mission {
  return {
    id,
    projectId: "project-1",
    projectWorktree: "/repo",
    name: id,
    description: "",
    subMissionIds,
    rootSessions: [{ id: rootSessionId, title: rootSessionId, directory: "/repo" }],
    status: "idle",
    requestedRuns: 1,
    completedRuns: 0,
    totalSessionRuns: 0,
    failedSessionRuns: 0,
    timeoutMinutes: null,
    runStartedAt: null,
    runFinishedAt: null,
    lastError: null,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
}

describe("MissionRuntime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocked.missions = [
      createMission("root", ["child", "child"], "root-session"),
      createMission("child", [], "child-root"),
    ];
    mocked.prompts = [];
    mocked.promptDirectories = [];
    mocked.promptTexts = [];
    mocked.activePrompts.clear();
    mocked.externallyBusy.clear();
    mocked.promptErrors.clear();
    mocked.completedPrompts.clear();
    mocked.toolCallOnlyCompletions.clear();
    mocked.autoComplete = true;
    mocked.maxActivePrompts = 0;
    mocked.onPromptCompleted = null;
    mocked.promptGateSession = null;
    mocked.releasePrompt = null;
    mocked.children.mockReset().mockResolvedValue({ data: [], error: null });
    mocked.sessionGet.mockReset().mockResolvedValue({ data: null, error: null });
    mocked.permissionList.mockReset().mockResolvedValue({ data: [], error: null });
    mocked.permissionReply.mockReset().mockResolvedValue({ data: true, error: null });
    mocked.abort.mockReset().mockImplementation(async ({ sessionID }: { sessionID: string }) => {
      mocked.activePrompts.delete(sessionID);
      return { data: true, error: null };
    });
  });

  it("runs every duplicate leaf occurrence before the parent level", async () => {
    const runtime = new MissionRuntime();
    mocked.onPromptCompleted = (sessionId) => runtime.handleSessionIdle(sessionId);
    await runtime.run("root", { timeoutMinutes: null, runs: 1, prompt: "Custom mission prompt" });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(mocked.prompts).not.toContain("child-leaf");
    expect(mocked.prompts.filter((id) => id === "child-root")).toHaveLength(2);
    expect(mocked.prompts.at(-1)).toBe("root-session");
    expect(mocked.children).not.toHaveBeenCalled();
    expect(mocked.missions[0]).toMatchObject({
      status: "completed",
      completedRuns: 1,
      totalSessionRuns: 3,
    });
    expect(mocked.missions[1]).toMatchObject({
      status: "completed",
      requestedRuns: 2,
      completedRuns: 2,
      totalSessionRuns: 2,
    });
    expect(mocked.maxActivePrompts).toBe(1);
    expect(mocked.promptTexts.every((text) => text === "Custom mission prompt")).toBe(true);
    await runtime.shutdown();
    vi.useRealTimers();
  });

  it("starts all leaves together and enforces global barriers between mission levels", async () => {
    mocked.missions = [
      createMission("root", ["deep-parent", "shallow-leaf"], "root-session"),
      createMission("deep-parent", ["deep-leaf"], "deep-parent-session"),
      createMission("deep-leaf", [], "deep-leaf-session"),
      createMission("shallow-leaf", [], "shallow-leaf-session"),
    ];
    const runtime = new MissionRuntime();
    mocked.onPromptCompleted = (sessionId) => runtime.handleSessionIdle(sessionId);

    await runtime.run("root", { timeoutMinutes: null, runs: 1, prompt: "Shared prompt" });
    await vi.advanceTimersByTimeAsync(10_000);

    const deepLeafIndex = mocked.prompts.indexOf("deep-leaf-session");
    const shallowLeafIndex = mocked.prompts.indexOf("shallow-leaf-session");
    const deepParentIndex = mocked.prompts.indexOf("deep-parent-session");
    const rootIndex = mocked.prompts.indexOf("root-session");
    expect(deepLeafIndex).toBeGreaterThanOrEqual(0);
    expect(shallowLeafIndex).toBeGreaterThanOrEqual(0);
    expect(deepParentIndex).toBeGreaterThan(Math.max(deepLeafIndex, shallowLeafIndex));
    expect(rootIndex).toBeGreaterThan(deepParentIndex);
    expect(mocked.maxActivePrompts).toBe(2);
    expect(mocked.missions.every((mission) => mission.status === "completed")).toBe(true);
    await runtime.shutdown();
    vi.useRealTimers();
  });

  it("completes an empty mission without starting sessions", async () => {
    mocked.missions = [createMission("empty", [], "unused")];
    mocked.missions[0].rootSessions = [];
    const runtime = new MissionRuntime();

    await runtime.run("empty", { timeoutMinutes: null, runs: 1, prompt: "Unused prompt" });
    await vi.advanceTimersByTimeAsync(0);

    expect(mocked.prompts).toEqual([]);
    expect(mocked.missions[0]).toMatchObject({
      status: "completed",
      completedRuns: 1,
      totalSessionRuns: 0,
    });
    await runtime.shutdown();
    vi.useRealTimers();
  });

  it("runs a mission without root sessions as a logical connector", async () => {
    mocked.missions = [
      createMission("connector", ["worker"], "unused"),
      createMission("worker", [], "worker-session"),
    ];
    mocked.missions[0].rootSessions = [];
    const runtime = new MissionRuntime();
    mocked.onPromptCompleted = (sessionId) => runtime.handleSessionIdle(sessionId);

    await runtime.run("connector", { timeoutMinutes: null, runs: 1, prompt: "Shared prompt" });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(mocked.prompts).toEqual(["worker-session"]);
    expect(mocked.missions[0]).toMatchObject({
      status: "completed",
      completedRuns: 1,
      totalSessionRuns: 1,
    });
    expect(mocked.missions[1]).toMatchObject({ status: "completed", completedRuns: 1 });
    await runtime.shutdown();
    vi.useRealTimers();
  });

  it("executes every duplicate occurrence of multiple sub-missions", async () => {
    mocked.missions = [
      createMission(
        "root",
        ["review", "review", "coding", "coding", "coding"],
        "parent-session",
      ),
      createMission("review", [], "review-session"),
      createMission("coding", [], "coding-session"),
    ];
    const runtime = new MissionRuntime();
    mocked.onPromptCompleted = (sessionId) => runtime.handleSessionIdle(sessionId);

    await runtime.run("root", { timeoutMinutes: null, runs: 1, prompt: "Shared prompt" });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mocked.prompts.filter((id) => id === "review-session")).toHaveLength(2);
    expect(mocked.prompts.filter((id) => id === "coding-session")).toHaveLength(3);
    expect(mocked.prompts.at(-1)).toBe("parent-session");
    expect(mocked.missions[1]).toMatchObject({ requestedRuns: 2, completedRuns: 2 });
    expect(mocked.missions[2]).toMatchObject({ requestedRuns: 3, completedRuns: 3 });
    expect(mocked.missions[0]).toMatchObject({ status: "completed", totalSessionRuns: 6 });
    await runtime.shutdown();
    vi.useRealTimers();
  });

  it("completes sessions from multiple directories through message polling", async () => {
    mocked.missions = [createMission("root", [], "unused")];
    mocked.missions[0].rootSessions = [
      { id: "repo-a", title: "Repo A", directory: "/repo-a" },
      { id: "repo-b", title: "Repo B", directory: "/repo-b" },
      { id: "repo-c", title: "Repo C", directory: "/repo-c" },
    ];
    const runtime = new MissionRuntime();
    await runtime.run("root", { timeoutMinutes: null, runs: 1, prompt: "Cross-project prompt" });

    await vi.advanceTimersByTimeAsync(2_000);

    expect(mocked.promptDirectories).toEqual(
      expect.arrayContaining(["/repo-a", "/repo-b", "/repo-c"]),
    );
    expect(mocked.missions[0]).toMatchObject({ status: "completed", totalSessionRuns: 3 });
    expect(mocked.maxActivePrompts).toBe(2);
    await runtime.shutdown();
    vi.useRealTimers();
  });

  it("completes the root after sub-mission tool calls become idle without idle events", async () => {
    mocked.missions = [
      createMission("root", ["worker"], "unused"),
      createMission("worker", [], "worker-session"),
    ];
    mocked.missions[0].rootSessions = [];
    mocked.toolCallOnlyCompletions.add("worker-session");
    const runtime = new MissionRuntime();

    await runtime.run("root", { timeoutMinutes: null, runs: 1, prompt: "Delegate work" });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(mocked.missions[0]).toMatchObject({
      status: "completed",
      completedRuns: 1,
      totalSessionRuns: 1,
      timeoutMinutes: null,
    });
    expect(mocked.missions[1]).toMatchObject({ status: "completed", completedRuns: 1 });
    await runtime.shutdown();
    vi.useRealTimers();
  });

  it("completes every requested run when tool-call idle events are missing", async () => {
    mocked.missions = [createMission("root", [], "root-session")];
    mocked.toolCallOnlyCompletions.add("root-session");
    const runtime = new MissionRuntime();

    await runtime.run("root", { timeoutMinutes: null, runs: 3, prompt: "Repeated work" });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mocked.prompts).toEqual(["root-session", "root-session", "root-session"]);
    expect(mocked.missions[0]).toMatchObject({
      status: "completed",
      requestedRuns: 3,
      completedRuns: 3,
      totalSessionRuns: 3,
      timeoutMinutes: null,
    });
    await runtime.shutdown();
    vi.useRealTimers();
  });

  it("completes tool-call sessions normally with a positive timeout", async () => {
    mocked.missions = [createMission("root", [], "root-session")];
    mocked.toolCallOnlyCompletions.add("root-session");
    const runtime = new MissionRuntime();

    await runtime.run("root", { timeoutMinutes: 5, runs: 1, prompt: "Timed work" });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(mocked.missions[0]).toMatchObject({
      status: "completed",
      completedRuns: 1,
      totalSessionRuns: 1,
      timeoutMinutes: 5,
    });
    expect(mocked.abort).not.toHaveBeenCalled();
    await runtime.shutdown();
    vi.useRealTimers();
  });

  it("rejects and relaunches only the requesting mission session twice", async () => {
    mocked.missions = [createMission("root", [], "root-session")];
    mocked.autoComplete = false;
    const runtime = new MissionRuntime();
    await runtime.run("root", { timeoutMinutes: null, runs: 1, prompt: "Original mission" });
    await vi.advanceTimersByTimeAsync(0);

    const first = await runtime.handlePermissionRequest(
      { id: "permission-1", sessionID: "root-session", permission: "external_directory" },
      "/repo",
    );
    const second = await runtime.handlePermissionRequest(
      { id: "permission-2", sessionID: "root-session", permission: "external_directory" },
      "/repo",
    );
    const third = await runtime.handlePermissionRequest(
      { id: "permission-3", sessionID: "root-session", permission: "external_directory" },
      "/repo",
    );
    await vi.advanceTimersByTimeAsync(1_000);

    expect(first).toMatchObject({ handled: true, outcome: "relaunched", retry: 1, retryLimit: 2 });
    expect(second).toMatchObject({ handled: true, outcome: "relaunched", retry: 2, retryLimit: 2 });
    expect(third).toMatchObject({ handled: true, outcome: "dropped", retry: 3, retryLimit: 2 });
    expect(mocked.permissionReply).toHaveBeenCalledTimes(3);
    expect(mocked.promptTexts).toEqual([
      "Original mission",
      expect.stringContaining("read ROLE.md"),
      expect.stringContaining("read ROLE.md"),
    ]);
    expect(mocked.missions[0]).toMatchObject({
      status: "completed",
      completedRuns: 1,
      totalSessionRuns: 0,
      failedSessionRuns: 1,
    });
    vi.useRealTimers();
  });

  it("continues sibling agents after dropping an access offender", async () => {
    mocked.missions = [createMission("root", [], "unused")];
    mocked.missions[0].rootSessions = [
      { id: "offender", title: "Offender", directory: "/repo" },
      { id: "sibling", title: "Sibling", directory: "/repo" },
    ];
    const runtime = new MissionRuntime();
    await runtime.run("root", { timeoutMinutes: null, runs: 1, prompt: "Shared mission" });
    await vi.advanceTimersByTimeAsync(0);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await runtime.handlePermissionRequest(
        {
          id: `permission-${attempt}`,
          sessionID: "offender",
          permission: "external_directory",
        },
        "/repo",
      );
    }
    await vi.advanceTimersByTimeAsync(2_000);

    expect(mocked.abort).not.toHaveBeenCalledWith({ sessionID: "sibling", directory: "/repo" });
    expect(mocked.missions[0]).toMatchObject({
      status: "completed",
      completedRuns: 1,
      totalSessionRuns: 1,
      failedSessionRuns: 1,
    });
    vi.useRealTimers();
  });

  it("relaunches the child session that requested mission-tree access", async () => {
    mocked.missions = [createMission("root", [], "root-session")];
    mocked.autoComplete = false;
    mocked.sessionGet.mockResolvedValue({
      data: {
        id: "child-session",
        title: "Child agent",
        directory: "/repo",
        parentID: "root-session",
      },
      error: null,
    });
    const runtime = new MissionRuntime();
    await runtime.run("root", { timeoutMinutes: null, runs: 1, prompt: "Original mission" });
    await vi.advanceTimersByTimeAsync(0);

    const result = await runtime.handlePermissionRequest(
      { id: "child-permission", sessionID: "child-session", permission: "external_directory" },
      "/repo",
    );

    expect(result).toMatchObject({
      handled: true,
      outcome: "relaunched",
      sessionTitle: "Child agent",
      retry: 1,
    });
    expect(mocked.prompts).toEqual(["root-session", "child-session"]);
    expect(mocked.abort).toHaveBeenCalledWith({ sessionID: "child-session", directory: "/repo" });
    await runtime.stop("root");
    expect(
      mocked.abort.mock.calls.filter(([input]) => input.sessionID === "child-session"),
    ).toHaveLength(2);
    vi.useRealTimers();
  });

  it("drops a repeated child offender without aborting its parent root", async () => {
    mocked.missions = [createMission("root", [], "root-session")];
    mocked.sessionGet.mockResolvedValue({
      data: {
        id: "child-session",
        title: "Child agent",
        directory: "/repo",
        parentID: "root-session",
      },
      error: null,
    });
    const runtime = new MissionRuntime();
    await runtime.run("root", { timeoutMinutes: null, runs: 1, prompt: "Original mission" });
    await vi.advanceTimersByTimeAsync(0);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await runtime.handlePermissionRequest(
        {
          id: `child-permission-${attempt}`,
          sessionID: "child-session",
          permission: "external_directory",
        },
        "/repo",
      );
    }
    await vi.advanceTimersByTimeAsync(2_000);

    expect(mocked.abort).not.toHaveBeenCalledWith({ sessionID: "root-session", directory: "/repo" });
    expect(mocked.missions[0]).toMatchObject({
      status: "completed",
      completedRuns: 1,
      totalSessionRuns: 1,
      failedSessionRuns: 1,
    });
    vi.useRealTimers();
  });

  it("leaves access requests outside the active mission tree interactive", async () => {
    const runtime = new MissionRuntime();

    const result = await runtime.handlePermissionRequest(
      {
        id: "ordinary-permission",
        sessionID: "ordinary-session",
        permission: "external_directory",
      },
      "/repo",
    );

    expect(result).toEqual({ handled: false });
    expect(mocked.permissionReply).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("polls and rejects mission permissions without an event subscription", async () => {
    mocked.missions = [createMission("root", [], "root-session")];
    mocked.permissionList.mockResolvedValue({
      data: [
        {
          id: "polled-permission",
          sessionID: "root-session",
          permission: "external_directory",
        },
      ],
      error: null,
    });
    const onRecovery = vi.fn();
    const runtime = new MissionRuntime();
    runtime.setOnPermissionRecovery(onRecovery);

    await runtime.run("root", { timeoutMinutes: null, runs: 1, prompt: "Original mission" });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(mocked.permissionReply).toHaveBeenCalledTimes(1);
    expect(mocked.promptTexts).toEqual([
      "Original mission",
      expect.stringContaining("read ROLE.md"),
    ]);
    expect(onRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "relaunched", retry: 1, retryLimit: 2 }),
    );
    expect(mocked.missions[0].status).toBe("completed");
    await runtime.shutdown();
    vi.useRealTimers();
  });

  it("marks persisted active missions stopped during initialization", async () => {
    mocked.missions[0].status = "running";
    const runtime = new MissionRuntime();

    await runtime.initialize();

    expect(mocked.missions[0]).toMatchObject({
      status: "stopped",
      lastError: "Bot restarted during mission execution",
    });
    vi.useRealTimers();
  });

  it("does not start a prompt after stop while waiting for an externally busy session", async () => {
    mocked.missions = [createMission("root", [], "root-session")];
    mocked.externallyBusy.add("root-session");
    const runtime = new MissionRuntime();
    mocked.onPromptCompleted = (sessionId) => runtime.handleSessionIdle(sessionId);
    await runtime.run("root", { timeoutMinutes: null, runs: 1, prompt: "Custom prompt" });
    await vi.advanceTimersByTimeAsync(500);

    await runtime.stop("root");
    mocked.externallyBusy.clear();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(mocked.prompts).toEqual([]);
    expect(mocked.missions[0].status).toBe("stopped");
    vi.useRealTimers();
  });

  it("aborts again when stop races with an in-flight prompt request", async () => {
    mocked.missions = [createMission("root", [], "root-session")];
    mocked.promptGateSession = "root-session";
    mocked.autoComplete = false;
    const runtime = new MissionRuntime();
    await runtime.run("root", { timeoutMinutes: null, runs: 1, prompt: "Custom prompt" });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocked.releasePrompt).toBeTypeOf("function");

    await runtime.stop("root");
    mocked.releasePrompt!();
    await vi.advanceTimersByTimeAsync(500);

    expect(mocked.abort).toHaveBeenCalledTimes(2);
    expect(mocked.activePrompts.size).toBe(0);
    expect(mocked.missions[0].status).toBe("stopped");
    vi.useRealTimers();
  });

  it("does not start new work while paused and resumes from the same level", async () => {
    mocked.missions = [createMission("root", [], "root-session")];
    mocked.externallyBusy.add("root-session");
    const runtime = new MissionRuntime();
    mocked.onPromptCompleted = (sessionId) => runtime.handleSessionIdle(sessionId);
    await runtime.run("root", { timeoutMinutes: null, runs: 1, prompt: "Custom prompt" });
    await vi.advanceTimersByTimeAsync(500);

    await runtime.pause("root");
    mocked.externallyBusy.clear();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocked.prompts).toEqual([]);

    await runtime.resume("root");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocked.prompts).toEqual(["root-session"]);
    expect(mocked.missions[0].status).toBe("completed");
    vi.useRealTimers();
  });

  it("stops only the failed session and continues sibling agents", async () => {
    mocked.missions = [createMission("root", [], "unused")];
    mocked.missions[0].rootSessions = [
      { id: "slow", title: "Slow", directory: "/repo" },
      { id: "fail", title: "Fail", directory: "/repo" },
    ];
    mocked.promptErrors.add("fail");
    const runtime = new MissionRuntime();
    const onSessionFailure = vi.fn();
    runtime.setOnSessionFailure(onSessionFailure);
    await runtime.run("root", { timeoutMinutes: null, runs: 1, prompt: "Custom prompt" });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(mocked.missions[0]).toMatchObject({
      status: "completed",
      completedRuns: 1,
      totalSessionRuns: 1,
      failedSessionRuns: 1,
    });
    expect(mocked.abort).toHaveBeenCalledWith({ sessionID: "fail", directory: "/repo" });
    expect(mocked.abort).not.toHaveBeenCalledWith({ sessionID: "slow", directory: "/repo" });
    expect(onSessionFailure).toHaveBeenCalledWith({
      sessionTitle: "Fail",
      message: expect.stringContaining("prompt failed"),
    });
    expect(mocked.activePrompts.size).toBe(0);
    vi.useRealTimers();
  });

  it("continues parent mission levels after a child session fails", async () => {
    mocked.promptErrors.add("child-root");
    const runtime = new MissionRuntime();
    mocked.onPromptCompleted = (sessionId) => runtime.handleSessionIdle(sessionId);

    await runtime.run("root", { timeoutMinutes: null, runs: 1, prompt: "Custom prompt" });
    await vi.advanceTimersByTimeAsync(3_000);

    expect(mocked.prompts.filter((id) => id === "child-root")).toHaveLength(2);
    expect(mocked.prompts.at(-1)).toBe("root-session");
    expect(mocked.missions[0]).toMatchObject({
      status: "completed",
      totalSessionRuns: 1,
      failedSessionRuns: 2,
    });
    expect(mocked.missions[1]).toMatchObject({
      status: "completed",
      totalSessionRuns: 0,
      failedSessionRuns: 2,
    });
    vi.useRealTimers();
  });

  it("localizes session.error events to the failing agent", async () => {
    mocked.missions = [createMission("root", [], "unused")];
    mocked.missions[0].rootSessions = [
      { id: "failed", title: "Failed", directory: "/repo" },
      { id: "healthy", title: "Healthy", directory: "/repo" },
    ];
    mocked.autoComplete = false;
    const runtime = new MissionRuntime();
    const onSessionFailure = vi.fn();
    runtime.setOnSessionFailure(onSessionFailure);

    await runtime.run("root", { timeoutMinutes: null, runs: 1, prompt: "Custom prompt" });
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.handleSessionError("failed", "model unavailable")).toBe(true);
    expect(runtime.handleSessionIdle("healthy")).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(mocked.missions[0]).toMatchObject({
      status: "completed",
      totalSessionRuns: 1,
      failedSessionRuns: 1,
    });
    expect(mocked.abort).toHaveBeenCalledWith({ sessionID: "failed", directory: "/repo" });
    expect(mocked.abort).not.toHaveBeenCalledWith({ sessionID: "healthy", directory: "/repo" });
    expect(onSessionFailure).toHaveBeenCalledWith({
      sessionTitle: "Failed",
      message: "model unavailable",
    });
    vi.useRealTimers();
  });

  it("does not overflow Node timers for long mission timeouts", async () => {
    mocked.missions = [createMission("root", [], "root-session")];
    mocked.externallyBusy.add("root-session");
    const runtime = new MissionRuntime();
    await runtime.run("root", { timeoutMinutes: 40_000, runs: 1, prompt: "Custom prompt" });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(mocked.missions[0].status).toBe("running");
    expect(mocked.abort).not.toHaveBeenCalled();
    await runtime.shutdown();
    vi.useRealTimers();
  });

  it("propagates pause, resume, and stop status to active nested missions", async () => {
    mocked.missions = [
      createMission("root", ["child"], "root-session"),
      createMission("child", [], "child-root"),
    ];
    mocked.autoComplete = false;
    const runtime = new MissionRuntime();
    await runtime.run("root", { timeoutMinutes: null, runs: 1, prompt: "Custom prompt" });
    await vi.advanceTimersByTimeAsync(500);
    expect(mocked.missions[1].status).toBe("running");

    await runtime.pause("root");
    expect(mocked.missions[1].status).toBe("paused");

    await runtime.resume("root");
    expect(mocked.missions[1].status).toBe("running");

    await runtime.stop("root");
    await vi.advanceTimersByTimeAsync(500);
    expect(mocked.missions[1].status).toBe("stopped");
    vi.useRealTimers();
  });
});
