/**
 * lark 平台服务插件：启动多台飞书 bot，把消息与卡片回调翻译成
 * bot/message、bot/card-action、bot/document-comment 事件交给其他插件消费。
 * 平台是插件：替换本插件即可换掉飞书接入。
 */
import { Service, type Context } from "cordis";
import { startBot, type BotConnectionState } from "../im/lark.js";
import type { BotRuntime } from "./types.js";

/** 持有已启动 bot 运行时，供协作提及、结果通知和身份查询使用。 */
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

  /** 返回入站 WS 的真实状态；运行时身份存在不等于长连接已握手。 */
  connectionState(id: string): BotConnectionState | undefined {
    return this.runtimes.get(id)?.bot.getConnectionState?.();
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
        onConnectionState: (state) => {
          console.log(
            `[Bot ${botConfig.id.toUpperCase()}] 长连接状态=${state}`,
          );
        },
        onCardAction: async (action) => {
          // serial：router 返回响应对象即短路；无人处理返回 undefined。
          return ctx.serial("bot/card-action", action, bot, botConfig);
        },
        onDocumentComment: botConfig.skills.includes("lark-drive")
          ? async (comment, bot) => {
              await ctx.parallel(
                "bot/document-comment",
                comment,
                bot,
                botConfig,
              );
            }
          : undefined,
        onMessage: async (message, bot) => {
          // parallel：等 router 路由完成，错误会回传到平台回调。
          await ctx.parallel("bot/message", message, bot, botConfig);
        },
      });
      const identity = await bot.getIdentity();
      runtimes.set(botConfig.id, { config: botConfig, bot, identity });
      console.log(
        `[Bot ${botConfig.id.toUpperCase()}] 身份已就绪 name=${identity.name} open_id=${identity.openId} ws=${bot.getConnectionState?.() ?? "unknown"}`,
      );
    }),
  );

  service.init(runtimes);
}
