import { describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { helpCommand } from "../../../src/bot/commands/help-command.js";
import { getLocalizedBotCommands } from "../../../src/bot/commands/definitions.js";

describe("bot/commands/help-command", () => {
  it("returns full commands list from centralized definitions", async () => {
    const replyMock = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      reply: replyMock,
    } as unknown as Context;

    await helpCommand(ctx);

    expect(replyMock).toHaveBeenCalledTimes(1);

    const helpText = replyMock.mock.calls[0][0] as string;
    const commands = getLocalizedBotCommands();

    for (const item of commands) {
      expect(helpText).toContain(`/${item.command}`);
      expect(helpText).toContain(item.description);
    }
  });

  it("uses homogeneous descriptions without emoji for mission commands", () => {
    const commands = getLocalizedBotCommands();

    expect(commands.find((item) => item.command === "mission")?.description).toBe(
      "Create a mission",
    );
    expect(commands.find((item) => item.command === "missions")?.description).toBe(
      "Manage missions",
    );
  });
});
