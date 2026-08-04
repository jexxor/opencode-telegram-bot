import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Context } from "grammy";
import { interactionManager } from "../../../src/app/managers/interaction-manager.js";
import { missionCreationManager } from "../../../src/app/managers/mission-creation-manager.js";
import type { Mission } from "../../../src/app/types/mission.js";
import type { MissionAgent } from "../../../src/app/services/mission-agent-service.js";

const mocked = vi.hoisted(() => ({
  addMission: vi.fn(),
  sessionList: vi.fn(),
  sessionGet: vi.fn(),
  sessionCreate: vi.fn(),
  sessionChildren: vi.fn(),
  sessionStatus: vi.fn(),
  permissionList: vi.fn(),
  questionList: vi.fn(),
  upsertSessionDirectory: vi.fn(),
  runMission: vi.fn(),
  updateMission: vi.fn(),
  attachToSession: vi.fn(),
  switchToProject: vi.fn(),
  setCurrentSession: vi.fn(),
  fetchCurrentAgent: vi.fn(),
  sendSessionPreview: vi.fn(),
  missions: [] as Mission[],
}));

vi.mock("../../../src/config.js", () => ({
  config: { bot: { sessionsListLimit: 10, projectsListLimit: 10 } },
}));
vi.mock("../../../src/app/stores/mission-store.js", () => ({
  addMission: mocked.addMission,
  listMissions: () => structuredClone(mocked.missions),
  getMission: (id: string) => {
    const mission = mocked.missions.find((candidate) => candidate.id === id);
    return mission ? structuredClone(mission) : null;
  },
  getMissionParents: vi.fn(() => []),
  updateMission: mocked.updateMission,
}));
vi.mock("../../../src/app/services/mission-runtime-service.js", () => ({
  missionRuntime: {
    run: mocked.runMission,
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: {
      list: mocked.sessionList,
      get: mocked.sessionGet,
      create: mocked.sessionCreate,
      children: mocked.sessionChildren,
      status: mocked.sessionStatus,
    },
    permission: { list: mocked.permissionList },
    question: { list: mocked.questionList },
  },
}));
vi.mock("../../../src/app/services/project-service.js", () => ({
  getProjectsIncludingWorktrees: vi.fn(async () => [
    { id: "project-2", name: "Other", worktree: "/other" },
  ]),
}));
vi.mock("../../../src/app/services/session-cache-service.js", () => ({
  syncSessionDirectoryCache: vi.fn(async () => undefined),
  upsertSessionDirectory: mocked.upsertSessionDirectory,
  __resetSessionDirectoryCacheForTests: vi.fn(),
}));
vi.mock("../../../src/app/services/attach-service.js", () => ({
  attachToSession: mocked.attachToSession,
}));
vi.mock("../../../src/app/services/project-switch-service.js", () => ({
  switchToProject: mocked.switchToProject,
}));
vi.mock("../../../src/app/services/session-service.js", () => ({
  setCurrentSession: mocked.setCurrentSession,
}));
vi.mock("../../../src/app/services/agent-selection-service.js", () => ({
  fetchCurrentAgent: mocked.fetchCurrentAgent,
}));
vi.mock("../../../src/bot/keyboards/keyboard-manager.js", () => ({
  keyboardManager: {
    updateAgent: vi.fn(),
    getKeyboard: vi.fn(() => ({ keyboard: [] })),
  },
}));
vi.mock("../../../src/bot/callbacks/session-callback-handler.js", () => ({
  sendSessionPreview: mocked.sendSessionPreview,
}));

import {
  handleMissionCreateCallback,
  handleMissionsCallback,
} from "../../../src/bot/callbacks/mission-callback-handler.js";
import {
  handleMissionTextInput,
  missionCommand,
  missionsCommand,
} from "../../../src/bot/commands/mission-command.js";
import {
  buildMissionsListKeyboard,
  buildMissionDetailsKeyboard,
  buildMissionProjectKeyboard,
  buildMissionSubMissionKeyboard,
  MISSION_SUB_REMOVE_PREFIX,
  MISSIONS_EDIT_ROOT_PREFIX,
  MISSIONS_EDIT_SUB_PREFIX,
  MISSIONS_CREATE_ROOT_PREFIX,
  MISSIONS_OPEN_PREFIX,
  MISSIONS_PAGE_PREFIX,
  MISSIONS_REFRESH_PREFIX,
  MISSIONS_AGENT_PREFIX,
  MISSIONS_BACK,
} from "../../../src/bot/menus/mission-menu.js";

