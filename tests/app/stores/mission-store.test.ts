import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntimeMode } from "../../../src/runtime/mode.js";
import type { Mission } from "../../../src/app/types/mission.js";
import {
  __resetSettingsForTests,
  flushSettings,
  loadSettings,
} from "../../../src/app/stores/settings-store.js";
import {
  __resetMissionStoreForTests,
  addMission,
  getMissionParents,
  initializeMissionStore,
  listMissions,
  removeMissionCascade,
} from "../../../src/app/stores/mission-store.js";

function createMission(id: string, subMissionIds: string[] = []): Mission {
  return {
    id,
    projectId: "project-1",
    projectWorktree: "/repo",
    name: id,
    description: "",
    subMissionIds,
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

describe("mission store", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "opencode-telegram-missions-"));
    process.env.OPENCODE_TELEGRAM_HOME = tempHome;
    setRuntimeMode("installed");
    __resetSettingsForTests();
    __resetMissionStoreForTests();
  });

  afterEach(async () => {
    __resetMissionStoreForTests();
    __resetSettingsForTests();
    delete process.env.OPENCODE_TELEGRAM_HOME;
    await rm(tempHome, { recursive: true, force: true });
  });

  async function initializeEmptyStore(): Promise<void> {
    await loadSettings();
    await initializeMissionStore();
  }

  it("archives missions and removes active parent references transactionally", async () => {
    await initializeEmptyStore();
    await addMission(createMission("child"));
    await addMission(createMission("parent-1", ["child", "child"]));
    await addMission(createMission("parent-2", ["child"]));

    expect(getMissionParents("child").map((mission) => mission.id)).toEqual([
      "parent-1",
      "parent-2",
    ]);
    expect(await removeMissionCascade("child")).toBe(true);

    expect(listMissions().map((mission) => mission.id)).toEqual(["parent-1", "parent-2"]);
    expect(listMissions().every((mission) => mission.subMissionIds.length === 0)).toBe(true);

    const db = new Database(path.join(tempHome, "missions.sqlite"), { readonly: true });
    try {
      expect(db.prepare("SELECT archived_at FROM missions WHERE id = ?").get("child")).toEqual({
        archived_at: expect.any(String),
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM missions").get()).toEqual({ count: 3 });
    } finally {
      db.close();
    }
  });

  it("returns detached mission copies", async () => {
    await initializeEmptyStore();
    await addMission(createMission("parent", ["child"]));

    const missions = listMissions();
    missions[0].subMissionIds.push("changed");

    expect(listMissions()[0].subMissionIds).toEqual(["child"]);
  });

  it("persists missions across store restarts", async () => {
    await initializeEmptyStore();
    await addMission(createMission("mission-1"));
    __resetMissionStoreForTests();

    await initializeMissionStore();

    expect(listMissions().map((mission) => mission.id)).toEqual(["mission-1"]);
  });

  it("migrates legacy settings missions once and removes them from settings.json", async () => {
    await writeFile(
      path.join(tempHome, "settings.json"),
      JSON.stringify({ missions: [createMission("legacy-mission")], compactOutputMode: true }),
    );
    await loadSettings();

    await initializeMissionStore();
    await flushSettings();

    expect(listMissions().map((mission) => mission.id)).toEqual(["legacy-mission"]);
    const settings = JSON.parse(
      await readFile(path.join(tempHome, "settings.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(settings.missions).toBeUndefined();
    expect(settings.compactOutputMode).toBe(true);
  });

  it("recovers legacy missions from the settings backup during migration", async () => {
    await writeFile(path.join(tempHome, "settings.json"), JSON.stringify({ compactOutputMode: true }));
    await writeFile(
      path.join(tempHome, "settings.json.bak"),
      JSON.stringify({ missions: [createMission("backup-mission")] }),
    );
    await loadSettings();

    await initializeMissionStore();

    expect(listMissions().map((mission) => mission.id)).toEqual(["backup-mission"]);
  });

  it("does not resurrect archived rows from stale legacy settings", async () => {
    await initializeEmptyStore();
    await addMission(createMission("mission-1"));
    await removeMissionCascade("mission-1");
    __resetMissionStoreForTests();
    __resetSettingsForTests();
    await writeFile(
      path.join(tempHome, "settings.json"),
      JSON.stringify({ missions: [createMission("mission-1")] }),
    );
    await loadSettings();

    await initializeMissionStore();

    expect(listMissions()).toEqual([]);
  });
});
