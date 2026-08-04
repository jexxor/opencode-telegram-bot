import { config } from "../../config.js";
import { opencodeClient } from "../../opencode/client.js";
import { logger } from "../../utils/logger.js";
import { getStoredAgent, resolveProjectAgent } from "./agent-selection-service.js";
import { getStoredModel } from "./model-selection-service.js";
import {
  getMission,
  listMissions,
  removeMissionCascade,
  updateMission,
} from "../stores/mission-store.js";
import type { Mission, MissionRunOptions } from "../types/mission.js";
import type { SessionInfo } from "../types/session.js";

const STATUS_POLL_INTERVAL_MS = 500;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const ACCESS_RETRY_LIMIT = 2;
const ACCESS_RETRY_INSTRUCTION =
  "The previous attempt requested access outside this agent's working directory. Do not inspect or access parent directory hierarchies. Stay within the current working directory, read ROLE.md there, and continue the assigned task without requesting external directory access.";

class MissionInterruptedError extends Error {}
class MissionSessionError extends Error {}
class MissionAgentDroppedError extends Error {}

class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    signal: AbortSignal;
    onAbort: () => void;
  }> = [];

  constructor(private readonly capacity: number) {}

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new MissionInterruptedError("Mission stopped"));
    if (this.active < this.capacity) {
      this.active += 1;
      return Promise.resolve(this.createRelease());
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new MissionInterruptedError("Mission stopped"));
        },
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.resolve(this.createRelease());
      } else {
        this.active -= 1;
      }
    };
  }
}

interface MissionRunController {
  rootMissionId: string;
  abortController: AbortController;
  paused: boolean;
  pauseWaiters: Set<() => void>;
  activeSessions: Map<string, SessionInfo>;
  invocationCounts: Map<string, number>;
  invokedMissionIds: Set<string>;
  stopReason: "manual" | "timeout" | "failure" | null;
  timeout: ReturnType<typeof setTimeout> | null;
}

interface ExecutionContext {
  rootMissionId: string;
  controller: MissionRunController;
  agent: string;
  model: ReturnType<typeof getStoredModel>;
  prompt: string;
}

interface MissionExecutionNode {
  mission: Mission;
  accountingMissionIds: string[];
}

