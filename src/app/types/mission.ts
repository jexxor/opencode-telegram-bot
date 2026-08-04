import type { SessionInfo } from "./session.js";

export type MissionStatus = "idle" | "running" | "paused" | "stopped" | "completed" | "failed";

export interface Mission {
  id: string;
  /** @deprecated Missions are global. Kept only for persisted-data compatibility. */
  projectId?: string;
  /** @deprecated Missions are global. Kept only for persisted-data compatibility. */
  projectWorktree?: string;
  name: string;
  description: string;
  subMissionIds: string[];
  rootSessions: SessionInfo[];
  status: MissionStatus;
  requestedRuns: number;
  completedRuns: number;
  totalSessionRuns: number;
  failedSessionRuns: number;
  timeoutMinutes: number | null;
  runStartedAt: string | null;
  runFinishedAt: string | null;
  lastError: string | null;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MissionRunOptions {
  timeoutMinutes: number | null;
  runs: number;
  prompt: string;
}

export function cloneMission(mission: Mission): Mission {
  return {
    ...mission,
    subMissionIds: [...mission.subMissionIds],
    rootSessions: mission.rootSessions.map((session) => ({ ...session })),
    requestedRuns: mission.requestedRuns ?? 1,
    completedRuns: mission.completedRuns ?? 0,
    totalSessionRuns: mission.totalSessionRuns ?? 0,
    failedSessionRuns: mission.failedSessionRuns ?? 0,
    timeoutMinutes: mission.timeoutMinutes ?? null,
    runStartedAt: mission.runStartedAt ?? null,
    runFinishedAt: mission.runFinishedAt ?? null,
    lastError: mission.lastError ?? null,
  };
}
