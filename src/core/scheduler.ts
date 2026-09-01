/**
 * 定时任务调度器：负责注册计划、计算下一次执行、暂停恢复、删除与真正触发。
 * 它不依赖 cordis，也不直接操作 CLI——到点执行交给注入的 dispatcher，
 * 由装配层（plugins/schedule.ts）决定“怎么执行”。计划与运行记录分别走
 * scheduleStore / runStore，进程重启后通过 recoverInterruptedRuns 自愈。
 */
import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import type { ScheduleRunStore } from "./schedule-run-store.js";
import type { ScheduleStore } from "./schedule-store.js";
import type { CreateScheduledTask, ScheduledTask } from "./schedule.js";

// Node 单个 setTimeout 只能安全等待约 24.85 天；更远的计划分段唤醒后继续等待。
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** 到点执行一条计划的回调：装配层注入静默执行或测试替身。 */
export type ScheduledTaskDispatcher = (
  task: ScheduledTask,
  scheduledFor: string,
) => Promise<{ sessionId?: string }>;

export interface SchedulerOptions {
  scheduleStore: ScheduleStore;
  runStore: ScheduleRunStore;
  dispatcher: ScheduledTaskDispatcher;
  /** 可注入时钟，测试用；缺省时用系统时间。 */
  now?: () => Date;
}

