import type { CommandContext, Context } from "grammy";
import { formatSessionActivityStatus } from "../../app/managers/session-status-manager.js";
import { listWorkingSessions } from "../../app/services/working-session-service.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";

export async function workingCommand(ctx: CommandContext<Context>): Promise<void> {
  try {
    const sessions = await listWorkingSessions();
    if (sessions.length === 0) {
      await ctx.reply(t("working.empty"));
      return;
    }

    const lines = sessions.map((session) =>
      t("working.line", {
        status: formatSessionActivityStatus(session.status),
        title: session.title,
        project: session.projectName,
      }),
    );
    await ctx.reply(`${t("working.header")}\n\n${lines.join("\n")}`);
  } catch (error) {
    logger.error("[WorkingSessions] Failed to list working sessions", error);
    await ctx.reply(t("working.error"));
  }
}
