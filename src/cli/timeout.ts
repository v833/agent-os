/**
 * CLI 执行时限策略：为 headless、ACP 和启动准备阶段提供统一的默认硬超时，
 * 防止外部 Agent CLI 的死锁或句柄泄漏让 ThreadPilot 无限等待。
 */

/** 未显式配置时允许一轮 CLI 工作持续的最长时间。 */
export const DEFAULT_CLI_TIMEOUT_MS = 30 * 60 * 1_000;

/** 将调用方可选的超时归一化为始终有限且为正的执行时限。 */
export function cliTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_CLI_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs 必须是正整数毫秒值");
  }
  return timeoutMs;
}