interface PendingSessionRun {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface ActiveMissionSession {
  session: SessionInfo;
  context: ExecutionContext;
  accountingMissionIds: string[];
}

interface PermissionRecoveryState {
  generation: number;
  rootSessionId: string;
  session: SessionInfo;
}

export interface MissionPermissionRequest {
  id: string;
  sessionID: string;
  permission: string;
}

export type MissionPermissionRecoveryResult =
  | { handled: false }
  | {
      handled: true;
      outcome: "relaunched" | "dropped" | "duplicate";
      sessionTitle: string;
      retry: number;
      retryLimit: number;
    };

type MissionPermissionRecoveryCallback = (
  recovery: Exclude<MissionPermissionRecoveryResult, { handled: false }> & {
    outcome: "relaunched" | "dropped";
  },
) => void | Promise<void>;

export interface MissionSessionFailure {
  sessionTitle: string;
  message: string;
}

type MissionSessionFailureCallback = (
  failure: MissionSessionFailure,
) => void | Promise<void>;

interface AssistantMessageSnapshot {
  info: {
    role?: string;
    summary?: unknown;
    finish?: string;
    time?: { created?: number; completed?: number };
    error?: unknown;
  };
  parts?: Array<{ type?: string; reason?: string }>;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new MissionInterruptedError("Mission stopped"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new MissionInterruptedError("Mission stopped"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function sessionKey(session: SessionInfo): string {
  return `${session.directory}\0${session.id}`;
}

export class MissionRuntime {
  private readonly semaphore = new AsyncSemaphore(config.bot?.missionConcurrencyLimit ?? 8);
  private readonly sessionSemaphores = new Map<string, AsyncSemaphore>();
  private readonly controllers = new Map<string, MissionRunController>();
  private readonly activeControllersByMissionId = new Map<string, Set<MissionRunController>>();
  private readonly pendingSessionRuns = new Map<string, PendingSessionRun>();
  private readonly activeMissionSessions = new Map<string, ActiveMissionSession>();
  private readonly permissionRetryCounts = new Map<string, number>();
  private readonly permissionRecoveries = new Map<string, PermissionRecoveryState>();
  private readonly permissionRequestTasks = new Map<
    string,
    Promise<MissionPermissionRecoveryResult>
  >();
  private readonly handledPermissionRequestIdsByRoot = new Map<string, Set<string>>();
  private permissionRecoveryGeneration = 0;
  private onPermissionRecovery: MissionPermissionRecoveryCallback | null = null;
  private onSessionFailure: MissionSessionFailureCallback | null = null;

  async initialize(): Promise<void> {
    await Promise.all(
      listMissions()
        .filter((mission) => mission.status === "running" || mission.status === "paused")
        .map((mission) =>
          updateMission(mission.id, (current) => ({
            ...current,
            status: "stopped",
            runFinishedAt: new Date().toISOString(),
            lastError: "Bot restarted during mission execution",
            updatedAt: new Date().toISOString(),
          })),
        ),
    );
  }

  async run(missionId: string, options: MissionRunOptions): Promise<Mission | null> {
    if (this.getControllersForMission(missionId).size > 0) return getMission(missionId);
    const mission = getMission(missionId);
    if (!mission) return null;
    if (!Number.isSafeInteger(options.runs) || options.runs < 1) {
      throw new Error("Mission run count must be a positive integer");
    }
    const prompt = options.prompt.trim();
    if (!prompt) throw new Error("Mission prompt cannot be empty");
    if (
      options.timeoutMinutes !== null &&
      (!Number.isSafeInteger(options.timeoutMinutes) || options.timeoutMinutes < 1)
    ) {
      throw new Error("Mission timeout must be a positive integer or null");
    }

    const controller: MissionRunController = {
      rootMissionId: missionId,
      abortController: new AbortController(),
      paused: false,
      pauseWaiters: new Set(),
      activeSessions: new Map(),
      invocationCounts: new Map(),
      invokedMissionIds: new Set(),
      stopReason: null,
      timeout: null,
    };
    this.controllers.set(missionId, controller);

    const startedAt = new Date().toISOString();
    const updated = await updateMission(missionId, (current) => ({
      ...current,
      status: "running",
      requestedRuns: options.runs,
      completedRuns: 0,
      timeoutMinutes: options.timeoutMinutes,
      runStartedAt: startedAt,
      runFinishedAt: null,
      lastError: null,
      updatedAt: startedAt,
    }));

    if (options.timeoutMinutes) {
      this.scheduleTimeout(controller, Date.now() + options.timeoutMinutes * 60_000);
    }

    void this.executeRoot(missionId, options.runs, prompt, controller);
    return updated;
  }

  async pause(missionId: string): Promise<Mission | null> {
    const controllers = this.getControllersForMission(missionId);
    if (controllers.size === 0) return getMission(missionId);
    for (const controller of controllers) controller.paused = true;
    await this.updateControllerMissionStatuses(controllers, "paused");
    return updateMission(missionId, (mission) => ({
      ...mission,
      status: "paused",
      updatedAt: new Date().toISOString(),
    }));
  }

  async resume(missionId: string): Promise<Mission | null> {
    const controllers = this.getControllersForMission(missionId);
    if (controllers.size === 0) return getMission(missionId);
    for (const controller of controllers) {
      controller.paused = false;
      for (const resolve of controller.pauseWaiters) resolve();
      controller.pauseWaiters.clear();
    }
    await this.updateControllerMissionStatuses(controllers, "running");
    return updateMission(missionId, (mission) => ({
      ...mission,
      status: "running",
      updatedAt: new Date().toISOString(),
    }));
  }

  async stop(missionId: string): Promise<Mission | null> {
    const controllers = this.getControllersForMission(missionId);
    if (controllers.size === 0) return getMission(missionId);
    for (const controller of controllers) {
      controller.stopReason = "manual";
      controller.abortController.abort();
      for (const resolve of controller.pauseWaiters) resolve();
      controller.pauseWaiters.clear();
    }
    await Promise.all([...controllers].map((controller) => this.abortActiveSessions(controller)));
    await this.updateControllerMissionStatuses(controllers, "stopped");
    return updateMission(missionId, (mission) => ({
      ...mission,
      status: "stopped",
      runFinishedAt: new Date().toISOString(),
      lastError: null,
      updatedAt: new Date().toISOString(),
    }));
  }

  async delete(missionId: string): Promise<boolean> {
    await this.stop(missionId);
    return removeMissionCascade(missionId);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.controllers.keys()].map((missionId) => this.stop(missionId)));
  }

  setOnPermissionRecovery(callback: MissionPermissionRecoveryCallback | null): void {
    this.onPermissionRecovery = callback;
  }

  setOnSessionFailure(callback: MissionSessionFailureCallback | null): void {
    this.onSessionFailure = callback;
  }

  handleSessionIdle(sessionId: string): boolean {
    if (this.isPermissionRecoveryActive(sessionId)) return true;
    const pending = this.pendingSessionRuns.get(sessionId);
    if (!pending) return false;
    pending.resolve();
    return true;
  }

  handleSessionError(sessionId: string, message: string): boolean {
    if (this.isPermissionRecoveryActive(sessionId)) return true;
    const pending = this.pendingSessionRuns.get(sessionId);
    if (!pending) return false;
    pending.reject(new Error(message));
    return true;
  }

  async handlePermissionRequest(
    request: MissionPermissionRequest,
    directory: string,
  ): Promise<MissionPermissionRecoveryResult> {
    for (const requestIds of this.handledPermissionRequestIdsByRoot.values()) {
      if (requestIds.has(request.id)) {
        return {
          handled: true,
          outcome: "duplicate",
          sessionTitle: request.sessionID,
          retry: 0,
          retryLimit: ACCESS_RETRY_LIMIT,
        };
      }
    }
    const existingTask = this.permissionRequestTasks.get(request.id);
    if (existingTask) return existingTask;
    const task = this.processPermissionRequest(request, directory);
    this.permissionRequestTasks.set(request.id, task);
    try {
      return await task;
    } finally {
      this.permissionRequestTasks.delete(request.id);
    }
  }

  private async processPermissionRequest(
    request: MissionPermissionRequest,
    directory: string,
  ): Promise<MissionPermissionRecoveryResult> {
    if (request.permission !== "external_directory") return { handled: false };
    const ownership = await this.resolveActiveMissionSession(request.sessionID, directory);
    if (!ownership) return { handled: false };

    const { requester, root } = ownership;
    const handledRequestIds =
      this.handledPermissionRequestIdsByRoot.get(root.session.id) ?? new Set<string>();
    handledRequestIds.add(request.id);
    this.handledPermissionRequestIdsByRoot.set(root.session.id, handledRequestIds);
    const retryKey = `${sessionKey(root.session)}\0${requester.id}`;
    const retry = (this.permissionRetryCounts.get(retryKey) ?? 0) + 1;
    this.permissionRetryCounts.set(retryKey, retry);
    const generation = ++this.permissionRecoveryGeneration;
    if (retry <= ACCESS_RETRY_LIMIT) {
      this.permissionRecoveries.set(sessionKey(requester), {
        generation,
        rootSessionId: root.session.id,
        session: requester,
      });
    }

    const { error: replyError } = await opencodeClient.permission.reply({
      requestID: request.id,
      directory: requester.directory,
      reply: "reject",
      message: ACCESS_RETRY_INSTRUCTION,
    });
    if (replyError) {
      this.clearPermissionRecovery(requester, root.session.id, generation);
      await this.dropPermissionRequester(
        requester,
        root,
        `Failed to reject access request for ${requester.title}`,
        true,
      );
      return this.emitPermissionRecovery({
        handled: true,
        outcome: "dropped",
        sessionTitle: requester.title,
        retry,
        retryLimit: ACCESS_RETRY_LIMIT,
      });
    }

    await this.abortSession(requester);
    if (root.context.controller.abortController.signal.aborted) {
      this.clearPermissionRecovery(requester, root.session.id, generation);
      return {
        handled: true,
        outcome: "duplicate",
        sessionTitle: requester.title,
        retry,
        retryLimit: ACCESS_RETRY_LIMIT,
      };
    }
    if (retry > ACCESS_RETRY_LIMIT) {
      this.clearPermissionRecovery(requester, root.session.id);
      await this.dropPermissionRequester(
        requester,
        root,
        `Agent ${requester.title} exceeded external directory access retry limit`,
        false,
      );
      return this.emitPermissionRecovery({
        handled: true,
        outcome: "dropped",
        sessionTitle: requester.title,
        retry,
        retryLimit: ACCESS_RETRY_LIMIT,
      });
    }

    const startedAtMs = Date.now();
    const { error: promptError } = await opencodeClient.session.promptAsync({
      sessionID: requester.id,
      directory: requester.directory,
      parts: [{ type: "text", text: ACCESS_RETRY_INSTRUCTION }],
    });
    if (promptError) {
      this.clearPermissionRecovery(requester, root.session.id, generation);
      await this.dropPermissionRequester(
        requester,
        root,
        `Failed to relaunch agent ${requester.title}`,
        false,
      );
      return this.emitPermissionRecovery({
        handled: true,
        outcome: "dropped",
        sessionTitle: requester.title,
        retry,
        retryLimit: ACCESS_RETRY_LIMIT,
      });
    }

    void this.pollPermissionRecovery(requester, root, startedAtMs, generation);
    return this.emitPermissionRecovery({
      handled: true,
      outcome: "relaunched",
      sessionTitle: requester.title,
      retry,
      retryLimit: ACCESS_RETRY_LIMIT,
    });
  }

  private async executeRoot(
    missionId: string,
    runs: number,
    prompt: string,
    controller: MissionRunController,
  ): Promise<void> {
    try {
      const context: ExecutionContext = {
        rootMissionId: missionId,
        controller,
        agent: await resolveProjectAgent(getStoredAgent()),
        model: getStoredModel(),
        prompt,
      };
      for (let run = 0; run < runs; run += 1) {
        await this.waitWhilePaused(controller);
        await this.executeMissionGraph(missionId, context);
        await updateMission(missionId, (mission) => ({
          ...mission,
          completedRuns: mission.completedRuns + 1,
          updatedAt: new Date().toISOString(),
        }));
      }
      const finishedAt = new Date().toISOString();
      await updateMission(missionId, (mission) => ({
        ...mission,
        status: "completed",
        runFinishedAt: finishedAt,
        updatedAt: finishedAt,
      }));
      logger.info(`[MissionRuntime] Mission completed: id=${missionId}, runs=${runs}`);
    } catch (error) {
      if (!controller.abortController.signal.aborted) {
        controller.stopReason = "failure";
        controller.abortController.abort();
        await this.abortActiveSessions(controller);
      }
      const interrupted = controller.stopReason === "manual" || controller.stopReason === "timeout";
      const finishedAt = new Date().toISOString();
      await updateMission(missionId, (mission) => ({
        ...mission,
        status: interrupted ? "stopped" : "failed",
        runFinishedAt: finishedAt,
        lastError:
          controller.stopReason === "timeout"
            ? "Mission timeout reached"
            : interrupted
              ? null
              : error instanceof Error
                ? error.message
                : String(error),
        updatedAt: finishedAt,
      }));
      if (!interrupted) logger.error(`[MissionRuntime] Mission failed: id=${missionId}`, error);
    } finally {
      if (controller.timeout) clearTimeout(controller.timeout);
      this.controllers.delete(missionId);
    }
  }

  private async executeMissionGraph(missionId: string, context: ExecutionContext): Promise<void> {
    const levels = this.buildMissionLevels(missionId, context.controller.abortController.signal);
    for (const level of levels) {
      await this.waitWhilePaused(context.controller);
      await this.runParallel(
        level.map((node) => this.executeMissionNode(node, context)),
        context.controller,
      );
    }
  }

  private buildMissionLevels(rootMissionId: string, signal: AbortSignal): MissionExecutionNode[][] {
    const byLevel = new Map<number, MissionExecutionNode[]>();
    const visit = (missionId: string, ancestorIds: string[], path: Set<string>): number => {
      this.throwIfAborted(signal);
      if (path.has(missionId)) throw new Error(`Mission cycle detected at ${missionId}`);
      const mission = getMission(missionId);
      if (!mission) throw new Error(`Mission ${missionId} no longer exists`);
      const accountingMissionIds = [...ancestorIds, missionId];
      const nextPath = new Set(path).add(missionId);
      const childLevels = mission.subMissionIds.map((subMissionId) =>
        visit(subMissionId, accountingMissionIds, nextPath),
      );
      const level =
        childLevels.reduce((highest, childLevel) => Math.max(highest, childLevel), -1) + 1;
      const currentLevel = byLevel.get(level) ?? [];
      currentLevel.push({ mission, accountingMissionIds });
      byLevel.set(level, currentLevel);
      return level;
    };

    visit(rootMissionId, [], new Set());
    return [...byLevel.entries()].sort(([left], [right]) => left - right).map(([, nodes]) => nodes);
  }

  private async executeMissionNode(
    node: MissionExecutionNode,
    context: ExecutionContext,
  ): Promise<void> {
    const { mission, accountingMissionIds } = node;
    await this.registerMissionInvocation(mission.id, context.controller);
    let completed = false;

    try {
      await this.waitWhilePaused(context.controller);
      await this.runParallel(
        mission.rootSessions.map((session) =>
          this.executeSession(session, context, accountingMissionIds),
        ),
        context.controller,
      );
      completed = true;
    } catch (error) {
      if (!context.controller.abortController.signal.aborted) {
        context.controller.stopReason = "failure";
        context.controller.abortController.abort();
        await this.abortActiveSessions(context.controller);
      }
      throw error;
    } finally {
      await this.unregisterMissionInvocation(mission.id, context.controller, completed);
    }
  }

  private async executeSession(
    session: SessionInfo,
    context: ExecutionContext,
    accountingMissionIds: string[],
  ): Promise<void> {
    const signal = context.controller.abortController.signal;
    const key = sessionKey(session);
    const sessionSemaphore = this.sessionSemaphores.get(key) ?? new AsyncSemaphore(1);
    this.sessionSemaphores.set(key, sessionSemaphore);

    while (true) {
      await this.waitWhilePaused(context.controller);
      const releaseSession = await sessionSemaphore.acquire(signal);
      let releaseGlobal: (() => void) | null = null;
      try {
        if (context.controller.paused) continue;
        const available = await this.waitUntilSessionIdle(session, context.controller);
        if (!available) continue;

        releaseGlobal = await this.semaphore.acquire(signal);
        if (context.controller.paused) continue;
        if (!(await this.isSessionIdle(session, signal))) continue;
        if (context.controller.paused) continue;
        this.throwIfAborted(signal);

        context.controller.activeSessions.set(key, session);
        this.activeMissionSessions.set(key, { session, context, accountingMissionIds });
        const pendingRun = this.createPendingSessionRun(session.id, signal);
        // The abort signal may reject completion while promptAsync is still in flight.
        void pendingRun.promise.catch(() => undefined);
        const startedAtMs = Date.now();
        const promptPromise = opencodeClient.session.promptAsync({
          sessionID: session.id,
          directory: session.directory,
          parts: [{ type: "text", text: context.prompt }],
          agent: context.agent,
          ...(context.model.providerID && context.model.modelID
            ? {
                model: {
                  providerID: context.model.providerID,
                  modelID: context.model.modelID,
                },
              }
            : {}),
          ...(context.model.variant ? { variant: context.model.variant } : {}),
        });
        const { error } = await promptPromise;
        if (error) {
          const detail = this.getAssistantErrorMessage(error);
          const message = `Failed to start session ${session.title}${detail ? `: ${detail}` : ""}`;
          pendingRun.reject(new MissionSessionError(message));
          await pendingRun.promise.catch(() => undefined);
          throw new MissionSessionError(message);
        }
        if (signal.aborted) {
          await this.abortSession(session);
          this.throwIfAborted(signal);
        }

        void this.pollSessionCompletion(session, startedAtMs, signal).then(
          pendingRun.resolve,
          pendingRun.reject,
        );
        await pendingRun.promise;
        await this.updateSessionRunStats(accountingMissionIds, true);
        return;
      } catch (error) {
        if (error instanceof MissionAgentDroppedError && !signal.aborted) {
          await this.updateSessionRunStats(accountingMissionIds, false);
          return;
        }
        if (error instanceof MissionInterruptedError || signal.aborted) throw error;

        await this.abortSession(session);
        await this.updateSessionRunStats(accountingMissionIds, false);
        this.emitSessionFailure({
          sessionTitle: session.title,
          message: this.getAssistantErrorMessage(error) || "Unknown session error",
        });
        logger.warn(
          `[MissionRuntime] Session failed locally; mission continues: id=${session.id}, directory=${session.directory}`,
          error,
        );
        return;
      } finally {
        context.controller.activeSessions.delete(key);
        this.activeMissionSessions.delete(key);
        this.clearPermissionRecoveriesForRoot(session.id);
        releaseGlobal?.();
        releaseSession();
      }
    }
  }

  private async waitUntilSessionIdle(
    session: SessionInfo,
    controller: MissionRunController,
  ): Promise<boolean> {
    const signal = controller.abortController.signal;
    while (true) {
      this.throwIfAborted(signal);
      if (controller.paused) return false;
      if (await this.isSessionIdle(session, signal)) return true;
      await sleep(STATUS_POLL_INTERVAL_MS, signal);
    }
  }

  private async isSessionIdle(session: SessionInfo, signal: AbortSignal): Promise<boolean> {
    this.throwIfAborted(signal);
    const { data, error } = await opencodeClient.session.status({ directory: session.directory });
    this.throwIfAborted(signal);
    if (error || !data) return false;
    return (data as Record<string, { type?: string }>)[session.id]?.type !== "busy";
  }

  private async pollSessionCompletion(
    session: SessionInfo,
    startedAtMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    while (this.pendingSessionRuns.has(session.id)) {
      this.throwIfAborted(signal);
      if (this.hasPermissionRecoveryForRoot(session.id)) {
        await sleep(STATUS_POLL_INTERVAL_MS, signal);
        continue;
      }
      try {
        await this.processPendingPermissionRequests(session, signal);
        if (this.hasPermissionRecoveryForRoot(session.id)) continue;
        const { data, error } = await opencodeClient.session.messages({
          sessionID: session.id,
          directory: session.directory,
        });
        this.throwIfAborted(signal);
        if (!error && data) {
          const message = this.findCompletedAssistantMessage(
            data as AssistantMessageSnapshot[],
            startedAtMs,
          );
          if (message) {
            const errorMessage = this.getAssistantErrorMessage(message.info.error);
            if (errorMessage) throw new MissionSessionError(errorMessage);
            if (this.getAssistantFinishReason(message) !== "tool-calls") return;
            if (await this.isSessionIdle(session, signal)) return;
          }
        }
      } catch (error) {
        if (
          error instanceof MissionInterruptedError ||
          error instanceof MissionSessionError ||
          signal.aborted
        ) {
          throw error;
        }
        logger.debug(
          `[MissionRuntime] Completion poll failed: session=${session.id}, directory=${session.directory}`,
          error,
        );
      }
      if (!this.pendingSessionRuns.has(session.id)) return;
      await sleep(STATUS_POLL_INTERVAL_MS, signal);
    }
  }

  private findCompletedAssistantMessage(
    messages: AssistantMessageSnapshot[],
    startedAtMs: number,
  ): AssistantMessageSnapshot | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      const createdAt = message?.info.time?.created;
      if (
        message?.info.role !== "assistant" ||
        message.info.summary ||
        typeof createdAt !== "number" ||
        createdAt < startedAtMs
      ) {
        continue;
      }
      if (this.getAssistantErrorMessage(message.info.error)) return message;
      if (!message.info.time?.completed) return null;
      return message;
    }
    return null;
  }

