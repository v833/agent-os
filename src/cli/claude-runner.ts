/**
 * Claude Code 无头适配器：把提示词交给 claude -p，
 * 从 stream-json 的 result 事件中提取最终回答和 session_id。
 */
import {
  runJsonlProcess,
  type CliRunResult,
  type JsonlEventOutcome,
} from "./jsonl-runner.js";
import { resolveCliCommand } from "./command-resolver.js";

export type ClaudeRunResult = CliRunResult;

export interface RunClaudeOptions {
  prompt: string;
  cwd: string;
  signal?: AbortSignal;
}

interface ClaudeResultEvent {
  type: "result";
  is_error?: boolean;
  result?: string;
  session_id?: string;
}

function isClaudeResultEvent(value: unknown): value is ClaudeResultEvent {
  if (!value || typeof value !== "object") return false;
  return (value as { type?: unknown }).type === "result";
}

/** 构造参数数组；提示词始终是单独参数，不参与 shell 拼接。 */
export function claudeArgs(prompt: string): string[] {
  return [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
  ];
}

/** 只消费闭环所需的最终 result 事件，其余进度事件交给后续章节扩展。 */
export function parseClaudeResultEvent(
  value: unknown,
): JsonlEventOutcome<ClaudeRunResult> | undefined {
  if (!isClaudeResultEvent(value)) return undefined;
  if (value.is_error) {
    return { error: new Error(value.result || "Claude Code 执行失败") };
  }
  if (typeof value.result !== "string") return undefined;
  return {
    result: {
      answer: value.result,
      sessionId: value.session_id,
    },
  };
}

export function runClaude(
  options: RunClaudeOptions,
): Promise<ClaudeRunResult> {
  const executable = resolveCliCommand({
    name: "claude",
    windowsPackageEntry: [
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe",
    ],
    windowsPackageEntryType: "executable",
  });
  return runJsonlProcess({
    command: executable.command,
    args: [...executable.argsPrefix, ...claudeArgs(options.prompt)],
    cwd: options.cwd,
    signal: options.signal,
    displayName: "Claude Code",
    cancelledMessage: "Claude Code 执行已取消",
    missingResultMessage: "Claude Code 没有返回最终结果",
    onEvent: parseClaudeResultEvent,
  });
}
