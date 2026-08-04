import type { ModelInfo } from "./model.js";
import type { ProjectInfo } from "./project.js";
import type {
  QueuedSessionPrompt,
  SessionDirectoryCacheInfo,
  SessionInfo,
} from "./session.js";
import type { ScheduledTask } from "./scheduled-task.js";
import type { AgentLoop } from "./loop.js";
import type { Mission } from "./mission.js";

export type ResponseStreamingMode = "edit" | "draft";

export interface ScheduledTaskSessionIgnoreInfo {
  sessionId: string;
  createdAt: string;
}

export interface Settings {
  currentProject?: ProjectInfo;
  currentSession?: SessionInfo;
  currentAgent?: string;
  currentModel?: ModelInfo;
  pinnedMessageId?: number;
  ttsMode?: "off" | "all" | "auto";
  compactOutputMode?: boolean;
  showThinkingContent?: boolean;
  showAssistantRunFooter?: boolean;
  responseStreamingMode?: ResponseStreamingMode;
  sendDiffFileAttachments?: boolean;
  sessionDirectoryCache?: SessionDirectoryCacheInfo;
  scheduledTasks?: ScheduledTask[];
  scheduledTaskSessionIgnores?: ScheduledTaskSessionIgnoreInfo[];
  queuedSessionPrompts?: QueuedSessionPrompt[];
  agentLoops?: AgentLoop[];
  /** Legacy migration source. New mission state lives in missions.sqlite. */
  missions?: Mission[];
}
