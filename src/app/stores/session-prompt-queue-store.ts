import type { QueuedSessionPrompt } from "../types/session.js";
import {
  getQueuedSessionPrompts,
  setQueuedSessionPrompts,
} from "./settings-store.js";

let mutationQueue: Promise<unknown> = Promise.resolve();

function clone(prompt: QueuedSessionPrompt): QueuedSessionPrompt {
  return { ...prompt, model: { ...prompt.model } };
}

export function listQueuedSessionPrompts(): QueuedSessionPrompt[] {
  return getQueuedSessionPrompts().map(clone);
}

export async function addQueuedSessionPrompt(prompt: QueuedSessionPrompt): Promise<number> {
  const mutation = mutationQueue.then(async () => {
    const prompts = listQueuedSessionPrompts();
    prompts.push(clone(prompt));
    await setQueuedSessionPrompts(prompts);
    return prompts.filter((item) => item.sessionId === prompt.sessionId).length;
  });
  mutationQueue = mutation.catch(() => undefined);
  return mutation;
}

export async function removeQueuedSessionPrompt(promptId: string): Promise<void> {
  const mutation = mutationQueue.then(async () => {
    await setQueuedSessionPrompts(
      listQueuedSessionPrompts().filter((prompt) => prompt.id !== promptId),
    );
  });
  mutationQueue = mutation.catch(() => undefined);
  await mutation;
}

export async function removeQueuedSessionPromptsByAgentLoopId(agentLoopId: string): Promise<void> {
  const mutation = mutationQueue.then(async () => {
    await setQueuedSessionPrompts(
      listQueuedSessionPrompts().filter((prompt) => prompt.agentLoopId !== agentLoopId),
    );
  });
  mutationQueue = mutation.catch(() => undefined);
  await mutation;
}