  private getAssistantFinishReason(message: AssistantMessageSnapshot): string | undefined {
    const stepFinishReason = message.parts
      ?.slice()
      .reverse()
      .find((part) => part.type === "step-finish" && part.reason)?.reason;
    return stepFinishReason || message.info.finish;
  }

  private getAssistantErrorMessage(error: unknown): string | null {
    if (error instanceof Error && error.message.trim()) return error.message.trim();
    if (typeof error === "string" && error.trim()) return error.trim();
    if (!error || typeof error !== "object") return null;
    const value = error as { message?: unknown; name?: unknown; data?: { message?: unknown } };
    if (typeof value.data?.message === "string" && value.data.message.trim()) {
      return value.data.message.trim();
    }
    if (typeof value.message === "string" && value.message.trim()) return value.message.trim();
    if (typeof value.name === "string" && value.name.trim()) return value.name.trim();
    return null;
  }

  private async processPendingPermissionRequests(
    session: SessionInfo,
    signal: AbortSignal,
  ): Promise<void> {
    this.throwIfAborted(signal);
    const { data, error } = await opencodeClient.permission.list({ directory: session.directory });
    this.throwIfAborted(signal);
    if (error || !data) return;
    for (const request of data) {
      await this.handlePermissionRequest(request, session.directory);
      this.throwIfAborted(signal);
    }
  }

