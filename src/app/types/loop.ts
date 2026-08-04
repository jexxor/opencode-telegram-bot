import type { ScheduledTaskModel } from "./scheduled-task.js";
import type { SessionInfo } from "./session.js";

export type AgentLoopStatus = "running" | "stopped";
export type AgentLoopStopReason = "manual" | "timeout" | "terminal";

export interface AgentLoop {
  id: string;
  projectId: string;
  projectWorktree: string;
  steps: SessionInfo[];
  intervalMinutes: number;
  timeoutMinutes: number | null;
  prompt: string;
  agent: string;
  model: ScheduledTaskModel;
  status: AgentLoopStatus;
  currentStepIndex: number;
  completedCycles: number;
  runStartedAt: string;
  runStoppedAt: string | null;
  nextRunAt: string | null;
  expiresAt: string | null;
  lastRunAt: string | null;
  stopReason: AgentLoopStopReason | null;
  createdAt: string;
}

export interface AgentLoopCreationState {
  stage: "selecting_sessions" | "awaiting_interval" | "awaiting_timeout" | "awaiting_prompt";
  projectId: string;
  projectWorktree: string;
  steps: SessionInfo[];
  intervalMinutes: number | null;
  timeoutMinutes: number | null;
  agent: string;
  model: ScheduledTaskModel;
  messageId: number | null;
  page: number;
}

export function cloneAgentLoop(loop: AgentLoop): AgentLoop {
  return {
    ...loop,
    completedCycles: loop.completedCycles ?? 0,
    runStartedAt: loop.runStartedAt ?? loop.createdAt,
    runStoppedAt:
      loop.status === "running"
        ? null
        : (loop.runStoppedAt ?? loop.lastRunAt ?? loop.createdAt),
    timeoutMinutes: loop.timeoutMinutes ?? null,
    expiresAt: loop.expiresAt ?? null,
    stopReason: loop.stopReason ?? null,
    steps: loop.steps.map((step) => ({ ...step })),
    model: { ...loop.model },
  };
}
