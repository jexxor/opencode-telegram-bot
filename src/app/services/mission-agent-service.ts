import { opencodeClient } from "../../opencode/client.js";
import { logger } from "../../utils/logger.js";
import { sessionStatusManager } from "../managers/session-status-manager.js";
import type { Mission } from "../types/mission.js";
import type { SessionActivityStatus, SessionInfo } from "../types/session.js";

export interface MissionAgent extends SessionInfo {
  missionId: string;
  missionName: string;
  status: SessionActivityStatus;
}

interface OwnedSession {
  session: SessionInfo;
  missionId: string;
  missionName: string;
}

function sessionKey(session: SessionInfo): string {
  return `${session.directory}\0${session.id}`;
}

function collectMissionRoots(rootMissionId: string, missions: Mission[]): OwnedSession[] {
  const missionsById = new Map(missions.map((mission) => [mission.id, mission]));
  const visited = new Set<string>();
  const roots: OwnedSession[] = [];

  const visit = (missionId: string): void => {
    if (visited.has(missionId)) return;
    visited.add(missionId);
    const mission = missionsById.get(missionId);
    if (!mission) return;
    roots.push(
      ...mission.rootSessions.map((session) => ({
        session,
        missionId: mission.id,
        missionName: mission.name,
      })),
    );
    mission.subMissionIds.forEach(visit);
  };

  visit(rootMissionId);
  return roots;
}

async function collectSessionTree(roots: OwnedSession[]): Promise<OwnedSession[]> {
  const visited = new Set<string>();
  const sessions: OwnedSession[] = [];
  let pending = roots;

  while (pending.length > 0) {
    const level = pending.filter(({ session }) => {
      const key = sessionKey(session);
      if (visited.has(key)) return false;
      visited.add(key);
      return true;
    });
    sessions.push(...level);
    const children = await Promise.all(
      level.map(async ({ session, missionId, missionName }) => {
        try {
          const { data, error } = await opencodeClient.session.children({
            sessionID: session.id,
            directory: session.directory,
          });
          if (error || !data) {
            logger.debug(`[MissionAgents] Failed to load children: session=${session.id}`, error);
            return [];
          }
          return data.map((child) => ({
            session: {
              id: child.id,
              title: child.title,
              directory: child.directory || session.directory,
            },
            missionId,
            missionName,
          }));
        } catch (error) {
          logger.debug(`[MissionAgents] Failed to load children: session=${session.id}`, error);
          return [];
        }
      }),
    );
    pending = children.flat();
  }

  return sessions;
}

export async function listMissionAgents(
  rootMissionId: string,
  missions: Mission[],
): Promise<MissionAgent[]> {
  const sessions = await collectSessionTree(collectMissionRoots(rootMissionId, missions));
  const directories = [...new Set(sessions.map(({ session }) => session.directory))];
  const statusesByDirectory = new Map<string, Record<string, { type?: string }>>();
  const accessSessionKeys = new Set<string>();

  await Promise.all(
    directories.map(async (directory) => {
      try {
        const [statusResult, permissionResult, questionResult] = await Promise.all([
          opencodeClient.session.status({ directory }),
          opencodeClient.permission.list({ directory }),
          opencodeClient.question.list({ directory }),
        ]);
        if (statusResult.error || !statusResult.data) {
          logger.debug(
            `[MissionAgents] Failed to load statuses: directory=${directory}`,
            statusResult.error,
          );
        } else {
          statusesByDirectory.set(
            directory,
            statusResult.data as Record<string, { type?: string }>,
          );
        }
        for (const request of [...(permissionResult.data ?? []), ...(questionResult.data ?? [])]) {
          if (request.sessionID) accessSessionKeys.add(`${directory}\0${request.sessionID}`);
        }
      } catch (error) {
        logger.debug(`[MissionAgents] Failed to load agent state: directory=${directory}`, error);
      }
    }),
  );

  return sessions.map(({ session, missionId, missionName }) => {
    const type = statusesByDirectory.get(session.directory)?.[session.id]?.type;
    const trackedStatus = sessionStatusManager.get(session.id)?.status;
    return {
      ...session,
      missionId,
      missionName,
      status:
        trackedStatus === "access_request" || accessSessionKeys.has(sessionKey(session))
          ? "access_request"
          : type && type !== "idle" && type !== "error"
            ? "working"
            : "finished",
    };
  });
}
