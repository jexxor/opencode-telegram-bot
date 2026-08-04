import type { Mission } from "../types/mission.js";
import type { SessionInfo } from "../types/session.js";

export type MissionFlowStage =
  | "name"
  | "description"
  | "sub_missions"
  | "root_projects"
  | "root_sessions"
  | "run_timeout"
  | "run_count"
  | "run_prompt"
  | "edit_name"
  | "edit_description"
  | "edit_sub_missions"
  | "edit_root_projects"
  | "edit_root_sessions"
  | "create_root_directory"
  | "create_root_count";

export interface MissionCreationState {
  stage: MissionFlowStage;
  selectionProjectWorktree: string | null;
  name: string;
  description: string;
  subMissionIds: string[];
  rootSessions: SessionInfo[];
  messageId: number | null;
  page: number;
  missionId: string | null;
  timeoutMinutes: number | null;
  runCount: number | null;
}

function cloneState(state: MissionCreationState): MissionCreationState {
  return {
    ...state,
    subMissionIds: [...state.subMissionIds],
    rootSessions: state.rootSessions.map((session) => ({ ...session })),
  };
}

class MissionCreationManager {
  private state: MissionCreationState | null = null;

  start(): void {
    this.state = {
      stage: "name",
      selectionProjectWorktree: null,
      name: "",
      description: "",
      subMissionIds: [],
      rootSessions: [],
      messageId: null,
      page: 0,
      missionId: null,
      timeoutMinutes: null,
      runCount: null,
    };
  }

  startAction(mission: Mission, stage: MissionFlowStage, messageId: number | null): void {
    this.state = {
      stage,
      selectionProjectWorktree: null,
      name: mission.name,
      description: mission.description,
      subMissionIds: [...mission.subMissionIds],
      rootSessions: mission.rootSessions.map((session) => ({ ...session })),
      messageId,
      page: 0,
      missionId: mission.id,
      timeoutMinutes: null,
      runCount: null,
    };
  }

  getState(): MissionCreationState | null {
    return this.state ? cloneState(this.state) : null;
  }

  update(updater: (state: MissionCreationState) => void): void {
    if (this.state) updater(this.state);
  }

  clear(): void {
    this.state = null;
  }

  __resetForTests(): void {
    this.clear();
  }
}

export const missionCreationManager = new MissionCreationManager();
