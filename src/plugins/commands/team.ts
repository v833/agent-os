/**
 * /team 命令插件：展示当前 Agent 团队的成员、职责、执行引擎与连接状态。
 * 数据来自 team 服务与 lark 运行时，角色无需重复维护。
 * 卡片统一经 ctx.cards 服务出口生成，不直接导入渲染实现。
 * 在 cordis.yml 中移除本插件即可下线 /team。
 */
import type { Context } from "cordis";
import type { CommandHandler } from "../types.js";

function createHandler(pluginCtx: Context): CommandHandler {
  return async ({ bot, message, hasThread }) => {
    // 只依赖 team 服务契约（成员名册与 Leader），不穿透到具体 TeamRegistry 实现。
    const members = pluginCtx.team.members;
    const leaderBotId = pluginCtx.team.leaderBotId;
    await bot.replyCard(
      message.messageId,
      pluginCtx.cards.team({
        members: members.map((member) => {
          const runtime = pluginCtx.lark.bot(member.id);
          return {
            id: member.id,
            displayName: runtime?.identity.name ?? member.id,
            role: member.role,
            cliName: pluginCtx.cli.get(
              member.defaultCliId,
              member.accessMode,
            ).displayName,
            skills: member.skills,
            isLeader: member.id === leaderBotId,
            ready: pluginCtx.lark.connectionState(member.id) === "connected",
          };
        }),
      }),
      hasThread,
    );
  };
}

export const name = "commands/team";
export const inject = ["commands", "team", "lark", "cli", "cards"];

export function apply(ctx: Context) {
  ctx.commands.register("team", createHandler(ctx));
}
