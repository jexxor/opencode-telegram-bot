import { opencodeClient } from "../../opencode/client.js";
import { getProjectsIncludingWorktrees } from "./project-service.js";
import type { SessionActivityStatus } from "../types/session.js";
import { logger } from "../../utils/logger.js";

export interface WorkingSession {
  id: string;
  title: string;
  directory: string;
  projectName: string;
  status: Exclude<SessionActivityStatus, "finished">;
}

type PendingRequest = { sessionID?: string };

export async function listWorkingSessions(): Promise<WorkingSession[]> {
  const projects = await getProjectsIncludingWorktrees();
  const results = await Promise.allSettled(
    projects.map(async (project): Promise<WorkingSession[]> => {
      const [statusResult, sessionResult, questionResult, permissionResult] = await Promise.all([
        opencodeClient.session.status({ directory: project.worktree }),
        opencodeClient.session.list({ directory: project.worktree, roots: true }),
        opencodeClient.question.list({ directory: project.worktree }),
        opencodeClient.permission.list({ directory: project.worktree }),
      ]);

      if (statusResult.error || !statusResult.data) {
        throw statusResult.error || new Error(`Failed to load status for ${project.worktree}`);
      }

      const accessSessionIds = new Set<string>();
      for (const request of [
        ...((questionResult.data ?? []) as PendingRequest[]),
        ...((permissionResult.data ?? []) as PendingRequest[]),
      ]) {
        if (request.sessionID) {
          accessSessionIds.add(request.sessionID);
        }
      }

      const sessionsById = new Map(
        (sessionResult.data ?? []).map((session) => [session.id, session]),
      );
      return Object.entries(statusResult.data as Record<string, { type?: string }>)
        .filter(([, status]) => status.type === "busy")
        .map(([sessionId]) => {
          const session = sessionsById.get(sessionId);
          return {
            id: sessionId,
            title: session?.title || sessionId,
            directory: project.worktree,
            projectName: project.name || project.worktree,
            status: accessSessionIds.has(sessionId) ? "access_request" : "working",
          };
        });
    }),
  );

  return results.flatMap((result, index) => {
    if (result.status === "fulfilled") {
      return result.value;
    }
    logger.warn(
      `[WorkingSessions] Failed to load project: directory=${projects[index]?.worktree ?? "unknown"}`,
      result.reason,
    );
    return [];
  });
}
