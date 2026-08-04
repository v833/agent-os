/**
 * 任务停止模型：集中管理运行实例、发起人权限和停止原因，
 * 供飞书卡片按钮与 /close 共用同一条 AbortController 链路。
 */

export interface ActiveRun {
  controller: AbortController;
  ownerOpenId: string;
  runId: string;
  cancelMode?: "stop" | "close";
}

export type AbortTaskOutcome =
  | "stopped"
  | "already_stopping"
  | "not_found"
  | "forbidden";

/**
 * 请求停止指定的一轮任务。
 *
 * `runId` 是每轮唯一值；只用会话 ID 会让旧卡片误停同一话题的新任务。
 */
export function requestTaskAbort(
  activeRuns: Map<string, ActiveRun>,
  sessionId: string,
  runId: string,
  operatorOpenId: string,
): AbortTaskOutcome {
  const active = activeRuns.get(sessionId);
  if (!active || !runId || active.runId !== runId) return "not_found";
  // 操作者身份必须来自飞书回调，不能信任卡片 value 中可被构造的用户字段。
  if (operatorOpenId !== active.ownerOpenId) return "forbidden";
  if (active.controller.signal.aborted) return "already_stopping";

  active.cancelMode = "stop";
  active.controller.abort();
  return "stopped";
}
