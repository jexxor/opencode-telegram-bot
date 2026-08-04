import { logger } from "../../utils/logger.js";
import { cloneAgentLoop, type AgentLoop } from "../types/loop.js";
import { getAgentLoops, setAgentLoops } from "./settings-store.js";

let mutationQueue: Promise<unknown> = Promise.resolve();

async function mutate<T>(
  mutator: (loops: AgentLoop[]) => { loops: AgentLoop[]; result: T },
): Promise<T> {
  const operation = mutationQueue.then(async () => {
    const { loops, result } = mutator(listAgentLoops());
    await setAgentLoops(loops);
    return result;
  });
  mutationQueue = operation.catch(() => undefined);
  return operation;
}

export function listAgentLoops(): AgentLoop[] {
  return getAgentLoops().map(cloneAgentLoop);
}

export function getAgentLoop(loopId: string): AgentLoop | null {
  return listAgentLoops().find((loop) => loop.id === loopId) ?? null;
}

export async function addAgentLoop(loop: AgentLoop): Promise<void> {
  await mutate((loops) => ({ loops: [...loops, cloneAgentLoop(loop)], result: undefined }));
  logger.info(`[AgentLoopStore] Added loop: id=${loop.id}, steps=${loop.steps.length}`);
}

export async function updateAgentLoop(
  loopId: string,
  updater: (loop: AgentLoop) => AgentLoop,
): Promise<AgentLoop | null> {
  return mutate((loops) => {
    const index = loops.findIndex((loop) => loop.id === loopId);
    if (index < 0) return { loops, result: null };
    const updated = cloneAgentLoop(updater(cloneAgentLoop(loops[index])));
    const next = [...loops];
    next[index] = updated;
    return { loops: next, result: cloneAgentLoop(updated) };
  });
}

export async function removeAgentLoop(loopId: string): Promise<boolean> {
  return mutate((loops) => {
    const next = loops.filter((loop) => loop.id !== loopId);
    return { loops: next, result: next.length !== loops.length };
  });
}