  private async resolveActiveMissionSession(
    sessionId: string,
    directory: string,
  ): Promise<{ requester: SessionInfo; root: ActiveMissionSession } | null> {
    const direct = this.activeMissionSessions.get(`${directory}\0${sessionId}`);
    if (direct) return { requester: direct.session, root: direct };

    let currentId = sessionId;
    let requester: SessionInfo | null = null;
    const visited = new Set<string>();
    while (!visited.has(currentId)) {
      visited.add(currentId);
      const { data, error } = await opencodeClient.session.get({
        sessionID: currentId,
        directory,
      });
      if (error || !data) return null;
      const current = data as {
        id: string;
        title?: string;
        directory?: string;
        parentID?: string;
      };
      requester ??= {
        id: current.id,
        title: current.title || current.id,
        directory: current.directory || directory,
      };
      if (!current.parentID) return null;
      const root = this.activeMissionSessions.get(
        `${current.directory || directory}\0${current.parentID}`,
      );
      if (root) return { requester, root };
      currentId = current.parentID;
    }
    return null;
  }

  private isPermissionRecoveryActive(sessionId: string): boolean {
    for (const [key, recovery] of this.permissionRecoveries) {
      if (key.endsWith(`\0${sessionId}`) || recovery.rootSessionId === sessionId) return true;
    }
    return false;
  }

