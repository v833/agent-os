/**
 * schedule_manage 的真实落点：按 action 分发到 Scheduler 与运行记录 Store，
 * 每条回执都是落盘后的真实结果。MCP 子进程经内部 API 调用这里，命令行管理
 * 也复用同一份逻辑，保证结果一致。
 */
import type { Scheduler } from "./scheduler.js";
import type { ScheduleRunStore } from "./schedule-run-store.js";
import {
  scheduleDescription,
  type ScheduleManageRequest,
  type ScheduledTask,
} from "./schedule.js";
export interface ScheduleManageContext {
  scheduler: Scheduler;
  runStore: ScheduleRunStore;
  chatId: string;
  creatorOpenId: string;
  isTargetBotAllowed(targetBotId: string): boolean;
}

export interface ScheduleManageOutcome {
  notice: string;
  /** list action 的结构化结果，供 /schedules 卡片渲染。 */
  schedules?: ScheduledTask[];
}

/** 管理请求参数语法正确，但引用了当前上下文不可用的目标成员。 */
export class ScheduleManageValidationError extends Error {}

function scheduleSummary(task: ScheduledTask): string {
  const rule = scheduleDescription(task.rule);
  const next = task.nextRunAt ? `，下次 ${task.nextRunAt}` : "";
  return `- ${task.id} → ${task.targetBotId}（${rule}，${task.status}${next}）`;
}

function scheduleListNotice(tasks: ScheduledTask[]): string {
  return tasks.length
    ? `当前共 ${tasks.length} 个定时任务：\n${tasks.map(scheduleSummary).join("\n")}`
    : "当前没有定时任务。";
}

function belongsToActor(
  task: ScheduledTask,
  context: ScheduleManageContext,
): boolean {
  return (
    task.chatId === context.chatId &&
    task.creatorOpenId === context.creatorOpenId
  );
}

function visibleTasks(context: ScheduleManageContext): ScheduledTask[] {
  return context.scheduler.list().filter((task) => belongsToActor(task, context));
}

function visibleTask(
  id: string,
  context: ScheduleManageContext,
): ScheduledTask | undefined {
  return visibleTasks(context).find((task) => task.id === id);
}

function assertTargetBot(
  targetBotId: string,
  context: ScheduleManageContext,
): void {
  if (!context.isTargetBotAllowed(targetBotId)) {
    throw new ScheduleManageValidationError(
      `目标成员未注册或未启用: ${targetBotId}`,
    );
  }
}

export async function executeScheduleManageRequest(
  request: ScheduleManageRequest,
  context: ScheduleManageContext,
): Promise<ScheduleManageOutcome> {
  switch (request.action) {
    case "list": {
      const tasks = visibleTasks(context);
      return { notice: scheduleListNotice(tasks), schedules: tasks };
    }
    case "add": {
      assertTargetBot(request.targetBotId, context);
      const task = context.scheduler.create({
        creatorOpenId: context.creatorOpenId,
        chatId: context.chatId,
        targetBotId: request.targetBotId,
        prompt: request.prompt,
        rule: request.rule,
      });
      return {
        notice: `定时任务 ${task.id} 已创建。\n${scheduleSummary(task)}`,
      };
    }
    case "addMany": {
      for (const item of request.schedules) {
        assertTargetBot(item.targetBotId, context);
      }
      const tasks = request.schedules.map((item) =>
        context.scheduler.create({
          creatorOpenId: context.creatorOpenId,
          chatId: context.chatId,
          targetBotId: item.targetBotId,
          prompt: item.prompt,
          rule: item.rule,
        }),
      );
      return {
        notice: `已批量创建 ${tasks.length} 个定时任务：\n${tasks.map(scheduleSummary).join("\n")}`,
      };
    }
    case "update": {
      if (!visibleTask(request.id, context)) {
        return { notice: `没有找到定时任务 ${request.id}。` };
      }
      if (request.targetBotId) assertTargetBot(request.targetBotId, context);
      const patch = {
        ...(request.targetBotId ? { targetBotId: request.targetBotId } : {}),
        ...(request.prompt ? { prompt: request.prompt } : {}),
        ...(request.rule ? { rule: request.rule } : {}),
      };
      const updated = context.scheduler.update(request.id, patch);
      return updated
        ? {
            notice: `定时任务 ${request.id} 已更新。\n${scheduleSummary(updated)}`,
          }
        : { notice: `没有找到定时任务 ${request.id}。` };
    }
    case "remove": {
      const deleted = visibleTask(request.id, context)
        ? context.scheduler.delete(request.id)
        : false;
      return {
        notice: deleted
          ? `定时任务 ${request.id} 已删除。`
          : `没有找到定时任务 ${request.id}。`,
      };
    }
    case "removeMany": {
      const visibleIds = new Set(visibleTasks(context).map((task) => task.id));
      const count = context.scheduler.removeMany(
        request.ids.filter((id) => visibleIds.has(id)),
      );
      return { notice: `已删除 ${count} 个定时任务。` };
    }
    case "removeAll": {
      const count = context.scheduler.removeMany(
        visibleTasks(context).map((task) => task.id),
      );
      return { notice: `已删除全部 ${count} 个定时任务。` };
    }
    case "run": {
      const task = visibleTask(request.id, context)
        ? await context.scheduler.runNow(request.id)
        : undefined;
      return {
        notice: task
          ? `定时任务 ${request.id} 已触发执行。`
          : `没有找到定时任务 ${request.id}。`,
      };
    }
    case "pause": {
      const task = visibleTask(request.id, context)
        ? context.scheduler.pause(request.id)
        : undefined;
      return {
        notice: task
          ? `定时任务 ${request.id} 已暂停。`
          : `没有找到定时任务 ${request.id}。`,
      };
    }
    case "resume": {
      const task = visibleTask(request.id, context)
        ? context.scheduler.resume(request.id)
        : undefined;
      return {
        notice: task
          ? `定时任务 ${request.id} 已恢复。`
          : `没有找到定时任务 ${request.id}。`,
      };
    }
    case "logs": {
      const allRuns = request.id
        ? visibleTask(request.id, context)
          ? context.runStore.list(request.id)
          : []
        : visibleTasks(context)
            .flatMap((task) => context.runStore.list(task.id));
      const runs = [...allRuns]
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, 10);
      const lines = runs.map(
        (run) =>
          `- [${run.status}] ${run.scheduledFor}${run.taskId ? ` task=${run.taskId}` : ""}${run.error ? ` ${run.error}` : ""}`,
      );
      return {
        notice: allRuns.length
          ? `最近 ${allRuns.length} 条运行记录：\n${lines.join("\n")}`
          : "当前没有运行记录。",
      };
    }
  }
}
