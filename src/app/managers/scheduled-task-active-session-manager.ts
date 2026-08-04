const activeSessionIds = new Set<string>();

export function markScheduledTaskSessionActive(sessionId: string): void {
  activeSessionIds.add(sessionId);
}

export function markScheduledTaskSessionInactive(sessionId: string): void {
  activeSessionIds.delete(sessionId);
}

export function isScheduledTaskSessionActive(sessionId: string): boolean {
  return activeSessionIds.has(sessionId);
}

export function __resetScheduledTaskActiveSessionsForTests(): void {
  activeSessionIds.clear();
}