  private hasPermissionRecoveryForRoot(rootSessionId: string): boolean {
    return [...this.permissionRecoveries.values()].some(
      (recovery) => recovery.rootSessionId === rootSessionId,
    );
  }

  private clearPermissionRecovery(
    session: SessionInfo,
    rootSessionId: string,
    generation?: number,
  ): void {
    const key = sessionKey(session);
    const current = this.permissionRecoveries.get(key);
    if (
      current?.rootSessionId === rootSessionId &&
      (generation === undefined || current.generation === generation)
    ) {
      this.permissionRecoveries.delete(key);
    }
  }

  private clearPermissionRecoveriesForRoot(rootSessionId: string): void {
    for (const [key, recovery] of this.permissionRecoveries) {
      if (recovery.rootSessionId === rootSessionId) this.permissionRecoveries.delete(key);
    }
    for (const key of this.permissionRetryCounts.keys()) {
      if (key.includes(`\0${rootSessionId}\0`)) this.permissionRetryCounts.delete(key);
    }
    this.handledPermissionRequestIdsByRoot.delete(rootSessionId);
  }

  private emitPermissionRecovery(
    recovery: Exclude<MissionPermissionRecoveryResult, { handled: false }> & {
      outcome: "relaunched" | "dropped";
    },
  ): MissionPermissionRecoveryResult {
    if (this.onPermissionRecovery) {
      void Promise.resolve(this.onPermissionRecovery(recovery)).catch((error) => {
        logger.warn("[MissionRuntime] Permission recovery notification failed", error);
      });
    }
    return recovery;
  }

