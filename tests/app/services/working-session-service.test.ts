import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  getProjects: vi.fn(),
  status: vi.fn(),
  list: vi.fn(),
  questions: vi.fn(),
  permissions: vi.fn(),
}));

vi.mock("../../../src/app/services/project-service.js", () => ({
  getProjectsIncludingWorktrees: mocked.getProjects,
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: { status: mocked.status, list: mocked.list },
    question: { list: mocked.questions },
    permission: { list: mocked.permissions },
  },
}));

import { listWorkingSessions } from "../../../src/app/services/working-session-service.js";

describe("working-session-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.getProjects.mockResolvedValue([
      { id: "one", name: "Project One", worktree: "/one" },
      { id: "two", name: "Project Two", worktree: "/two" },
    ]);
    mocked.status.mockImplementation(({ directory }) =>
      Promise.resolve({
        data:
          directory === "/one"
            ? { "session-1": { type: "busy" } }
            : { "session-2": { type: "busy" }, idle: { type: "idle" } },
      }),
    );
    mocked.list.mockImplementation(({ directory }) =>
      Promise.resolve({
        data: [
          {
            id: directory === "/one" ? "session-1" : "session-2",
            title: directory === "/one" ? "Build one" : "Build two",
          },
        ],
      }),
    );
    mocked.questions.mockImplementation(({ directory }) =>
      Promise.resolve({ data: directory === "/two" ? [{ sessionID: "session-2" }] : [] }),
    );
    mocked.permissions.mockResolvedValue({ data: [] });
  });

  it("lists busy sessions across projects and marks pending access", async () => {
    await expect(listWorkingSessions()).resolves.toEqual([
      {
        id: "session-1",
        title: "Build one",
        directory: "/one",
        projectName: "Project One",
        status: "working",
      },
      {
        id: "session-2",
        title: "Build two",
        directory: "/two",
        projectName: "Project Two",
        status: "access_request",
      },
    ]);
  });

  it("returns healthy project sessions when another project status request fails", async () => {
    mocked.status.mockImplementation(({ directory }) =>
      Promise.resolve(
        directory === "/one"
          ? { data: { "session-1": { type: "busy" } }, error: null }
          : { data: null, error: new Error("project unavailable") },
      ),
    );

    await expect(listWorkingSessions()).resolves.toEqual([
      {
        id: "session-1",
        title: "Build one",
        directory: "/one",
        projectName: "Project One",
        status: "working",
      },
    ]);
  });
});
