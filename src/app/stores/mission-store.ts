import path from "node:path";
import Database from "better-sqlite3";
import { getRuntimePaths } from "../../runtime/paths.js";
import { logger } from "../../utils/logger.js";
import { cloneMission, type Mission } from "../types/mission.js";
import { clearLegacyMissions, getLegacyMissions } from "./settings-store.js";

const DATABASE_FILE_NAME = "missions.sqlite";

interface MissionRow {
  payload: string;
}

let database: Database.Database | null = null;
let databasePath: string | null = null;

function parseMission(row: MissionRow): Mission {
  return cloneMission(JSON.parse(row.payload) as Mission);
}

function getDatabase(): Database.Database {
  if (!database) throw new Error("Mission store has not been initialized");
  return database;
}

function upsertMission(db: Database.Database, mission: Mission): void {
  const stored = cloneMission(mission);
  db.prepare(
    `
      INSERT INTO missions (id, payload, created_at, updated_at, archived_at)
      VALUES (@id, @payload, @createdAt, @updatedAt, @archivedAt)
      ON CONFLICT(id) DO UPDATE SET
        payload = excluded.payload,
        updated_at = excluded.updated_at,
        archived_at = excluded.archived_at
    `,
  ).run({
    id: stored.id,
    payload: JSON.stringify(stored),
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    archivedAt: stored.archivedAt ?? null,
  });
}

function initializeSchema(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS missions (
      id TEXT PRIMARY KEY NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );
    CREATE INDEX IF NOT EXISTS missions_active_created_idx
      ON missions (archived_at, created_at);
  `);
}

function migrateSettingsMissions(db: Database.Database, missions: Mission[]): number {
  const migration = db.transaction(() => {
    let migratedCount = 0;
    const exists = db.prepare("SELECT 1 FROM missions WHERE id = ?");
    for (const mission of missions) {
      if (!exists.get(mission.id)) {
        upsertMission(db, mission);
        migratedCount += 1;
      }
    }
    return migratedCount;
  });
  return migration.immediate();
}

export async function initializeMissionStore(): Promise<void> {
  const nextDatabasePath = path.join(getRuntimePaths().appHome, DATABASE_FILE_NAME);
  if (database && databasePath === nextDatabasePath) return;
  database?.close();

  const fs = await import("node:fs/promises");
  await fs.mkdir(path.dirname(nextDatabasePath), { recursive: true });
  const nextDatabase = new Database(nextDatabasePath);
  initializeSchema(nextDatabase);

  try {
    const legacyMissions = await getLegacyMissions();
    const migratedCount = migrateSettingsMissions(nextDatabase, legacyMissions);
    if (legacyMissions.length > 0) {
      await clearLegacyMissions();
      logger.info(`[MissionStore] Migrated ${migratedCount} mission(s) from settings.json`);
    }
    database = nextDatabase;
    databasePath = nextDatabasePath;
  } catch (error) {
    nextDatabase.close();
    throw error;
  }
}

export function listMissions(): Mission[] {
  const rows = getDatabase()
    .prepare(
      `
        SELECT payload
        FROM missions
        WHERE archived_at IS NULL
        ORDER BY created_at ASC, rowid ASC
      `,
    )
    .all() as MissionRow[];
  return rows.map(parseMission);
}

export function getMission(missionId: string): Mission | null {
  const row = getDatabase()
    .prepare("SELECT payload FROM missions WHERE id = ? AND archived_at IS NULL")
    .get(missionId) as MissionRow | undefined;
  return row ? parseMission(row) : null;
}

export function getMissionParents(missionId: string): Mission[] {
  return listMissions().filter((mission) => mission.subMissionIds.includes(missionId));
}

export async function addMission(mission: Mission): Promise<void> {
  const db = getDatabase();
  db.prepare(
    `
      INSERT INTO missions (id, payload, created_at, updated_at, archived_at)
      VALUES (@id, @payload, @createdAt, @updatedAt, @archivedAt)
    `,
  ).run({
    id: mission.id,
    payload: JSON.stringify(cloneMission(mission)),
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
    archivedAt: mission.archivedAt ?? null,
  });
  logger.info(`[MissionStore] Added mission: id=${mission.id}, name=${mission.name}`);
}

export async function updateMission(
  missionId: string,
  updater: (mission: Mission) => Mission,
): Promise<Mission | null> {
  const db = getDatabase();
  const transaction = db.transaction(() => {
    const current = getMission(missionId);
    if (!current) return null;
    const updated = cloneMission(updater(cloneMission(current)));
    if (updated.id !== missionId) throw new Error("Mission updater cannot change mission ID");
    upsertMission(db, updated);
    return cloneMission(updated);
  });
  return transaction.immediate();
}

export async function removeMissionCascade(missionId: string): Promise<boolean> {
  const db = getDatabase();
  const archive = db.transaction(() => {
    const mission = getMission(missionId);
    if (!mission) return false;
    const now = new Date().toISOString();
    upsertMission(db, { ...mission, archivedAt: now, updatedAt: now });

    for (const parent of getMissionParents(missionId)) {
      upsertMission(db, {
        ...parent,
        subMissionIds: parent.subMissionIds.filter((id) => id !== missionId),
        updatedAt: now,
      });
    }
    return true;
  });
  const archived = archive.immediate();
  if (archived) logger.info(`[MissionStore] Archived mission: id=${missionId}`);
  return archived;
}

export function __resetMissionStoreForTests(): void {
  closeMissionStore();
}

export function closeMissionStore(): void {
  database?.close();
  database = null;
  databasePath = null;
}