function commandContext(): Context {
  return {
    chat: { id: 1 },
    reply: vi.fn().mockResolvedValue({ message_id: 10 }),
  } as unknown as Context;
}

function textContext(text: string): Context {
  return {
    chat: { id: 1 },
    message: { text } as Context["message"],
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

function childMission(): Mission {
  return {
    id: "child",
    projectId: "project-1",
    projectWorktree: "/repo",
    name: "Child",
    description: "",
    subMissionIds: [],
    rootSessions: [],
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

describe("/mission", () => {
  beforeEach(() => {
    missionCreationManager.__resetForTests();
    interactionManager.clear("test");
    vi.clearAllMocks();
    mocked.missions = [childMission()];
    mocked.updateMission.mockImplementation(
      async (id: string, updater: (mission: Mission) => Mission) => {
        const index = mocked.missions.findIndex((mission) => mission.id === id);
        if (index < 0) return null;
        mocked.missions[index] = updater(structuredClone(mocked.missions[index]));
        return structuredClone(mocked.missions[index]);
      },
    );
    mocked.sessionList.mockResolvedValue({
      data: [{ id: "root", title: "Root", directory: "/other" }],
      error: null,
    });
    mocked.sessionGet.mockResolvedValue({
      data: { id: "root", title: "Root", directory: "/other" },
      error: null,
    });
    mocked.sessionCreate.mockImplementation(
      async ({ directory, title }: { directory: string; title: string }) => ({
        data: { id: `created-${mocked.sessionCreate.mock.calls.length}`, title, directory },
        error: null,
      }),
    );
    mocked.sessionChildren.mockResolvedValue({ data: [], error: null });
    mocked.sessionStatus.mockResolvedValue({ data: {}, error: null });
    mocked.permissionList.mockResolvedValue({ data: [], error: null });
    mocked.questionList.mockResolvedValue({ data: [], error: null });
    mocked.upsertSessionDirectory.mockResolvedValue(undefined);
    mocked.runMission.mockResolvedValue(childMission());
    mocked.attachToSession.mockResolvedValue(undefined);
    mocked.switchToProject.mockResolvedValue(undefined);
    mocked.fetchCurrentAgent.mockResolvedValue("build");
    mocked.sendSessionPreview.mockResolvedValue(undefined);
  });

  it("creates nested mission with duplicate sub-missions and selected root", async () => {
    await missionCommand(commandContext() as never);
    await handleMissionTextInput(textContext("Parent"));
    await handleMissionTextInput(textContext("Description"));
    await handleMissionCreateCallback(callbackContext("mission-create:sub:child"));
    await handleMissionCreateCallback(callbackContext("mission-create:sub:child"));
    await handleMissionCreateCallback(callbackContext("mission-create:sub-ok"));
    await handleMissionCreateCallback(callbackContext("mission-create:project:project-2"));
    await handleMissionCreateCallback(callbackContext("mission-create:root:root"));
    await handleMissionCreateCallback(callbackContext("mission-create:root-ok"));

    expect(mocked.addMission).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Parent",
        description: "Description",
        subMissionIds: ["child", "child"],
        rootSessions: [{ id: "root", title: "Root", directory: "/other" }],
        status: "idle",
      }),
    );
    expect(mocked.addMission.mock.calls[0][0]).not.toHaveProperty("projectId");
    expect(mocked.addMission.mock.calls[0][0]).not.toHaveProperty("projectWorktree");
    expect(missionCreationManager.getState()).toBeNull();
  });

  it("starts mission creation without a selected project", async () => {
    const ctx = commandContext();

    await missionCommand(ctx as never);

    expect(ctx.reply).toHaveBeenCalled();
    expect(missionCreationManager.getState()).toMatchObject({ stage: "name" });
  });

  it("lists legacy missions from every project in one global menu", async () => {
    mocked.missions = [
      childMission(),
      {
        ...childMission(),
        id: "other-project-mission",
        name: "Other project mission",
        projectId: "project-2",
        projectWorktree: "/other",
      },
    ];
    const ctx = commandContext();

    await missionsCommand(ctx as never);

    const reply = ctx.reply as unknown as ReturnType<typeof vi.fn>;
    const options = reply.mock.calls[0][1] as {
      reply_markup: { inline_keyboard: Array<Array<{ callback_data?: string }>> };
    };
    const callbacks = options.reply_markup.inline_keyboard
      .flat()
      .map((button) => button.callback_data)
      .filter(Boolean);
    expect(callbacks).toEqual(
      expect.arrayContaining([
        `${MISSIONS_OPEN_PREFIX}child`,
        `${MISSIONS_OPEN_PREFIX}other-project-mission`,
      ]),
    );
  });

  it("creates an organizational mission without root sessions", async () => {
    await missionCommand(commandContext() as never);
    await handleMissionTextInput(textContext("ITMO"));
    await handleMissionTextInput(textContext("Organization root"));
    await handleMissionCreateCallback(callbackContext("mission-create:sub:child"));
    await handleMissionCreateCallback(callbackContext("mission-create:sub-save"));

    expect(mocked.addMission).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "ITMO",
        subMissionIds: ["child"],
        rootSessions: [],
      }),
    );
    expect(missionCreationManager.getState()).toBeNull();
  });

  it("creates an empty no-op mission", async () => {
    await missionCommand(commandContext() as never);
    await handleMissionTextInput(textContext("Placeholder"));
    await handleMissionTextInput(textContext("Filled later"));
    await handleMissionCreateCallback(callbackContext("mission-create:sub-save"));

    expect(mocked.addMission).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Placeholder",
        subMissionIds: [],
        rootSessions: [],
      }),
    );
    expect(missionCreationManager.getState()).toBeNull();
  });

  it("removes sub-missions through the structural editor", async () => {
    const parent = {
      ...childMission(),
      id: "parent",
      name: "Parent",
      subMissionIds: ["child"],
      rootSessions: [{ id: "root", title: "Root", directory: "/repo" }],
    };
    mocked.missions = [childMission(), parent];
    missionCreationManager.startAction(parent, "edit_sub_missions", 10);
    interactionManager.start({
      kind: "custom",
      expectedInput: "callback",
      metadata: { flow: "missions", stage: "edit_sub_missions", messageId: 10, page: 0 },
    });

    await handleMissionCreateCallback(callbackContext("mission-create:sub-remove:child"));
    await handleMissionCreateCallback(callbackContext("mission-create:sub-ok"));

    expect(mocked.updateMission).toHaveBeenCalled();
    expect(mocked.missions.find((mission) => mission.id === "parent")?.subMissionIds).toEqual([]);
    expect(missionCreationManager.getState()).toBeNull();
  });

  it("does not render remove controls for unselected sub-missions", () => {
    const callbacks = buildMissionSubMissionKeyboard([childMission()], 0, 10, [], true)
      .inline_keyboard.flat()
      .map((button) => ("callback_data" in button ? button.callback_data : undefined));

    expect(callbacks).not.toContain(`${MISSION_SUB_REMOVE_PREFIX}child`);
  });

  it("keeps structural editing active when a stale callback renders no changes", async () => {
    const parent = { ...childMission(), id: "parent", name: "Parent" };
    mocked.missions = [childMission(), parent];
    missionCreationManager.startAction(parent, "edit_sub_missions", 10);
    interactionManager.start({
      kind: "custom",
      expectedInput: "callback",
      metadata: { flow: "missions", stage: "edit_sub_missions", messageId: 10, page: 0 },
    });
    const ctx = callbackContext(`${MISSION_SUB_REMOVE_PREFIX}child`);
    vi.mocked(ctx.editMessageText).mockRejectedValueOnce(
      new Error("Bad Request: message is not modified"),
    );

    await expect(handleMissionCreateCallback(ctx)).resolves.toBe(true);

    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(missionCreationManager.getState()).toMatchObject({
      stage: "edit_sub_missions",
      missionId: "parent",
    });
    expect(interactionManager.getSnapshot()).toMatchObject({
      kind: "custom",
      metadata: { flow: "missions", stage: "edit_sub_missions" },
    });
  });

  it("removes root sessions through the project-based structural editor", async () => {
    const parent = {
      ...childMission(),
      id: "parent",
      name: "Parent",
      subMissionIds: [],
      rootSessions: [{ id: "root", title: "Root", directory: "/other" }],
    };
    mocked.missions = [childMission(), parent];
    missionCreationManager.startAction(parent, "edit_root_projects", 10);
    interactionManager.start({
      kind: "custom",
      expectedInput: "callback",
      metadata: { flow: "missions", stage: "edit_root_projects", messageId: 10, page: 0 },
    });

    await handleMissionCreateCallback(callbackContext("mission-create:project:project-2"));
    await handleMissionCreateCallback(callbackContext("mission-create:root:root"));
    await handleMissionCreateCallback(callbackContext("mission-create:root-ok"));

    expect(mocked.missions.find((mission) => mission.id === "parent")?.rootSessions).toEqual([]);
    expect(mocked.missions.find((mission) => mission.id === "parent")?.subMissionIds).toEqual([]);
    expect(missionCreationManager.getState()).toBeNull();
  });

  it("hides structural editing while a mission is running", () => {
    const mission = { ...childMission(), status: "running" as const };
    const callbacks = buildMissionDetailsKeyboard(mission)
      .inline_keyboard.flat()
      .map((button) => ("callback_data" in button ? button.callback_data : undefined));

    expect(callbacks).not.toContain(`${MISSIONS_EDIT_SUB_PREFIX}${mission.id}`);
    expect(callbacks).not.toContain(`${MISSIONS_EDIT_ROOT_PREFIX}${mission.id}`);
    expect(callbacks).not.toContain(`${MISSIONS_CREATE_ROOT_PREFIX}${mission.id}`);
  });

  it("shows root-session creation for an idle mission", () => {
    const mission = childMission();
    const callbacks = buildMissionDetailsKeyboard(mission)
      .inline_keyboard.flat()
      .map((button) => ("callback_data" in button ? button.callback_data : undefined));

    expect(callbacks).toContain(`${MISSIONS_CREATE_ROOT_PREFIX}${mission.id}`);
  });

  it("shows mission agents as session-switch buttons", () => {
    const mission = childMission();
    const agents: MissionAgent[] = [
      {
        id: "agent-1",
        title: "Implementation",
        directory: "/repo",
        missionId: mission.id,
        missionName: mission.name,
        status: "working",
      },
      {
        id: "agent-2",
        title: "Review",
        directory: "/repo",
        missionId: mission.id,
        missionName: mission.name,
        status: "finished",
      },
      {
        id: "agent-3",
        title: "Needs access",
        directory: "/repo",
        missionId: mission.id,
        missionName: mission.name,
        status: "access_request",
      },
    ];

    const buttons = buildMissionDetailsKeyboard(mission, agents).inline_keyboard.flat();
    expect(buttons.map((button) => button.text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Implementation"),
        expect.stringContaining("Review"),
        expect.stringMatching(/🔐.*Needs access/),
      ]),
    );
    expect(
      buttons.map((button) => ("callback_data" in button ? button.callback_data : undefined)),
    ).toEqual(
      expect.arrayContaining([
        `${MISSIONS_AGENT_PREFIX}agent-1`,
        `${MISSIONS_AGENT_PREFIX}agent-2`,
        `${MISSIONS_AGENT_PREFIX}agent-3`,
      ]),
    );
  });

  it("shows session history after selecting a mission agent", async () => {
    mocked.missions = [
      {
        ...childMission(),
        rootSessions: [{ id: "agent-1", title: "Worker", directory: "/repo" }],
      },
    ];
    interactionManager.start({
      kind: "custom",
      expectedInput: "callback",
      metadata: {
        flow: "missions",
        stage: "detail",
        messageId: 10,
        missionId: "child",
        page: 0,
      },
    });
    const ctx = {
      ...callbackContext(`${MISSIONS_AGENT_PREFIX}agent-1`),
      chat: { id: 1 },
      api: {},
      reply: vi.fn().mockResolvedValue({ message_id: 11 }),
    } as unknown as Context;
    const bot = { api: {} } as Bot<Context>;

    await handleMissionsCallback(ctx, {
      bot,
      ensureEventSubscription: vi.fn().mockResolvedValue(undefined),
    });
    await vi.waitFor(() => {
      expect(mocked.sendSessionPreview).toHaveBeenCalledWith(
        ctx.api,
        1,
        null,
        "Worker",
        "agent-1",
        "/repo",
      );
    });
  });

  it("creates and attaches a named root-session swarm", async () => {
    const mission = childMission();
    mocked.missions = [mission];
    missionCreationManager.startAction(mission, "create_root_count", 10);
    missionCreationManager.update((state) => {
      state.selectionProjectWorktree = "/opt/work";
    });
    interactionManager.start({
      kind: "custom",
      expectedInput: "text",
      metadata: {
        flow: "missions",
        stage: "create_root_count",
        messageId: 10,
        missionId: mission.id,
        page: 0,
      },
    });

    await handleMissionTextInput(textContext("3"));

    expect(mocked.sessionCreate.mock.calls.map(([input]) => input)).toEqual([
      { directory: "/opt/work", title: "Child" },
      { directory: "/opt/work", title: "Child 2" },
      { directory: "/opt/work", title: "Child 3" },
    ]);
    expect(mocked.missions[0].rootSessions.map((session) => session.title)).toEqual([
      "Child",
      "Child 2",
      "Child 3",
    ]);
    expect(mocked.upsertSessionDirectory).toHaveBeenCalledWith("/opt/work", expect.any(Number));
    expect(missionCreationManager.getState()).toBeNull();
  });

  it("creates one root session when swarm count is zero", async () => {
    const mission = childMission();
    mocked.missions = [mission];
    missionCreationManager.startAction(mission, "create_root_count", 10);
    missionCreationManager.update((state) => {
      state.selectionProjectWorktree = "/opt/work";
    });
    interactionManager.start({
      kind: "custom",
      expectedInput: "text",
      metadata: { flow: "missions", stage: "create_root_count", messageId: 10 },
    });

    await handleMissionTextInput(textContext("0"));

    expect(mocked.sessionCreate).toHaveBeenCalledTimes(1);
    expect(mocked.sessionCreate).toHaveBeenCalledWith({
      directory: "/opt/work",
      title: "Child",
    });
  });

  it("attaches successful sessions when swarm creation partially fails", async () => {
    const mission = childMission();
    mocked.missions = [mission];
    mocked.sessionCreate
      .mockResolvedValueOnce({
        data: { id: "created-1", title: "Child", directory: "/opt/work" },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: new Error("create failed") });
    missionCreationManager.startAction(mission, "create_root_count", 10);
    missionCreationManager.update((state) => {
      state.selectionProjectWorktree = "/opt/work";
    });
    interactionManager.start({
      kind: "custom",
      expectedInput: "text",
      metadata: { flow: "missions", stage: "create_root_count", messageId: 10 },
    });
    const ctx = textContext("3");

    await handleMissionTextInput(ctx);

    expect(mocked.sessionCreate).toHaveBeenCalledTimes(2);
    expect(mocked.missions[0].rootSessions).toEqual([
      { id: "created-1", title: "Child", directory: "/opt/work" },
    ]);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("1"));
  });

  it("keeps the mission interaction when refresh renders unchanged details", async () => {
    const ctx = callbackContext(`${MISSIONS_REFRESH_PREFIX}child`);
    vi.mocked(ctx.editMessageText).mockRejectedValueOnce(
      new Error("Call to 'editMessageText' failed! (400: Bad Request: message is not modified)"),
    );
    interactionManager.start({
      kind: "custom",
      expectedInput: "callback",
      metadata: {
        flow: "missions",
        stage: "detail",
        messageId: 10,
        missionId: "child",
        page: 0,
      },
    });

    await expect(handleMissionsCallback(ctx)).resolves.toBe(true);

    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(interactionManager.getSnapshot()).toMatchObject({
      kind: "custom",
      metadata: { flow: "missions", stage: "detail", missionId: "child" },
    });
  });

  it("refreshes mission agent statuses while the details panel is open", async () => {
    vi.useFakeTimers();
    try {
      mocked.missions = [
        {
          ...childMission(),
          rootSessions: [{ id: "agent", title: "Agent", directory: "/repo" }],
        },
      ];
      mocked.sessionStatus
        .mockResolvedValueOnce({ data: { agent: { type: "busy" } }, error: null })
        .mockResolvedValueOnce({ data: { agent: { type: "idle" } }, error: null });
      interactionManager.start({
        kind: "custom",
        expectedInput: "callback",
        metadata: { flow: "missions", stage: "list", messageId: 10, page: 0 },
      });
      const editMessageText = vi.fn().mockResolvedValue(undefined);
      const ctx = {
        ...callbackContext(`${MISSIONS_OPEN_PREFIX}child`),
        chat: { id: 1 },
        api: { editMessageText },
      } as unknown as Context;

      await handleMissionsCallback(ctx);
      const initialKeyboard = vi.mocked(ctx.editMessageText).mock.calls[0][1]?.reply_markup;
      expect(JSON.stringify(initialKeyboard)).toContain("⏳");

      await vi.advanceTimersByTimeAsync(3_000);

      expect(JSON.stringify(editMessageText.mock.calls[0][3]?.reply_markup)).toContain("✅");
      await handleMissionsCallback(callbackContext(MISSIONS_BACK));
    } finally {
      vi.useRealTimers();
    }
  });

  it("paginates mission keyboards", () => {
    const missions = Array.from({ length: 25 }, (_, index) => ({
      ...childMission(),
      id: `mission-${index}`,
      name: `Mission ${index}`,
    }));

    const keyboard = buildMissionsListKeyboard(missions, 1, 10);
    const callbacks = keyboard.inline_keyboard
      .flat()
      .map((button) => ("callback_data" in button ? button.callback_data : undefined))
      .filter((value): value is string => Boolean(value));

    expect(callbacks.filter((value) => value.startsWith(MISSIONS_OPEN_PREFIX))).toEqual(
      missions.slice(10, 20).map((mission) => `${MISSIONS_OPEN_PREFIX}${mission.id}`),
    );
    expect(callbacks).toContain(`${MISSIONS_PAGE_PREFIX}0`);
    expect(callbacks).toContain(`${MISSIONS_PAGE_PREFIX}2`);
  });

  it("shows sub-mission and root-session counts in the mission list", () => {
    const mission = {
      ...childMission(),
      name: "A very long mission name that must leave enough room for counters on the right",
      subMissionIds: ["a", "b", "b"],
      rootSessions: [
        { id: "root-1", title: "Root 1", directory: "/repo" },
        { id: "root-2", title: "Root 2", directory: "/repo" },
      ],
    };

    const button = buildMissionsListKeyboard([mission], 0, 10).inline_keyboard[0][0];
    expect(button.text).toMatch(/\(3\|2\)$/);
    expect(button.text.length).toBeLessThanOrEqual(64);
  });

  it("shows a project name and trailing path context in the mission picker", () => {
    const worktree =
      "/opt/devel/polygon/v1/root/subordinates/itmo/subordinates/ais/subordinates/lab-5-knn";

    const button = buildMissionProjectKeyboard(
      [{ id: "project", name: worktree, worktree }],
      0,
      10,
    ).inline_keyboard[0][0];

    expect(button.text).toMatch(/^📁 lab-5-knn · /);
    expect(button.text).toContain("/opt/");
    expect(button.text).toContain("…");
    expect(button.text).toContain("ais/subordinates/lab-5-knn");
    expect(button.text.length).toBeLessThanOrEqual(64);
  });

  it("asks for and passes a custom shared prompt when starting a mission", async () => {
    const mission = childMission();
    missionCreationManager.startAction(mission, "run_timeout", 10);
    interactionManager.start({
      kind: "custom",
      expectedInput: "text",
      metadata: { flow: "missions", stage: "run_timeout", messageId: 10 },
    });

    await handleMissionTextInput(textContext("0"));
    await handleMissionTextInput(textContext("2"));
    await handleMissionTextInput(textContext("Review TASK.md and implement the next iteration"));

    expect(mocked.runMission).toHaveBeenCalledWith("child", {
      timeoutMinutes: null,
      runs: 2,
      prompt: "Review TASK.md and implement the next iteration",
    });
    expect(missionCreationManager.getState()).toBeNull();
  });
});
