import type { AgentLoopCreationState } from "../types/loop.js";
import type { ScheduledTaskModel } from "../types/scheduled-task.js";
import type { SessionInfo } from "../types/session.js";

function cloneState(state: AgentLoopCreationState): AgentLoopCreationState {
  return {
    ...state,
    steps: state.steps.map((step) => ({ ...step })),
    model: { ...state.model },
  };
}

class AgentLoopCreationManager {
  private state: AgentLoopCreationState | null = null;

  start(
    projectId: string,
    projectWorktree: string,
    agent: string,
    model: ScheduledTaskModel,
  ): AgentLoopCreationState {
    this.state = {
      stage: "selecting_sessions",
      projectId,
      projectWorktree,
      steps: [],
      intervalMinutes: null,
      timeoutMinutes: null,
      agent,
      model: { ...model },
      messageId: null,
      page: 0,
    };
    return cloneState(this.state);
  }

  getState(): AgentLoopCreationState | null {
    return this.state ? cloneState(this.state) : null;
  }

  setMessageId(messageId: number): void {
    if (this.state) this.state.messageId = messageId;
  }

  setPage(page: number): void {
    if (this.state) this.state.page = page;
  }

  addStep(session: SessionInfo): void {
    this.state?.steps.push({ ...session });
  }

  undoStep(): void {
    this.state?.steps.pop();
  }

  awaitInterval(): void {
    if (this.state) this.state.stage = "awaiting_interval";
  }

  setInterval(intervalMinutes: number): void {
    if (!this.state) return;
    this.state.intervalMinutes = intervalMinutes;
    this.state.stage = "awaiting_timeout";
  }

  setTimeoutMinutes(timeoutMinutes: number | null): void {
    if (!this.state) return;
    this.state.timeoutMinutes = timeoutMinutes;
    this.state.stage = "awaiting_prompt";
  }

  clear(): void {
    this.state = null;
  }

  __resetForTests(): void {
    this.clear();
  }
}

export const agentLoopCreationManager = new AgentLoopCreationManager();
