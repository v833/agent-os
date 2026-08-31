/**
 * schedule 定时任务服务插件：管理 cron / 自然语言周期任务。
 * 到点通过 ctx.tasks.startTask 复用现有任务流水线，把结果发回配置的飞书话题；
 * 目标话题忙碌或关闭时跳过并记录。卸载插件时统一清空 croner 定时器。
 */
import { Service, type Context } from "cordis";
import { Cron } from "croner";
import type { CliAccessMode, CliId } from "../cli/types.js";
import {
  interactionPolicyOf,
  type InteractionPolicy,
} from "../core/interaction-policy.js";
import { parseSchedule } from "../core/schedule-parser.js";
import {
  JsonScheduleStore,
  type ScheduleStore,
  type ScheduleTask,
} from "../core/schedule-store.js";

/** 创建一条定时任务所需的全部参数。 */
export interface RegisterScheduleOptions {
  schedule: string;
  prompt: string;
  botId: string;
  chatId: string;
  threadId: string;
  rootId: string;
  messageId: string;
  cliId: CliId;
  accessMode: CliAccessMode;
  workspaceDir: string;
  ownerOpenId: string;
  /** 注册入口解析出的交互策略。 */
  interaction?: InteractionPolicy;
}

/** 一次触发的结果，供命令回显与测试断言。 */
export type ScheduleTriggerOutcome =
  | { status: "started" }
  | { status: "skipped"; reason: "busy" | "closed" }
  | { status: "error"; reason: string };

const SCHEDULE_ID_RE = /^sched-(\d+)$/;

