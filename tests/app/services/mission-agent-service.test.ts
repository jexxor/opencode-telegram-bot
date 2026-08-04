import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "@opencode-ai/sdk/v2";
import type { Mission } from "../../../src/app/types/mission.js";
import { sessionStatusManager } from "../../../src/app/managers/session-status-manager.js";

const mocked = vi.hoisted(() => ({
  children: vi.fn(),
  status: vi.fn(),
  permissions: vi.fn(),
  questions: vi.fn(),
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: {
      children: mocked.children,
      status: mocked.status,
    },
    permission: { list: mocked.permissions },
    question: { list: mocked.questions },
  },
}));

import { listMissionAgents } from "../../../src/app/services/mission-agent-service.js";

function mission(
  id: string,
  subMissionIds: string[],
  roots: Array<{ id: string; title: string; directory: string }>,
): Mission {
  return {
    id,
    name: id,
    description: "",
    subMissionIds,
    rootSessions: roots,
    status: "idle",
    requestedRuns: 1,
    completedRuns: 0,
    totalSessionRuns: 0,
    failedSessionRuns: 0,
    timeoutMinutes: null,
    runStartedAt: null,
    runFinishedAt: null,
    lastError: null,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  };
}

describe("listMissionAgents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStatusManager.__resetForTests();
    mocked.children.mockImplementation(
      async ({ sessionID }: { sessionID: string; directory: string }) => ({
        data:
          sessionID === "child-root"
            ? [{ id: "spawned-agent", title: "Spawned agent", directory: "/child" }]
            : [],
        error: null,
      }),
    );
    mocked.status.mockImplementation(async ({ directory }: { directory: string }) => ({
      data:
        directory === "/child"
          ? {
              "child-root": { type: "busy" },
              "spawned-agent": { type: "idle" },
            }
          : { "root-agent": { type: "idle" } },
      error: null,
    }));
    mocked.permissions.mockResolvedValue({ data: [], error: null });
    mocked.questions.mockResolvedValue({ data: [], error: null });
  });

  it("collects root and spawned agents from the full mission graph with live statuses", async () => {
    const missions = [
      mission(
        "root",
        ["child", "child"],
        [{ id: "root-agent", title: "Root agent", directory: "/root" }],
      ),
      mission("child", [], [{ id: "child-root", title: "Child root", directory: "/child" }]),
    ];

    const agents = await listMissionAgents("root", missions);

    expect(agents).toEqual([
      expect.objectContaining({ id: "root-agent", missionId: "root", status: "finished" }),
      expect.objectContaining({ id: "child-root", missionId: "child", status: "working" }),
      expect.objectContaining({ id: "spawned-agent", missionId: "child", status: "finished" }),
    ]);
    expect(mocked.children).toHaveBeenCalledTimes(3);
    expect(mocked.status).toHaveBeenCalledTimes(2);
  });

  it("shows access requests ahead of coarse busy status", async () => {
    const missions = [
      mission("root", [], [{ id: "root-agent", title: "Root agent", directory: "/root" }]),
    ];
    sessionStatusManager.register({ id: "root-agent", title: "Root agent", directory: "/root" });
    sessionStatusManager.processEvent({
      type: "permission.asked",
      properties: {
        id: "permission",
        sessionID: "root-agent",
        permission: "external_directory",
        patterns: ["/parent/*"],
        metadata: {},
        always: [],
      },
    } as unknown as Event);
    mocked.status.mockResolvedValue({ data: { "root-agent": { type: "busy" } }, error: null });

    const agents = await listMissionAgents("root", missions);

    expect(agents[0].status).toBe("access_request");
  });

  it("finds pending access requests without subscribed events", async () => {
    const missions = [
      mission("root", [], [{ id: "root-agent", title: "Root agent", directory: "/root" }]),
    ];
    mocked.status.mockResolvedValue({ data: { "root-agent": { type: "busy" } }, error: null });
    mocked.permissions.mockResolvedValue({
      data: [{ id: "permission", sessionID: "root-agent" }],
      error: null,
    });

    const agents = await listMissionAgents("root", missions);

    expect(agents[0].status).toBe("access_request");
  });
});
