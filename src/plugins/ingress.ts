/**
 * ingress 插件：把外部 Webhook 事件接入 ThreadPilot 飞书群。
 * 装配 Ingress 网关（验签/防重放/规范化）、规则路由引擎与实体→话题 1:1 映射：
 * 首次事件在目标群建根消息并 @ 目标 bot，后续事件在同一话题内追加，
 * 保持增量上下文；关闭型事件（PR 合并/告警解决）追加总结并标记 closed。
 */
import { Service, type Context } from "cordis";
import { resolve } from "node:path";
import { z } from "zod";
import { startIngressGateway } from "../core/ingress-gateway.js";
import {
  buildIngressEvent,
  type IngressEvent,
} from "../core/ingress-event.js";
import {
  IngressRouteRuleSchema,
  matchIngressEvent,
  type IngressRouteRule,
} from "../core/ingress-route.js";
import {
  EntityTopicSchema,
  JsonEntityTopicStore,
  entityKeyOf,
  type EntityTopic,
} from "../core/entity-topic-store.js";
import type { IngressAuthConfig } from "../core/ingress-gateway.js";
import type { BotRuntime } from "./types.js";

export const IngressConfigSchema = z.object({
  /** 映射存储路径；缺省 data/entity-topics.json。 */
  storePath: z.string().optional(),
  /** 监听地址；缺省 0.0.0.0（供 GitHub/Sentry 等外部来源回调）。反向代理同机部署可配 127.0.0.1。 */
  host: z.string().optional(),
  /** Webhook 网关端口；缺省环境变量 INGRESS_API_PORT，再缺省 3102。 */
  port: z.number().int().optional(),
  /** 各来源验签配置。 */
  auth: z.record(z.string(), z.unknown()).default({}),
  /** 路由规则列表。 */
  rules: z.array(IngressRouteRuleSchema).default([]),
  /** 事件消息由哪个 bot 发出；缺省第一个启用的 bot。 */
  senderBotId: z.string().optional(),
});

export type IngressConfig = z.input<typeof IngressConfigSchema>;

/** 建话题时选定的发送 bot 与目标身份解析，测试可注入。 */
export interface IngressDispatchDeps {
  botOf: (botId: string) => BotRuntime | undefined;
}

/** ingress 服务：路由与话题绑定逻辑对测试与命令开放。 */
export class IngressService extends Service {
  constructor(
    ctx: Context,
    readonly store: JsonEntityTopicStore,
    private readonly rules: IngressRouteRule[],
    private readonly senderBotId: string,
    private readonly deps: IngressDispatchDeps,
  ) {
    super(ctx, "ingress");
  }

  listRules(): IngressRouteRule[] {
    return [...this.rules];
  }

  /** 每个 entityKey 的在途建话题/追加 Promise；串行化同实体并发事件，避免重复建话题。 */
  private readonly entityLocks = new Map<string, Promise<unknown>>();

  /** 以 entityKey 为粒度串行化关键区：后到的事件等待前一事件完成后再判定/执行。 */
  private async withEntityLock<T>(
    entityKey: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.entityLocks.get(entityKey) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.entityLocks.set(entityKey, next);
    try {
      return await next;
    } finally {
      if (this.entityLocks.get(entityKey) === next) {
        this.entityLocks.delete(entityKey);
      }
    }
  }

  /** 对外主入口：规范化事件 → 路由 → 建话题/追加（同实体串行化）。 */
  async dispatch(event: IngressEvent): Promise<IngressRouteRule | undefined> {
    const outcome = matchIngressEvent(event, this.rules);
    if (!outcome) return undefined;
    const entityKey = entityKeyOf(event.source, event.entityId);
    await this.withEntityLock(entityKey, async () => {
      const existing = this.store.get(entityKey);
      if (!existing) {
        await this.createTopic(entityKey, event, outcome.rule);
      } else if (existing.status === "open") {
        await this.appendToTopic(existing, event, outcome.rule);
      } else if (!isClosingEvent(event)) {
        // closed 映射上来了新活动（非关闭事件）：重新开话题。
        await this.createTopic(entityKey, event, outcome.rule);
      }
      // existing 为 closed 且事件仍是关闭型：视为重复投递/重复关闭，幂等忽略。
    });
    return outcome.rule;
  }

