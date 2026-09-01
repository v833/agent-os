/**
 * 定时任务核心模型：三种调度规则（一次性 / 固定间隔 / Cron）、计划结构、
 * 创建工厂与 schedule_manage 统一管理请求。这里只有纯类型与校验，
 * 命令、工具和 API 都走同一份 Zod Schema，保证非法输入在入口就被挡下。
 */
import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import { z } from "zod";

/** schedule 插件注册到应用工具服务的稳定工具名。 */
export const SCHEDULE_MANAGE_TOOL_NAME = "schedule_manage";

/** 调度规则：一次性、固定间隔或 Cron，三者取一。 */
const CronRuleSchema = z
  .object({
    kind: z.literal("cron"),
    expression: z.string().trim().min(1).max(100),
    timezone: z.string().trim().min(1).default("Asia/Shanghai"),
  })
  .superRefine((rule, context) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: rule.timezone });
    } catch {
      context.addIssue({
        code: "custom",
        path: ["timezone"],
        message: "时区无效",
      });
      return;
    }
    try {
      // paused 避免校验表达式时创建实际计时器。
      new Cron(rule.expression, { timezone: rule.timezone, paused: true });
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["expression"],
        message: `Cron 表达式无效：${(error as Error).message}`,
      });
    }
  });

export const ScheduleRuleSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("once"),
    runAt: z.iso.datetime(),
  }),
  z.object({
    kind: z.literal("interval"),
    everyMs: z.number().int().min(60_000).max(24 * 60 * 60 * 1000),
  }),
  CronRuleSchema,
]);

export type ScheduleRule = z.infer<typeof ScheduleRuleSchema>;

/** 一条长期保存的定时任务计划；运行状态与运行记录分离存储。 */
export interface ScheduledTask {
  id: string;
  creatorOpenId: string;
  chatId: string;
  targetBotId: string;
  prompt: string;
  rule: ScheduleRule;
  status: "active" | "paused" | "completed";
  nextRunAt?: string;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** 创建一条计划所需的全部参数；id、时间戳与状态由工厂补齐。 */
export interface CreateScheduledTask {
  creatorOpenId: string;
  chatId: string;
  targetBotId: string;
  prompt: string;
  rule: ScheduleRule;
}

/** 用短随机 id 创建一条 active 计划；id 保持 [a-z0-9] 便于命令行 pause 匹配。 */
export function createScheduledTask(
  options: CreateScheduledTask & { id?: string },
): ScheduledTask {
  const now = new Date().toISOString();
  const rule = ScheduleRuleSchema.parse(options.rule);
  return {
    id: options.id ?? randomUUID().replaceAll("-", "").slice(0, 12),
    creatorOpenId: options.creatorOpenId,
    chatId: options.chatId,
    targetBotId: options.targetBotId,
    prompt: options.prompt,
    rule,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}

/** 把固定间隔换算成人类可读的“每 N 分钟/小时/天”。 */
function formatEvery(everyMs: number): string {
  const minutes = everyMs / 60_000;
  if (everyMs % (24 * 60 * 60 * 1000) === 0) {
    return `每 ${everyMs / (24 * 60 * 60 * 1000)} 天`;
  }
  if (everyMs % (60 * 60 * 1000) === 0) {
    return `每 ${everyMs / (60 * 60 * 1000)} 小时`;
  }
  return `每 ${minutes} 分钟`;
}

/** 把规则转成适合列表展示的一句话描述。 */
export function scheduleDescription(rule: ScheduleRule): string {
  if (rule.kind === "once") return `一次性 ${rule.runAt}`;
  if (rule.kind === "interval") return formatEvery(rule.everyMs);
  return `Cron ${rule.expression}`;
}

/** 创建单条计划的入参；schedule_manage 的 add 与 API 创建共用。 */
export const ScheduleAddSchema = z.object({
  targetBotId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  prompt: z.string().trim().min(1).max(2_000),
  rule: ScheduleRuleSchema,
});

export type ScheduleAddRequest = z.infer<typeof ScheduleAddSchema>;

/** API 直接创建计划的完整入参，额外带上话题归属与发起人。 */
export const CreateScheduledTaskSchema = z.object({
  creatorOpenId: z.string().min(1),
  chatId: z.string().min(1),
  targetBotId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  prompt: z.string().trim().min(1).max(2_000),
  rule: ScheduleRuleSchema,
});

/** schedule_manage 统一管理请求：用 action 区分十一种操作。 */
export const ScheduleManageRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }),
  z.object({ action: z.literal("add"), ...ScheduleAddSchema.shape }),
  z.object({
    action: z.literal("addMany"),
    schedules: z.array(ScheduleAddSchema).min(1).max(20),
  }),
  z.object({
    action: z.literal("update"),
    id: z.string().trim().min(1).max(64),
    targetBotId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/).optional(),
    prompt: z.string().trim().min(1).max(2_000).optional(),
    rule: ScheduleRuleSchema.optional(),
  }),
  z.object({ action: z.literal("remove"), id: z.string().trim().min(1).max(64) }),
  z.object({
    action: z.literal("removeMany"),
    ids: z.array(z.string().trim().min(1)).min(1).max(100),
  }),
  z.object({ action: z.literal("removeAll"), confirm: z.literal(true) }),
  z.object({ action: z.literal("run"), id: z.string().trim().min(1).max(64) }),
  z.object({ action: z.literal("pause"), id: z.string().trim().min(1).max(64) }),
  z.object({ action: z.literal("resume"), id: z.string().trim().min(1).max(64) }),
  z.object({ action: z.literal("logs"), id: z.string().trim().min(1).optional() }),
]);

export type ScheduleManageRequest = z.infer<typeof ScheduleManageRequestSchema>;
