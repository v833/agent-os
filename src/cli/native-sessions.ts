/**
 * 原生 CLI 会话入口：把 /resume 的原生会话能力按 adapter 声明分发。
 * 具体协议实现归属各引擎适配器（Claude 读项目 JSONL、Codex 走 app-server），
 * 未声明该能力的引擎（如 DimAgent、ACP）直接返回空列表——调用方不按引擎 id 特判。
 */
import type { CliAdapter, CliSessionSummary } from "./types.js";

export interface ListNativeCliSessionsOptions {
  adapter: CliAdapter;
  cwd: string;
}

/** 列出引擎在当前工作目录的原生会话；adapter 未实现时表示不支持。 */
export function listNativeCliSessions(
  options: ListNativeCliSessionsOptions,
): Promise<CliSessionSummary[]> {
  return (
    options.adapter.listNativeSessions?.(options.cwd) ?? Promise.resolve([])
  );
}