  /** 首次事件：在目标群发根消息并记录映射；@ 全部目标 bot（无则纯文本）。 */
  private async createTopic(
    entityKey: string,
    event: IngressEvent,
    rule: IngressRouteRule,
  ): Promise<void> {
    const runtime = this.deps.botOf(this.senderBotId);
    if (!runtime) {
      throw new Error(`发送 bot 未就绪: ${this.senderBotId}`);
    }
    const targets = rule.mentionBots
      .map((id) => this.deps.botOf(id)?.identity)
      .filter((identity): identity is BotRuntime["identity"] => Boolean(identity));
    const text = buildEventMessage(event, rule.mentionBots);
    const rootMessageId = targets.length > 0
      ? await runtime.bot.sendMentionToChat(rule.chatId, targets, text)
      : await runtime.bot.send(rule.chatId, text);
    if (!rootMessageId) {
      throw new Error(`建话题失败: ${entityKey}`);
    }
    const now = event.receivedAt;
    const topic: EntityTopic = {
      entityKey,
      source: event.source,
      entityId: event.entityId,
      chatId: rule.chatId,
      rootMessageId,
      threadId: rootMessageId,
      status: isClosingEvent(event) ? "closed" : "open",
      firstEventAt: now,
      lastEventAt: now,
      eventCount: 1,
      lastSummary: event.title,
    };
    this.store.upsert(EntityTopicSchema.parse(topic));
  }

  /** 后续事件：在既有话题根消息下以子话题追加增量摘要。 */
  private async appendToTopic(
    topic: EntityTopic,
    event: IngressEvent,
    rule: IngressRouteRule,
  ): Promise<void> {
    const runtime = this.deps.botOf(this.senderBotId);
    if (!runtime) {
      throw new Error(`发送 bot 未就绪: ${this.senderBotId}`);
    }
    const text = buildEventMessage(event, rule.mentionBots);
    await runtime.bot.reply(topic.rootMessageId, text, true);
    this.store.upsert(
      EntityTopicSchema.parse({
        ...topic,
        lastEventAt: event.receivedAt,
        eventCount: topic.eventCount + 1,
        lastSummary: event.title,
        status: isClosingEvent(event) ? "closed" : topic.status,
      }),
    );
  }
}

export const name = "ingress";
export const inject = ["config", "lark"];

export async function apply(ctx: Context, config: IngressConfig = {}) {
  const parsed = IngressConfigSchema.parse(config);
  const storePath = resolve(
    process.cwd(),
    parsed.storePath ?? "data/entity-topics.json",
  );
  const store = new JsonEntityTopicStore(storePath);
  const senderBotId = parsed.senderBotId ?? ctx.config.bots[0]?.id;
  if (!senderBotId) {
    throw new Error("ingress 插件要求至少配置一个 bot");
  }

  const service = new IngressService(ctx, store, parsed.rules, senderBotId, {
    botOf: (botId) => ctx.lark.bot(botId),
  });

  const auth = parsed.auth as IngressAuthConfig;
  const host = parsed.host ?? "0.0.0.0";
  const port =
    parsed.port ?? Number(process.env.INGRESS_API_PORT ?? 3102);
  const gateway = startIngressGateway({
    auth,
    host,
    port,
    handleEvent: async (event) => {
      await service.dispatch(event);
    },
  });

  console.log(
    `[ingress] 已装配 ${parsed.rules.length} 条路由规则，话题映射 ${store.list().length} 条`,
  );

  return () => {
    gateway.close();
  };
}

/** 把事件渲染为飞书话题消息（文本风格，@ 列表以文本补充多目标场景）。 */
export function buildEventMessage(
  event: IngressEvent,
  mentionBots: string[],
): string {
  const header = `📩 [${event.source}] ${event.title}`;
  const link = event.detailUrl ? `\n${event.detailUrl}` : "";
  const meta = Object.entries(event.metadata)
    .filter(([key]) => ["repo", "branch", "severity"].includes(key))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  const mentions =
    mentionBots.length > 1
      ? `\n（已通知 ${mentionBots.length} 位成员）`
      : "";
  return `${header}${link}${meta ? `\n\`${meta}\`` : ""}${mentions}`;
}

/** 关闭型事件：PR 合并/关闭、Issue 关闭、告警解决。 */
export function isClosingEvent(event: IngressEvent): boolean {
  return (
    event.eventType === "pull_request.closed" ||
    event.eventType === "issues.closed" ||
    event.eventType === "alert.resolved"
  );
}
