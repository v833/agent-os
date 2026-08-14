/**
 * lark 平台服务插件：启动多台飞书 bot，把消息与卡片回调翻译成
 * bot/message、bot/card-action 事件交给 router 等插件消费。
 * 平台是插件：替换本插件即可换掉飞书接入。
 */
import { Service, type Context } from "cordis";
import { startBot } from "../im/lark.js";
import type { BotRuntime } from "./types.js";

/** 持有已连接 bot 运行时，供协作提及、结果通知和身份查询使用。 */
export class LarkService extends Service {
  private runtimes: Map<string, BotRuntime> = new Map();

  constructor(ctx: Context) {
    super(ctx, "lark");
  }

  init(runtimes: Map<string, BotRuntime>): void {
    this.runtimes = runtimes;
  }

  bot(id: string): BotRuntime | undefined {
    return this.runtimes.get(id);
  }
}

export const name = "lark";
// 注入 sessions 保证会话先恢复再连飞书，避免恢复窗口收到消息重复建会话。
export const inject = ["config", "sessions"];

export async function apply(ctx: Context) {
  const service = new LarkService(ctx);
  const runtimes = new Map<string, BotRuntime>();

  await Promise.all(
    ctx.config.bots.map(async (botConfig) => {
      const bot = startBot({
        appId: botConfig.appId,
        appSecret: botConfig.appSecret,
        onCardAction: async (action) => {
          // serial：router 返回响应对象即短路；无人处理返回 undefined。
          return ctx.serial("bot/card-action", action, bot, botConfig);
        },
        onMessage: async (message, bot) => {
          // parallel：等 router 路由完成，错误会回传到平台回调。
          await ctx.parallel("bot/message", message, bot, botConfig);
        },
      });
      const identity = await bot.getIdentity();
      runtimes.set(botConfig.id, { config: botConfig, bot, identity });
      console.log(
        `[Bot ${botConfig.id.toUpperCase()}] 已连接 name=${identity.name} open_id=${identity.openId}`,
      );
    }),
  );

  service.init(runtimes);
}
