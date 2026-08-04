export interface SessionInfo {
  id: string;
  title: string;
  directory: string;
}

export type SessionActivityStatus = "working" | "access_request" | "finished";

export interface QueuedSessionPrompt {
  id: string;
  sessionId: string;
  sessionTitle: string;
  directory: string;
  text: string;
  agent: string;
  agentLoopId?: string;
  agentLoopRunStartedAt?: string;
  model: {
    providerID: string;
    modelID: string;
    variant?: string;
  };
  createdAt: string;
}

export interface CachedSessionDirectory {
  worktree: string;
  lastUpdated: number;
}

export interface SessionDirectoryProject {
  id: string;
  worktree: string;
  name: string;
  lastUpdated: number;
}

export interface SessionDirectoryCacheInfo {
  version: 1;
  lastSyncedUpdatedAt: number;
  directories: CachedSessionDirectory[];
}
