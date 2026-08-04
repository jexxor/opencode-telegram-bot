import type { CommandContext, Context } from "grammy";
import { config } from "../../config.js";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import { listAgentLoops } from "../../app/stores/agent-loop-store.js";
import { t } from "../../i18n/index.js";
import { buildLoopsListKeyboard } from "../menus/agent-loop-menu.js";

export async function loopsCommand(ctx: CommandContext<Context>): Promise<void> {
  const loops = listAgentLoops();
  if (loops.length === 0) {
    await ctx.reply(t("loops.empty"));
    return;
  }
  const message = await ctx.reply(t("loops.select"), {
    reply_markup: buildLoopsListKeyboard(loops, 0, config.bot.sessionsListLimit),
  });
  interactionManager.start({
    kind: "custom",
    expectedInput: "callback",
    metadata: { flow: "loops", stage: "list", messageId: message.message_id, page: 0 },
  });
}