export class Scheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private running = false;

  constructor(private readonly options: SchedulerOptions) {}

  list(): ScheduledTask[] {
    return this.options.scheduleStore.list();
  }

  /** 启动调度：恢复中断运行记录，并为全部 active 计划注册下一次定时器。 */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.recoverInterruptedRuns();
    for (const task of this.options.scheduleStore.list()) {
      if (task.status !== "active") continue;
      this.schedule(task);
    }
  }

  /** 停止调度：清空全部定时器；恢复需重新 start。 */
  stop(): void {
    this.running = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  create(options: CreateScheduledTask & { id?: string }): ScheduledTask {
    const task = this.options.scheduleStore.create(options);
    if (task.status === "active") this.schedule(task);
    return this.options.scheduleStore.get(task.id) ?? task;
  }

  pause(id: string): ScheduledTask | undefined {
    const task = this.options.scheduleStore.get(id);
    if (!task || task.status !== "active") return task;
    this.clearTimer(id);
    return this.options.scheduleStore.update(id, {
      status: "paused",
      nextRunAt: undefined,
    });
  }

  resume(id: string): ScheduledTask | undefined {
    const task = this.options.scheduleStore.get(id);
    if (!task || task.status !== "paused") return task;
    const updated = this.options.scheduleStore.update(id, { status: "active" });
    if (updated) this.schedule(updated);
    return this.options.scheduleStore.get(id);
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        ScheduledTask,
        "targetBotId" | "prompt" | "rule" | "status" | "chatId" | "creatorOpenId"
      >
    >,
  ): ScheduledTask | undefined {
    const task = this.options.scheduleStore.get(id);
    if (!task) return undefined;
    const updated = this.options.scheduleStore.update(id, patch);
    if (updated) {
      this.clearTimer(id);
      if (updated.status === "active") this.schedule(updated);
    }
    return this.options.scheduleStore.get(id);
  }

  delete(id: string): boolean {
    this.clearTimer(id);
    return this.options.scheduleStore.delete(id);
  }

  removeMany(ids: string[]): number {
    let count = 0;
    for (const id of ids) {
      if (this.delete(id)) count += 1;
    }
    return count;
  }

  removeAll(): number {
    return this.removeMany(this.list().map((task) => task.id));
  }

  /** 立即执行一次计划；不影响已有排期，执行结果写运行记录。 */
  async runNow(id: string): Promise<ScheduledTask | undefined> {
    const task = this.options.scheduleStore.get(id);
    if (!task) return undefined;
    const now = (this.options.now ?? (() => new Date()))();
    await this.trigger(task, now.toISOString());
    return this.options.scheduleStore.get(id);
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }

  /** 计算 base 之后的下一次绝对执行时间。 */
  private nextRunAt(task: ScheduledTask, base: Date): Date | undefined {
    const now = (this.options.now ?? (() => new Date()))();
    if (task.rule.kind === "once") {
      const runAt = new Date(task.rule.runAt);
      return runAt.getTime() <= now.getTime() ? undefined : runAt;
    }
    if (task.rule.kind === "interval") {
      let next = base.getTime() + task.rule.everyMs;
      if (next <= now.getTime()) {
        const missed = Math.floor((now.getTime() - next) / task.rule.everyMs) + 1;
        next += missed * task.rule.everyMs;
      }
      return new Date(next);
    }

    const cron = new Cron(task.rule.expression, {
      timezone: task.rule.timezone,
      paused: true,
    });
    const next = cron.nextRun(base);
    if (!next) return undefined;
    return next.getTime() <= now.getTime() ? (cron.nextRun(now) ?? undefined) : next;
  }

  private schedule(task: ScheduledTask): void {
    this.clearTimer(task.id);
    const now = (this.options.now ?? (() => new Date()))();
    const nextRunAt = this.nextRunAt(task, now);
    if (!nextRunAt) return;
    const updated = this.options.scheduleStore.update(task.id, {
      nextRunAt: nextRunAt.toISOString(),
    });
    if (!updated) return;
    this.armTimer(updated.id, nextRunAt.toISOString());
  }

  /** 按绝对时间分段等待，避免远期计划触发 Node 的 TimeoutOverflowWarning。 */
  private armTimer(id: string, scheduledFor: string): void {
    const now = (this.options.now ?? (() => new Date()))();
    const remainingMs = new Date(scheduledFor).getTime() - now.getTime();
    const delayMs = Math.max(1, Math.min(remainingMs, MAX_TIMER_DELAY_MS));
    const timer = setTimeout(() => {
      this.timers.delete(id);
      const current = this.options.scheduleStore.get(id);
      if (
        !current ||
        current.status !== "active" ||
        current.nextRunAt !== scheduledFor
      ) {
        return;
      }
      const currentTime = (this.options.now ?? (() => new Date()))();
      if (currentTime.getTime() < new Date(scheduledFor).getTime()) {
        this.armTimer(id, scheduledFor);
        return;
      }
      void this.onDue(current, scheduledFor).catch((error) => {
        console.error(`[定时] ${id} 到点处理失败:`, (error as Error).message);
      });
    }, delayMs);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  private async onDue(task: ScheduledTask, scheduledFor: string): Promise<void> {
    // 周期任务先按计划时间排下一轮，再执行当前轮；长任务不会把周期整体向后拖移。
    if (task.rule.kind !== "once") {
      const nextRunAt = this.nextRunAt(task, new Date(scheduledFor));
      if (nextRunAt) {
        const updated = this.options.scheduleStore.update(task.id, {
          nextRunAt: nextRunAt.toISOString(),
        });
        if (updated) this.armTimer(task.id, nextRunAt.toISOString());
      }
    }
    await this.trigger(task, scheduledFor);
  }

  /** 执行一条计划：幂等去重、上一轮未跑完跳过，并把结果写进运行记录。 */
  private async trigger(
    task: ScheduledTask,
    scheduledFor: string,
  ): Promise<void> {
    if (this.options.runStore.find(task.id, scheduledFor)) return;
    const running = this.options.runStore.latestRunning(task.id);
    if (running) {
      const skipped = this.options.runStore.create(task.id, scheduledFor);
      if (skipped) {
        this.options.runStore.markSkipped(skipped.id, "上一轮仍在执行，本轮跳过");
      }
      return;
    }
    const run = this.options.runStore.create(task.id, scheduledFor);
    if (!run) return;
    const taskId = randomUUID().replaceAll("-", "").slice(0, 24);
    this.options.scheduleStore.update(task.id, { lastRunAt: scheduledFor });
    try {
      await this.options.dispatcher(task, scheduledFor);
      this.options.runStore.markSucceeded(run.id, taskId);
    } catch (error) {
      this.options.runStore.markFailed(run.id, (error as Error).message);
    } finally {
      if (task.rule.kind === "once") {
        this.clearTimer(task.id);
        this.options.scheduleStore.update(task.id, {
          status: "completed",
          nextRunAt: undefined,
        });
      }
    }
  }

  /** 重启自愈：中断的 running 记录标记失败，错过的一次性任务记为 skipped 并完成。 */
  private recoverInterruptedRuns(): void {
    const now = (this.options.now ?? (() => new Date()))();
    for (const task of this.options.scheduleStore.list()) {
      const running = this.options.runStore.latestRunning(task.id);
      if (running) {
        this.options.runStore.markFailed(running.id, "进程重启，任务中断");
      }
      if (task.status === "active" && task.rule.kind === "once") {
        if (new Date(task.rule.runAt).getTime() <= now.getTime()) {
          const run = this.options.runStore.create(task.id, task.rule.runAt);
          if (run) this.options.runStore.markSkipped(run.id, "已错过执行时间");
          this.options.scheduleStore.update(task.id, {
            status: "completed",
            nextRunAt: undefined,
          });
        }
      }
    }
  }
}
