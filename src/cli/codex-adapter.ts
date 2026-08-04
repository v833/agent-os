/**
 * Codex 协议适配器：负责 codex exec 的首次/续聊参数和 JSONL 事件翻译，
 * 让同一个飞书话题可以用 thread_id 延续 Codex 上下文。
 */
import type { CliAdapter, CliEvent } from "./types.js";

interface CodexEvent {
  type?: unknown;
  thread_id?: unknown;
  item?: unknown;
  error?: unknown;
  message?: unknown;
  usage?: unknown;
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

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function shortText(value: unknown, maxLength = 72): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > maxLength
    ? `${text.slice(0, maxLength - 1)}…`
    : text;
}

function outputArgs(prompt: string): string[] {
  // full-auto 沿用现有执行策略；提示词仍作为最后一个独立参数传递。
  return ["--json", "--full-auto", "--skip-git-repo-check", prompt];
}

/** 将 Codex 的命令行和 JSONL 协议适配为 Agent OS 公共事件。 */
export class CodexAdapter implements CliAdapter {
  readonly id = "codex" as const;
  readonly command = "codex";
  readonly displayName = "Codex";

  buildArgs(prompt: string): string[] {
    return ["exec", ...outputArgs(prompt)];
  }

  buildResumeArgs(prompt: string, sessionId: string): string[] {
    return ["exec", "resume", sessionId, ...outputArgs(prompt)];
  }

  /** 兼容旧的单事件调用；运行链路统一使用 parseEvents。 */
  parseEvent(line: string): CliEvent | undefined {
    return this.parseEvents(line)[0];
  }

  parseEvents(line: string): CliEvent[] {
    let event: CodexEvent;
    try {
      event = JSON.parse(line) as CodexEvent;
    } catch {
      return [];
    }

    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      return [{ type: "session", sessionId: event.thread_id }];
    }

    if (event.type === "item.started" && isObject(event.item)) {
      if (
        event.item.type === "command_execution" &&
        typeof event.item.id === "string"
      ) {
        const detail = shortText(event.item.command);
        return [
          {
            type: "tool_start",
            toolUseId: event.item.id,
            toolName: "command_execution",
            label: "运行命令",
            ...(detail ? { detail } : {}),
          },
        ];
      }
      return [];
    }

    if (event.type === "item.completed" && isObject(event.item)) {
      if (
        event.item.type === "agent_message" &&
        typeof event.item.text === "string"
      ) {
        return [{ type: "result", answer: event.item.text }];
      }
      if (
        event.item.type === "command_execution" &&
        typeof event.item.id === "string"
      ) {
        const exitCode = asNumber(event.item.exit_code);
        return [
          {
            type: "tool_end",
            toolUseId: event.item.id,
            failed:
              event.item.status === "failed" ||
              (exitCode !== undefined && exitCode !== 0),
          },
        ];
      }
      return [];
    }

    if (event.type === "turn.completed" && isObject(event.usage)) {
      const usedTokens = asNumber(event.usage.input_tokens);
      return usedTokens === undefined ? [] : [{ type: "context", usedTokens }];
    }

    if (event.type === "turn.failed" || event.type === "error") {
      const message = errorMessage(event.error) ?? errorMessage(event.message);
      return [{ type: "error", message: message || "Codex 执行失败" }];
    }

    return [];
  }
}
