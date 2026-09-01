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
  /** 目标 bot 自己的隔离工作目录；派发与重试始终使用该目录。 */
  workspaceDir?: string;
  status: OrchestrationSubTaskStatus;
  /** 子任务成功后的回答摘要。 */
  answer?: string;
  /** 子任务派发或执行失败的原因。 */
  error?: string;
  finishedAt?: string;
  /** 已重试次数（/panel 重试按钮每次成功消费一次重试后 +1），初始为 0。 */
  retryCount: number;
  /** 当前派发尝试序号：初始 0，每次重试 +1；与 currentDispatchId 一起用于区分迟到结果。 */
  attempt: number;
  /** 当前派发尝试对应的交接单 dispatchId；发送失败时清理，用于忽略旧 attempt 的迟到结果。 */
  currentDispatchId?: string;
}

/** 一次 /orchestrate 产生的完整编排状态，供 /panel 渲染。 */
export interface OrchestrationRun {
  /** 展示用递增编号（run-001 格式）；跨进程重启后可能重新生成，不作为数据契约。 */
  runId: string;
  /**
   * 每次创建 run 生成的一次性实例标识（randomUUID）。子任务交接 taskId、卡片重试令牌与
   * 服务端校验都绑定 instanceId，跨进程重启后旧卡片/旧令牌无法命中新 run。
   */
  instanceId: string;
  /** 用户给出的原始大任务。 */
  prompt: string;
  /** 发起人（/orchestrate 消息发送者），重试按钮仅允许其本人触发。 */
  ownerOpenId: string;
  /** 编排所在群聊；/panel 只能读取同一群聊的运行，避免跨群泄露任务内容。 */
  chatId: string;
  /** 发起编排的 bot；/panel 还需按 bot 隔离同一群里的独立会话。 */
  botId: string;
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
  id: z.string().trim().min(1),
  prompt: z.string().min(1),
  bot: z.string().min(1),
});

const DecomposeOutputSchema = z.object({
  tasks: z.array(SubTaskSpecSchema).min(1),
});

/**
 * 从编排 bot 的 CLI 回答中提取子任务规格。
 * CLI 输出不可靠，允许 markdown 代码块等包裹，只取首个 `{` 到最后一个 `}` 的 JSON。
 * 子任务 ID 是交接 taskId 的一部分，必须唯一：对 ID 先 trim 再做 Set 查重，
 * 发现重复即整轮拒绝，避免后到结果无法定位子任务；trim 后的 ID 作为规范值返回。
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
  const seen = new Set<string>();
  for (const task of parsed.tasks) {
    const id = task.id.trim();
    if (seen.has(id)) {
      throw new Error(`拆解结果包含重复子任务 ID：${id}`);
    }
    seen.add(id);
  }
  return parsed.tasks.map((task) => ({ ...task, id: task.id.trim() }));
}

/** 编排运行 ID：run-001 递增生成。 */
export function nextRunId(existing: Iterable<string>): string {
  let max = 0;
  for (const id of existing) {
    const match = /^run-(\d+)$/.exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `run-${String(max + 1).padStart(3, "0")}`;
}

/**
 * 子任务在协作交接单中的全局唯一任务 ID：绑定 run 实例 instanceId（而不是展示用 runId），
 * 保证跨进程重启后旧交接 taskId 无法命中新 run。
 */
export function subTaskTaskId(instanceId: string, subTaskId: string): string {
  return `${instanceId}#${subTaskId}`;
}

/** 从协作交接单 taskId 反解出 run 实例 instanceId 与子任务 id；格式不合法返回 undefined。 */
export function parseSubTaskTaskId(
  taskId: string,
): { instanceId: string; subTaskId: string } | undefined {
  const hash = taskId.indexOf("#");
  if (hash <= 0 || hash === taskId.length - 1) return undefined;
  return { instanceId: taskId.slice(0, hash), subTaskId: taskId.slice(hash + 1) };
}

/** run 是否已进入终态：所有子任务均为 done/failed（无 pending）。 */
export function isRunTerminal(run: OrchestrationRun): boolean {
  return run.subTasks.every(
    (sub) => sub.status === "done" || sub.status === "failed",
  );
}

/**
 * 生成子任务重试的一次性令牌：三个字段分别 URI 编码后以 `:` 连接。instanceId 是 run
 * 实例唯一标识（randomUUID），服务端据此完整校验令牌归属，跨进程重启后旧卡片令牌无法
 * 命中新 run。字段编码避免子任务 ID 或 nonce 自身包含 `:` 时破坏令牌结构。
 * nonce 由卡片渲染方生成（时间戳+随机数），保证同一子任务在不同渲染批次下令牌不同；
 * 服务侧用 consumedRetryTokens 记录已消费令牌来拒绝重复点击。
 */
export function retryToken(
  instanceId: string,
  subTaskId: string,
  nonce: string,
): string {
  return [instanceId, subTaskId, nonce].map(encodeURIComponent).join(":");
}

/** 从重试令牌反解出 instanceId/subTaskId/nonce；格式不合法返回 undefined。 */
export function parseRetryToken(
  token: string,
): { instanceId: string; subTaskId: string; nonce: string } | undefined {
  const parts = token.split(":");
  if (parts.length !== 3) return undefined;
  try {
    const [instanceId, subTaskId, nonce] = parts.map(decodeURIComponent);
    if (!instanceId || !subTaskId || !nonce) return undefined;
    return { instanceId, subTaskId, nonce };
  } catch {
    // decodeURIComponent 遇到截断的百分号编码会抛异常；令牌来自卡片回调，必须安全拒绝。
    return undefined;
  }
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
  const terminal = runs.filter((run) => isRunTerminal(run));
  if (terminal.length <= maxRuns) return runs;
  const evictIds = new Set(
    [...terminal]
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .slice(0, terminal.length - maxRuns)
      .map((run) => run.runId),
  );
  return runs.filter((run) => !evictIds.has(run.runId));
}