  private emitSessionFailure(failure: MissionSessionFailure): void {
    if (!this.onSessionFailure) return;
    void Promise.resolve(this.onSessionFailure(failure)).catch((error) => {
      logger.warn("[MissionRuntime] Session failure notification failed", error);
    });
  }

  private async dropPermissionRequester(
    requester: SessionInfo,
    root: ActiveMissionSession,
    message: string,
    abort: boolean,
  ): Promise<void> {
    if (abort) await this.abortSession(requester);
    if (requester.id === root.session.id) {
      this.pendingSessionRuns.get(root.session.id)?.reject(new MissionAgentDroppedError(message));
      return;
    }
    await this.updateSessionRunStats(root.accountingMissionIds, false);
  }

  private async pollPermissionRecovery(
    session: SessionInfo,
    root: ActiveMissionSession,
    startedAtMs: number,
    generation: number,
  ): Promise<void> {
    const signal = root.context.controller.abortController.signal;
    try {
      while (!signal.aborted) {
        const recovery = this.permissionRecoveries.get(sessionKey(session));
        if (!recovery || recovery.generation !== generation) return;
        const { data, error } = await opencodeClient.session.messages({
          sessionID: session.id,
          directory: session.directory,
        });
        if (!error && data) {
          const message = this.findCompletedAssistantMessage(
            data as AssistantMessageSnapshot[],
            startedAtMs,
          );
          if (message) {
            const errorMessage = this.getAssistantErrorMessage(message.info.error);
            if (errorMessage) throw new MissionSessionError(errorMessage);
            if (
              this.getAssistantFinishReason(message) !== "tool-calls" ||
              (await this.isSessionIdle(session, signal))
            ) {
              this.clearPermissionRecovery(session, root.session.id, generation);
              return;
            }
          }
        }
        await sleep(STATUS_POLL_INTERVAL_MS, signal);
      }
    } catch (error) {
      if (signal.aborted) return;
      this.clearPermissionRecovery(session, root.session.id, generation);
      await this.dropPermissionRequester(
        session,
        root,
        error instanceof Error ? error.message : `Agent ${session.title} retry failed`,
        true,
      );
    }
  }

