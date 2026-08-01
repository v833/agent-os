/**
 * CLI 适配层公共契约：统一 Codex 与 Claude Code 的参数构造和事件语义，
 * 让 Agent OS 的进程控制与具体供应商协议彼此独立。
 */

export type CliId = "codex" | "claude";

export type CliEvent =
  | { type: "session"; sessionId: string }
  | { type: "result"; answer: string; sessionId?: string }
  | { type: "error"; message: string; sessionId?: string };

/** 描述一种可由通用 Runner 驱动的无头 CLI。 */
export interface CliAdapter {
  readonly id: CliId;
  readonly command: string;
  readonly displayName: string;
  buildArgs(prompt: string): string[];
  buildResumeArgs(prompt: string, sessionId: string): string[];
  parseEvent(line: string): CliEvent | undefined;
}

/** CLI 一轮执行完成后返回给会话层的统一结果。 */
export interface CliRunResult {
  answer: string;
  sessionId?: string;
}
