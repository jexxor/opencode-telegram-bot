import type { Event } from "@opencode-ai/sdk/v2";
import type { SessionActivityStatus, SessionInfo } from "../types/session.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";

export type { SessionActivityStatus } from "../types/session.js";

export function formatSessionActivityStatus(status: SessionActivityStatus): string {
  switch (status) {
    case "working":
      return t("status.session_status.working");
    case "access_request":
      return t("status.session_status.access");
    case "finished":
      return t("status.session_status.finished");
  }
}

export interface SessionStatusSnapshot extends SessionInfo {
  status: SessionActivityStatus;
  updatedAt: number;
}

type SessionStatusChangeCallback = (session: SessionStatusSnapshot) => void;

function getEventSessionId(event: Event): string | null {
  const properties = event.properties as {
    sessionID?: string;
    info?: { id?: string; sessionID?: string; title?: string; directory?: string };
    part?: { sessionID?: string };
  };

  return properties.sessionID || properties.info?.sessionID || properties.info?.id || properties.part?.sessionID || null;
}

function getEventSessionInfo(event: Event): Partial<SessionInfo> {
  const info = (event.properties as { info?: Partial<SessionInfo> }).info;
  return {
    id: info?.id,
    title: info?.title,
    directory: info?.directory,
  };
}

class SessionStatusManager {
  private sessions = new Map<string, SessionStatusSnapshot>();
  private onChange: SessionStatusChangeCallback | null = null;

  setOnChange(callback: SessionStatusChangeCallback | null): void {
    this.onChange = callback;
  }

  register(session: SessionInfo): SessionStatusSnapshot {
    const existing = this.sessions.get(session.id);
    const next: SessionStatusSnapshot = {
      id: session.id,
      title: session.title || existing?.title || session.id,
      directory: session.directory || existing?.directory || "",
      status: existing?.status ?? "finished",
      updatedAt: existing?.updatedAt ?? Date.now(),
    };

    this.sessions.set(session.id, next);
    return { ...next };
  }

  registerMany(sessions: SessionInfo[]): void {
    for (const session of sessions) {
      this.register(session);
    }
  }

  get(sessionId: string): SessionStatusSnapshot | null {
    const session = this.sessions.get(sessionId);
    return session ? { ...session } : null;
  }

  list(directory?: string): SessionStatusSnapshot[] {
    return Array.from(this.sessions.values())
      .filter((session) => !directory || session.directory === directory)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((session) => ({ ...session }));
  }

  processEvent(event: Event): void {
    const sessionId = getEventSessionId(event);
    if (!sessionId) {
      return;
    }

    const info = getEventSessionInfo(event);
    const existing = this.sessions.get(sessionId);
    const session: SessionStatusSnapshot = {
      id: sessionId,
      title: info.title || existing?.title || sessionId,
      directory: info.directory || existing?.directory || "",
      status: existing?.status ?? "finished",
      updatedAt: Date.now(),
    };

    switch (event.type) {
      case "question.asked":
      case "permission.asked":
        session.status = "access_request";
        break;
      case "session.idle":
      case "session.error":
        session.status = "finished";
        break;
      case "session.status": {
        const status = (event.properties as { status?: { type?: string } }).status?.type;
        if (status === "busy") {
          session.status = "working";
        } else if (status === "idle" || status === "error") {
          session.status = "finished";
        }
        break;
      }
      case "question.replied":
      case "question.rejected":
      case "permission.replied":
        session.status = "working";
        break;
      case "message.part.delta":
      case "message.part.updated":
        if (session.status !== "access_request") {
          session.status = "working";
        }
        break;
      default:
        break;
    }

    this.sessions.set(sessionId, session);
    logger.debug(
      `[SessionStatus] Updated session: id=${sessionId}, status=${session.status}, event=${event.type}`,
    );
    this.onChange?.({ ...session });
  }

  markWorking(sessionId: string): void {
    this.updateStatus(sessionId, "working");
  }

  markFinished(sessionId: string): void {
    this.updateStatus(sessionId, "finished");
  }

  clear(): void {
    this.sessions.clear();
  }

  __resetForTests(): void {
    this.clear();
    this.onChange = null;
  }

  private updateStatus(sessionId: string, status: SessionActivityStatus): void {
    const existing = this.sessions.get(sessionId);
    if (!existing) {
      return;
    }

    const next = { ...existing, status, updatedAt: Date.now() };
    this.sessions.set(sessionId, next);
    this.onChange?.({ ...next });
  }
}

export const sessionStatusManager = new SessionStatusManager();
