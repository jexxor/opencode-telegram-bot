import { randomUUID } from "node:crypto";
import { logger } from "../../utils/logger.js";
import { sessionPromptQueueRuntime } from "./session-prompt-queue-runtime-service.js";
import {
  addQueuedSessionPrompt,
  removeQueuedSessionPrompt,
  removeQueuedSessionPromptsByAgentLoopId,
} from "../stores/session-prompt-queue-store.js";
import {
  getAgentLoop,
  listAgentLoops,
  removeAgentLoop,
  updateAgentLoop,
} from "../stores/agent-loop-store.js";
import type { AgentLoop } from "../types/loop.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const RETRY_DELAY_MS = 60_000;
export const AGENT_LOOP_TERMINAL_MARKER = "STOP_LOOP_REASON_TERMINAL";
const AGENT_LOOP_TERMINAL_INSTRUCTION =
  `If there is no remaining work and every feature described in the primary goal is fully ` +
  `implemented, respond with the exact token ${AGENT_LOOP_TERMINAL_MARKER} on its own line.`;

function hasTerminalMarker(messageText: string): boolean {
  return messageText
    .split(/\r?\n/)
    .some((line) => line.trim() === AGENT_LOOP_TERMINAL_MARKER);
}

export class AgentLoopRuntime {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private runningLoopIds = new Set<string>();
  private initialized = false;

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    for (const loop of listAgentLoops()) this.schedule(loop);
  }

  registerLoop(loop: AgentLoop): void {
    if (this.initialized) this.schedule(loop);
  }

  async runNow(loopId: string): Promise<AgentLoop | null> {
    await removeQueuedSessionPromptsByAgentLoopId(loopId);
    const now = Date.now();
    const startedAt = new Date(now).toISOString();
    const loop = await updateAgentLoop(loopId, (current) => ({
      ...current,
      status: "running",
      currentStepIndex: 0,
      completedCycles: 0,
      runStartedAt: startedAt,
      runStoppedAt: null,
      nextRunAt: startedAt,
      expiresAt: current.timeoutMinutes
        ? new Date(now + current.timeoutMinutes * 60_000).toISOString()
        : null,
      stopReason: null,
    }));
    if (loop) this.schedule(loop);
    return loop;
  }

  async stop(loopId: string): Promise<AgentLoop | null> {
    this.clearTimer(loopId);
    const loop = await updateAgentLoop(loopId, (current) => ({
      ...current,
      status: "stopped",
      nextRunAt: null,
      expiresAt: null,
      runStoppedAt: new Date().toISOString(),
      stopReason: "manual",
    }));
    await removeQueuedSessionPromptsByAgentLoopId(loopId);
    return loop;
  }

  async handleAssistantResponse(
    loopId: string,
    messageText: string,
    expectedRunStartedAt?: string,
  ): Promise<boolean> {
    if (!hasTerminalMarker(messageText)) return false;
    let stopped = false;
    await updateAgentLoop(loopId, (current) => {
      if (
        current.status !== "running" ||
        (expectedRunStartedAt && current.runStartedAt !== expectedRunStartedAt)
      ) {
        return current;
      }
      stopped = true;
      return {
        ...current,
        status: "stopped",
        nextRunAt: null,
        expiresAt: null,
        runStoppedAt: new Date().toISOString(),
        stopReason: "terminal",
      };
    });
    if (!stopped) return false;
    const latest = getAgentLoop(loopId);
    if (
      !latest ||
      latest.status !== "stopped" ||
      latest.stopReason !== "terminal" ||
      (expectedRunStartedAt && latest.runStartedAt !== expectedRunStartedAt)
    ) {
      return true;
    }
    this.clearTimer(loopId);
    await removeQueuedSessionPromptsByAgentLoopId(loopId);
    logger.info(`[AgentLoopRuntime] Loop stopped by terminal marker: id=${loopId}`);
    return true;
  }

  async delete(loopId: string): Promise<boolean> {
    this.clearTimer(loopId);
    const removed = await removeAgentLoop(loopId);
    await removeQueuedSessionPromptsByAgentLoopId(loopId);
    return removed;
  }

  shutdown(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.runningLoopIds.clear();
    this.initialized = false;
  }

  __resetForTests(): void {
    this.shutdown();
  }

  private schedule(loop: AgentLoop): void {
    this.clearTimer(loop.id);
    if (loop.status !== "running" || !loop.nextRunAt || loop.steps.length === 0) return;
    const nextRunAt = Date.parse(loop.nextRunAt);
    const expiresAt = loop.expiresAt ? Date.parse(loop.expiresAt) : Number.POSITIVE_INFINITY;
    const timeoutFirst = expiresAt <= Date.now() || expiresAt <= nextRunAt;
    const scheduledAt = timeoutFirst ? expiresAt : nextRunAt;
    const delay = Math.max(0, scheduledAt - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(loop.id);
      if (delay > MAX_TIMER_DELAY_MS) {
        const current = getAgentLoop(loop.id);
        if (current) this.schedule(current);
        return;
      }
      if (timeoutFirst) {
        void this.expire(loop.id, loop.expiresAt!);
      } else {
        void this.dispatch(loop.id);
      }
    }, Math.min(delay, MAX_TIMER_DELAY_MS));
    timer.unref?.();
    this.timers.set(loop.id, timer);
  }

  private clearTimer(loopId: string): void {
    const timer = this.timers.get(loopId);
    if (timer) clearTimeout(timer);
    this.timers.delete(loopId);
  }

  private async expire(loopId: string, expectedExpiresAt: string): Promise<void> {
    const loop = await updateAgentLoop(loopId, (current) =>
      current.status === "running" && current.expiresAt === expectedExpiresAt
        ? {
            ...current,
            status: "stopped",
            nextRunAt: null,
            expiresAt: null,
            runStoppedAt: expectedExpiresAt,
            stopReason: "timeout",
          }
        : current,
    );
    const latest = getAgentLoop(loopId);
    if (
      loop?.stopReason === "timeout" &&
      latest?.status === "stopped" &&
      latest.stopReason === "timeout" &&
      latest.runStartedAt === loop.runStartedAt
    ) {
      await removeQueuedSessionPromptsByAgentLoopId(loopId);
      logger.info(`[AgentLoopRuntime] Loop timeout reached: id=${loopId}`);
    } else if (latest) {
      this.schedule(latest);
    }
  }

  private async dispatch(loopId: string): Promise<void> {
    if (this.runningLoopIds.has(loopId)) return;
    this.runningLoopIds.add(loopId);
    let dispatchedRunStartedAt: string | null = null;
    try {
      const loop = getAgentLoop(loopId);
      if (!loop || loop.status !== "running" || loop.steps.length === 0) return;
      dispatchedRunStartedAt = loop.runStartedAt;
      const now = new Date();
      if (loop.expiresAt && Date.parse(loop.expiresAt) <= now.getTime()) {
        await this.expire(loop.id, loop.expiresAt);
        return;
      }
      const stepIndex = loop.currentStepIndex % loop.steps.length;
      const step = loop.steps[stepIndex];
      const queuedPromptId = randomUUID();
      const dispatchedAt = now.toISOString();
      await addQueuedSessionPrompt({
        id: queuedPromptId,
        sessionId: step.id,
        sessionTitle: step.title,
        directory: step.directory,
        text: `${loop.prompt}\n\n${AGENT_LOOP_TERMINAL_INSTRUCTION}`,
        agent: loop.agent,
        agentLoopId: loop.id,
        agentLoopRunStartedAt: loop.runStartedAt,
        model: {
          providerID: loop.model.providerID,
          modelID: loop.model.modelID,
          ...(loop.model.variant ? { variant: loop.model.variant } : {}),
        },
        createdAt: dispatchedAt,
      });
      const updated = await updateAgentLoop(loop.id, (current) => {
        if (
          current.status !== "running" ||
          current.runStartedAt !== loop.runStartedAt ||
          current.nextRunAt !== loop.nextRunAt
        ) {
          return current;
        }
        return {
          ...current,
          currentStepIndex: (stepIndex + 1) % current.steps.length,
          completedCycles:
            current.completedCycles + (stepIndex === current.steps.length - 1 ? 1 : 0),
          lastRunAt: dispatchedAt,
          nextRunAt: new Date(now.getTime() + current.intervalMinutes * 60_000).toISOString(),
        };
      });
      if (updated?.lastRunAt !== dispatchedAt) {
        await removeQueuedSessionPrompt(queuedPromptId);
        if (updated) this.schedule(updated);
        return;
      }
      sessionPromptQueueRuntime.notifyQueueChanged();
      if (updated) this.schedule(updated);
    } catch (error) {
      logger.error(`[AgentLoopRuntime] Failed loop step: id=${loopId}`, error);
      const loop = getAgentLoop(loopId);
      if (loop?.status === "running" && loop.runStartedAt === dispatchedRunStartedAt) {
        const timer = setTimeout(() => void this.dispatch(loopId), RETRY_DELAY_MS);
        timer.unref?.();
        this.timers.set(loopId, timer);
      }
    } finally {
      this.runningLoopIds.delete(loopId);
      const current = getAgentLoop(loopId);
      if (
        dispatchedRunStartedAt &&
        current?.status === "running" &&
        current.runStartedAt !== dispatchedRunStartedAt
      ) {
        this.schedule(current);
      }
    }
  }
}

export const agentLoopRuntime = new AgentLoopRuntime();
