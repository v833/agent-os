/**
 * 多话题并行编排的数据结构与拆解解析：一次 /orchestrate 生成一个编排运行（run），
 * 每个 run 包含若干子任务；子任务通过协作交接单派发给目标 bot，状态由
 * task/result / task/failed 事件驱动。纯函数与数据契约放在这里供服务插件复用，
 * 不依赖任何 Cordis 服务实现。
 */
import { z } from "zod";

/** 子任务的执行状态：pending 为已派发等待结果，done/failed 由任务事件写入。 */
export type OrchestrationSubTaskStatus = "pending" | "done" | "failed";

/** 一个编排子任务：目标 bot、提示词与结果快照。 */
export interface OrchestrationSubTask {
  id: string;
  prompt: string;
  targetBotId: string;
  status: OrchestrationSubTaskStatus;
  /** 子任务成功后的回答摘要。 */
  answer?: string;
  /** 子任务派发或执行失败的原因。 */
  error?: string;
  finishedAt?: string;
}

/** 一次 /orchestrate 产生的完整编排状态，供 /panel 渲染。 */
export interface OrchestrationRun {
  runId: string;
  /** 用户给出的原始大任务。 */
  prompt: string;
  startedAt: string;
  subTasks: OrchestrationSubTask[];
}

/** 编排 bot 的 CLI 拆解输出中的单个子任务规格。 */
export interface SubTaskSpec {
  id: string;
  prompt: string;
  /** 目标 bot 的注册 id。 */
  bot: string;
}

const SubTaskSpecSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  bot: z.string().min(1),
});

const DecomposeOutputSchema = z.object({
  tasks: z.array(SubTaskSpecSchema).min(1),
});

/**
 * 从编排 bot 的 CLI 回答中提取子任务规格。
 * CLI 输出不可靠，允许 markdown 代码块等包裹，只取首个 `{` 到最后一个 `}` 的 JSON。
 */
export function parseSubTaskSpecs(answer: string): SubTaskSpec[] {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("拆解结果里找不到 JSON 对象");
  }
  const parsed = DecomposeOutputSchema.parse(
    JSON.parse(answer.slice(start, end + 1)),
  );
  return parsed.tasks;
}

/** 编排运行 ID：run-001 递增生成，格式与 sched-001 保持一致。 */
export function nextRunId(existing: Iterable<string>): string {
  let max = 0;
  for (const id of existing) {
    const match = /^run-(\d+)$/.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `run-${String(max + 1).padStart(3, "0")}`;
}

/** 子任务在协作交接单中的全局唯一任务 ID，避免跨 run 的子任务 id 冲突。 */
export function subTaskTaskId(runId: string, subTaskId: string): string {
  return `${runId}#${subTaskId}`;
}

/** 从协作交接单 taskId 反解出 runId 与子任务 id；格式不合法返回 undefined。 */
export function parseSubTaskTaskId(
  taskId: string,
): { runId: string; subTaskId: string } | undefined {
  const hash = taskId.indexOf("#");
  if (hash <= 0 || hash === taskId.length - 1) return undefined;
  return { runId: taskId.slice(0, hash), subTaskId: taskId.slice(hash + 1) };
}

/** 服务端 runs 表保留的已完成编排运行上限，超出即淘汰最旧，防止无界增长。 */
export const MAX_RUNS = 20;

/**
 * 裁剪编排运行表：全部子任务已处于终态（done/failed）的 run 只保留最近
 * maxRuns 条（按 startedAt 升序取最新），其余剔除；仍有 pending 子任务的 run
 * 不参与淘汰，始终保留。输入为运行数组，返回裁剪后的新数组。
 */
export function trimRuns(
  runs: OrchestrationRun[],
  maxRuns = MAX_RUNS,
): OrchestrationRun[] {
  const terminal = runs.filter((run) =>
    run.subTasks.every(
      (sub) => sub.status === "done" || sub.status === "failed",
    ),
  );
  if (terminal.length <= maxRuns) return runs;
  const evictIds = new Set(
    [...terminal]
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .slice(0, terminal.length - maxRuns)
      .map((run) => run.runId),
  );
  return runs.filter((run) => !evictIds.has(run.runId));
}
