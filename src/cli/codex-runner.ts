/**
 * Codex 无头适配器：运行 codex exec --json，记录 thread_id，
 * 并把最后一个 agent_message 作为返回飞书的最终回答。
 */
import {
  runJsonlProcess,
  type CliRunResult,
  type JsonlEventOutcome,
} from "./jsonl-runner.js";
import { resolveCliCommand } from "./command-resolver.js";

export type CodexRunResult = CliRunResult;

export interface RunCodexOptions {
  prompt: string;
  cwd: string;
  signal?: AbortSignal;
}

interface CodexEventUpdate {
  answer?: string;
  sessionId?: string;
  error?: Error;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isObject(value) && typeof value.message === "string") {
    return value.message;
  }
  return undefined;
}

/** Codex 在非交互模式下使用工作区沙箱，并允许非 Git 工作目录。 */
export function codexArgs(prompt: string): string[] {
  return [
    "exec",
    "--json",
    "--full-auto",
    "--skip-git-repo-check",
    prompt,
  ];
}

/** 提取会话 ID、模型最终文本和协议级失败事件。 */
export function parseCodexEvent(value: unknown): CodexEventUpdate | undefined {
  if (!isObject(value) || typeof value.type !== "string") return undefined;

  if (value.type === "thread.started" && typeof value.thread_id === "string") {
    return { sessionId: value.thread_id };
  }

  if (value.type === "item.completed" && isObject(value.item)) {
    if (
      value.item.type === "agent_message" &&
      typeof value.item.text === "string"
    ) {
      return { answer: value.item.text };
    }
    return undefined;
  }

  if (value.type === "turn.failed" || value.type === "error") {
    const message = errorMessage(value.error) ?? errorMessage(value.message);
    return { error: new Error(message || "Codex 执行失败") };
  }

  return undefined;
}

export function runCodex(options: RunCodexOptions): Promise<CodexRunResult> {
  let answer: string | undefined;
  let sessionId: string | undefined;
  const executable = resolveCliCommand({
    name: "codex",
    windowsPackageEntry: [
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    ],
    windowsPackageEntryType: "node",
  });

  const onEvent = (
    event: unknown,
  ): JsonlEventOutcome<CodexRunResult> | undefined => {
    const update = parseCodexEvent(event);
    if (!update) return undefined;
    if (update.error) return { error: update.error };
    if (update.answer !== undefined) answer = update.answer;
    if (update.sessionId !== undefined) sessionId = update.sessionId;

    // thread.started 和 agent_message 分开发送；任一更新后都重建当前最终快照。
    if (answer === undefined) return undefined;
    return { result: { answer, sessionId } };
  };

  return runJsonlProcess({
    command: executable.command,
    args: [...executable.argsPrefix, ...codexArgs(options.prompt)],
    cwd: options.cwd,
    signal: options.signal,
    displayName: "Codex",
    cancelledMessage: "Codex 执行已取消",
    missingResultMessage: "Codex 没有返回最终结果",
    onEvent,
  });
}