  private async waitWhilePaused(controller: MissionRunController): Promise<void> {
    if (controller.abortController.signal.aborted) {
      throw new MissionInterruptedError("Mission stopped");
    }
    if (!controller.paused) return;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        controller.pauseWaiters.delete(onResume);
        reject(new MissionInterruptedError("Mission stopped"));
      };
      const onResume = () => {
        controller.abortController.signal.removeEventListener("abort", onAbort);
        resolve();
      };
      controller.pauseWaiters.add(onResume);
      controller.abortController.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new MissionInterruptedError("Mission stopped");
  }

  private createPendingSessionRun(
    sessionId: string,
    signal: AbortSignal,
  ): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
    this.throwIfAborted(signal);
    if (this.pendingSessionRuns.has(sessionId)) {
      throw new Error(`Session ${sessionId} already has a pending mission run`);
    }

    let resolvePromise: () => void = () => undefined;
    let rejectPromise: (error: Error) => void = () => undefined;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      if (this.pendingSessionRuns.get(sessionId) === pending) {
        this.pendingSessionRuns.delete(sessionId);
      }
    };
    const pending: PendingSessionRun = {
      resolve: () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise();
      },
      reject: (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(error);
      },
    };
    const onAbort = () => pending.reject(new MissionInterruptedError("Mission stopped"));
    this.pendingSessionRuns.set(sessionId, pending);
    signal.addEventListener("abort", onAbort, { once: true });
    return { promise, resolve: pending.resolve, reject: pending.reject };
  }

  private async runParallel(
    operations: Promise<void>[],
    controller: MissionRunController,
  ): Promise<void> {
    if (operations.length === 0) return;
    try {
      await Promise.all(operations);
    } catch (error) {
      if (!controller.abortController.signal.aborted) {
        controller.stopReason = "failure";
        controller.abortController.abort();
      }
      await this.abortActiveSessions(controller);
      await Promise.allSettled(operations);
      throw error;
    }
  }

  private async registerMissionInvocation(
    missionId: string,
    controller: MissionRunController,
  ): Promise<void> {
    const wasInvokedByController = controller.invokedMissionIds.has(missionId);
    controller.invokedMissionIds.add(missionId);
    const previousCount = controller.invocationCounts.get(missionId) ?? 0;
    controller.invocationCounts.set(missionId, previousCount + 1);
    const activeControllers = this.activeControllersByMissionId.get(missionId) ?? new Set();
    const wasActive = activeControllers.size > 0;
    activeControllers.add(controller);
    this.activeControllersByMissionId.set(missionId, activeControllers);
    if (missionId === controller.rootMissionId) return;

    const now = new Date().toISOString();
    await updateMission(missionId, (mission) => ({
      ...mission,
      status: controller.paused ? "paused" : "running",
      requestedRuns: wasActive || wasInvokedByController ? mission.requestedRuns + 1 : 1,
      completedRuns: wasActive || wasInvokedByController ? mission.completedRuns : 0,
      runStartedAt: wasActive || wasInvokedByController ? mission.runStartedAt : now,
      runFinishedAt: null,
      lastError: null,
      updatedAt: now,
    }));
  }

  private async unregisterMissionInvocation(
    missionId: string,
    controller: MissionRunController,
    completed: boolean,
  ): Promise<void> {
    const remainingForController = (controller.invocationCounts.get(missionId) ?? 1) - 1;
    if (remainingForController > 0) {
      controller.invocationCounts.set(missionId, remainingForController);
    } else {
      controller.invocationCounts.delete(missionId);
      const activeControllers = this.activeControllersByMissionId.get(missionId);
      activeControllers?.delete(controller);
      if (activeControllers?.size === 0) this.activeControllersByMissionId.delete(missionId);
    }
    if (missionId === controller.rootMissionId) return;

    const stillActive = (this.activeControllersByMissionId.get(missionId)?.size ?? 0) > 0;
    const finishedAt = new Date().toISOString();
    await updateMission(missionId, (mission) => ({
      ...mission,
      completedRuns: mission.completedRuns + (completed ? 1 : 0),
      status: stillActive
        ? mission.status
        : controller.stopReason === "manual" || controller.stopReason === "timeout"
          ? "stopped"
          : controller.stopReason === "failure"
            ? "failed"
            : "completed",
      runFinishedAt: stillActive ? null : finishedAt,
      lastError:
        !stillActive && controller.stopReason === "timeout"
          ? "Mission timeout reached"
          : !stillActive && controller.stopReason === "failure"
            ? "Parent mission failed"
            : mission.lastError,
      updatedAt: finishedAt,
    }));
  }

  private getControllersForMission(missionId: string): Set<MissionRunController> {
    const result = new Set(this.activeControllersByMissionId.get(missionId) ?? []);
    const directController = this.controllers.get(missionId);
    if (directController) result.add(directController);
    return result;
  }

  private async updateControllerMissionStatuses(
    controllers: Set<MissionRunController>,
    status: Mission["status"],
  ): Promise<void> {
    const now = new Date().toISOString();
    const missionIds = new Set<string>();
    for (const controller of controllers) {
      missionIds.add(controller.rootMissionId);
      for (const missionId of controller.invocationCounts.keys()) missionIds.add(missionId);
    }
    await Promise.all(
      [...missionIds].map((missionId) =>
        updateMission(missionId, (mission) => ({ ...mission, status, updatedAt: now })),
      ),
    );
  }

  private async updateSessionRunStats(missionIds: string[], succeeded: boolean): Promise<void> {
    const now = new Date().toISOString();
    await Promise.all(
      [...new Set(missionIds)].map((missionId) =>
        updateMission(missionId, (mission) => ({
          ...mission,
          totalSessionRuns: mission.totalSessionRuns + (succeeded ? 1 : 0),
          failedSessionRuns: mission.failedSessionRuns + (succeeded ? 0 : 1),
          updatedAt: now,
        })),
      ),
    );
  }

  private scheduleTimeout(controller: MissionRunController, expiresAt: number): void {
    if (controller.abortController.signal.aborted) return;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      controller.stopReason = "timeout";
      controller.abortController.abort();
      void this.abortActiveSessions(controller);
      return;
    }
    controller.timeout = setTimeout(
      () => this.scheduleTimeout(controller, expiresAt),
      Math.min(remaining, MAX_TIMER_DELAY_MS),
    );
    controller.timeout.unref?.();
  }

  private async abortActiveSessions(controller: MissionRunController): Promise<void> {
    const activeSessions = [...controller.activeSessions.values()];
    const activeRootSessionIds = new Set(activeSessions.map((session) => session.id));
    for (const recovery of this.permissionRecoveries.values()) {
      if (activeRootSessionIds.has(recovery.rootSessionId)) activeSessions.push(recovery.session);
    }
    const uniqueSessions = new Map(activeSessions.map((session) => [sessionKey(session), session]));
    await Promise.all([...uniqueSessions.values()].map((session) => this.abortSession(session)));
  }

  private async abortSession(session: SessionInfo): Promise<void> {
    try {
      const { error } = await opencodeClient.session.abort({
        sessionID: session.id,
        directory: session.directory,
      });
      if (error) {
        logger.warn(`[MissionRuntime] Failed to abort session: id=${session.id}`, error);
      }
    } catch (error) {
      logger.warn(`[MissionRuntime] Failed to abort session: id=${session.id}`, error);
    }
  }
}

export const missionRuntime = new MissionRuntime();