/** 从现有任务里取最大序号并 +1，生成符合示例格式的稳定 ID。 */
function nextScheduleId(tasks: Iterable<ScheduleTask>): string {
  let max = 0;
  for (const task of tasks) {
    const match = SCHEDULE_ID_RE.exec(task.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `sched-${String(max + 1).padStart(3, "0")}`;
}

/** 提供定时任务的注册、触发、查询与删除能力。 */
export class ScheduleService extends Service {
  private readonly tasks = new Map<string, ScheduleTask>();
  private readonly jobs = new Map<string, Cron>();
  private readonly timezone: string;
  private store: ScheduleStore | undefined;

  constructor(ctx: Context, timezone: string) {
    super(ctx, "schedule");
    this.timezone = timezone;
  }

  /** 恢复持久化任务并为每个启用项注册定时器；插件 apply 阶段调用。 */
  async init(store: ScheduleStore): Promise<void> {
    this.store = store;
    for (const task of await store.load()) {
      this.tasks.set(task.id, task);
      if (task.enabled) this.scheduleJob(task);
    }
    console.log(`[定时] 已恢复 ${this.tasks.size} 条定时任务`);
  }

  /**
   * 创建一条定时任务：解析周期、持久化并注册 croner 定时器。
   * 持久化完成前不返回，确保调用方拿到任务时磁盘已就绪。
   */
  async register(options: RegisterScheduleOptions): Promise<ScheduleTask> {
    const spec = parseSchedule(options.schedule);
    const now = new Date().toISOString();
    const interaction = interactionPolicyOf(options);
    const task: ScheduleTask = {
      id: nextScheduleId(this.tasks.values()),
      schedule: options.schedule,
      expr: spec.expr,
      display: spec.display,
      prompt: options.prompt,
      botId: options.botId,
      chatId: options.chatId,
      threadId: options.threadId,
      rootId: options.rootId,
      messageId: options.messageId,
      cliId: options.cliId,
      accessMode: options.accessMode,
      workspaceDir: options.workspaceDir,
      ownerOpenId: options.ownerOpenId,
      interaction,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    this.scheduleJob(task);
    await this.persist();
    return task;
  }

  list(): ScheduleTask[] {
    return [...this.tasks.values()];
  }

  get(id: string): ScheduleTask | undefined {
    return this.tasks.get(id);
  }

  /** 删除定时任务；不存在时返回 false。 */
  async remove(id: string): Promise<boolean> {
    const task = this.tasks.get(id);
    if (!task) return false;
    this.tasks.delete(id);
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
    await this.persist();
    return true;
  }

  /** 计算任务下一次触发时间；无效任务返回 undefined。 */
  nextRunAt(id: string): Date | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    return job.nextRun() ?? undefined;
  }

  /** 触发一轮任务（croner 到点与测试共用）；失败被消费，不向上抛出。 */
  async trigger(id: string): Promise<ScheduleTriggerOutcome> {
    const task = this.tasks.get(id);
    if (!task || !task.enabled) {
      return { status: "error", reason: "任务不存在或已停用" };
    }
    try {
      return await this.fire(task);
    } catch (error) {
      const reason = (error as Error).message;
      console.error(`[定时] #${id} 触发失败:`, reason);
      return { status: "error", reason };
    }
  }

  /** 清空全部定时器；插件卸载回调调用。 */
  dispose(): void {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }

  private scheduleJob(task: ScheduleTask): void {
    const job = new Cron(
      task.expr,
      { timezone: this.timezone, unref: true },
      () => {
        void this.trigger(task.id);
      },
    );
    this.jobs.set(task.id, job);
  }

  private async persist(): Promise<void> {
    try {
      await this.store?.save([...this.tasks.values()]);
    } catch (error) {
      console.error("[定时] 保存失败:", (error as Error).message);
    }
  }

  private async markRun(task: ScheduleTask): Promise<void> {
    task.lastRunAt = new Date().toISOString();
    task.lastSkippedAt = undefined;
    await this.persist();
  }

  private async markSkipped(task: ScheduleTask): Promise<void> {
    task.lastSkippedAt = new Date().toISOString();
    await this.persist();
  }

  private async fire(task: ScheduleTask): Promise<ScheduleTriggerOutcome> {
    const runtime = this.ctx.lark.bot(task.botId);
    if (!runtime) {
      return { status: "error", reason: `bot 未就绪: ${task.botId}` };
    }
    const { bot, config: botConfig } = runtime;

    // 先主动发一条锚点消息，任务卡片和结果作为它的回复出现在话题中；
    // 复用 tasks 流水线时需要一个真实 message_id 作为回复目标。
    const anchorId = await bot.send(
      task.chatId,
      `⏰ 定时任务：${task.prompt}`,
    );
    if (!anchorId) {
      return { status: "error", reason: "飞书没有返回锚点消息 ID" };
    }

    // 用配置时的地址解析会话：有话题时复用话题会话（与用户任务共享上下文并
    // 自然实现 busy 检查），无话题时以命令消息 ID 作为稳定会话锚点。
    const resolved = await this.ctx.sessions.manager.resolve(
      {
        messageId: task.messageId,
        chatId: task.chatId,
        threadId: task.threadId,
        rootId: task.rootId,
      },
      task.cliId,
      task.botId,
      task.workspaceDir,
      task.accessMode,
    );
    if (resolved.session.status === "active") {
      await this.markSkipped(task);
      return { status: "skipped", reason: "busy" };
    }
    if (resolved.session.status === "closed") {
      await this.markSkipped(task);
      return { status: "skipped", reason: "closed" };
    }

    const started = await this.ctx.tasks.startTask({
      bot,
      botConfig,
      session: resolved.session,
      hasThread: false,
      replyToMessageId: anchorId,
      senderOpenId: task.ownerOpenId,
      requestedPrompt: task.prompt,
      isCompacting: false,
      interaction: interactionPolicyOf(task),
      resources: [],
    });
    if (!started) {
      const latestStatus = this.ctx.sessions.manager.get(
        resolved.session.id,
      )?.status;
      if (latestStatus === "active" || latestStatus === "closed") {
        await this.markSkipped(task);
        return {
          status: "skipped",
          reason: latestStatus === "active" ? "busy" : "closed",
        };
      }
      return { status: "error", reason: "任务未能进入执行链" };
    }
    await this.markRun(task);
    return { status: "started" };
  }
}

export const name = "schedule";
export const inject = ["lark", "sessions", "tasks"];

export interface Config {
  /** schedules.json 路径；缺省时使用 data/schedules.json。 */
  storePath?: string;
  /** cron 时区；缺省时跟随本机时区。 */
  timezone?: string;
}

export async function apply(ctx: Context, config: Config = {}) {
  const timezone =
    config.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const service = new ScheduleService(ctx, timezone);
  await service.init(new JsonScheduleStore(config.storePath ?? "data/schedules.json"));
  // 卸载插件时清空定时器，避免 Agent OS 退出后 croner 仍持有计时器。
  return () => service.dispose();
}
