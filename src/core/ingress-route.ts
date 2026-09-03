/**
 * Ingress 路由引擎：把规范化后的 IngressEvent 按声明规则匹配到目标飞书群与
 * 应被 @ 的 Bot。规则支持来源、事件类型、实体键前缀与元数据的 glob 通配匹配，
 * 按 priority 降序取第一条命中（缺省按声明顺序）。纯函数，便于单测。
 */
import { z } from "zod";
import type { IngressEvent } from "./ingress-event.js";

export const IngressRouteMatchSchema = z.object({
  /** 来源精确匹配：github | sentry | generic。 */
  source: z.string().optional(),
  /** 事件类型 glob，如 "pull_request.*"、"alert.triggered"。 */
  eventType: z.string().optional(),
  /** 实体键 glob，如 "owner/repo/pull/*"。 */
  entity: z.string().optional(),
  /** 元数据等值匹配（支持 glob 值），如 { repo: "owner/*", severity: "error" }。 */
  metadata: z.record(z.string(), z.string()).optional(),
});

export const IngressRouteRuleSchema = z.object({
  id: z.string().min(1),
  match: IngressRouteMatchSchema.default({}),
  /** 目标飞书群 chat_id。 */
  chatId: z.string().min(1),
  /** 应被 @ 的 Bot id 列表；为空则只建话题不 @。 */
  mentionBots: z.array(z.string()).default([]),
  /** 路由优先级，数值越大越先匹配；缺省 0。 */
  priority: z.number().int().optional(),
  enabled: z.boolean().optional(),
});

export type IngressRouteRule = z.infer<typeof IngressRouteRuleSchema>;

export type IngressRouteMatch = Pick<IngressRouteRule, "match">["match"];

export interface RouteOutcome {
  rule: IngressRouteRule;
  /** 规范化事件与规则共同计算出的路由动作。 */
  chatId: string;
  mentionBots: string[];
}

/** 把 glob 模式编译为正则：`*` 匹配任意非空串，其余按字面量。 */
function compileGlob(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped.replace(/\*/g, ".*");
  return new RegExp(`^${body}$`);
}

/** 单条匹配条件判断：undefined 表示不过滤该维度。 */
function matchesGlob(pattern: string | undefined, value: string): boolean {
  if (pattern === undefined || pattern === "") return true;
  return compileGlob(pattern).test(value);
}

/** 事件是否命中规则（所有已声明的维度都命中才算）。 */
export function eventMatchesRule(
  event: IngressEvent,
  rule: IngressRouteRule,
): boolean {
  if (rule.enabled === false) return false;
  const match = rule.match;
  if (!matchesGlob(match.source, event.source)) return false;
  if (!matchesGlob(match.eventType, event.eventType)) return false;
  if (!matchesGlob(match.entity, event.entityId)) return false;
  if (match.metadata) {
    for (const [key, pattern] of Object.entries(match.metadata)) {
      const value = event.metadata[key];
      const asString =
        typeof value === "string" ? value : JSON.stringify(value);
      if (!matchesGlob(pattern, asString)) return false;
    }
  }
  return true;
}

/** 按 priority 降序（稳定：同优先级保持声明顺序）筛选命中规则。 */
export function matchIngressEvent(
  event: IngressEvent,
  rules: IngressRouteRule[],
): RouteOutcome | undefined {
  const sorted = [...rules].sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
  );
  for (const rule of sorted) {
    if (eventMatchesRule(event, rule)) {
      return { rule, chatId: rule.chatId, mentionBots: rule.mentionBots };
    }
  }
  return undefined;
}
