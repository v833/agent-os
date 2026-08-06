/**
 * Codex 协议适配器：负责 codex exec 的首次/续聊参数和 JSONL 事件翻译，
 * 让同一个飞书话题可以用 thread_id 延续 Codex 上下文。
 */
import type { CliAdapter, CliEvent, CliRunStats } from "./types.js";

interface CodexEvent {
  type?: unknown;
  thread_id?: unknown;
  item?: unknown;
  error?: unknown;
  message?: unknown;
  usage?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function firstChangedPath(item: Record<string, unknown>): string | undefined {
  if (typeof item.path === "string") return shortText(item.path);
  if (!Array.isArray(item.changes)) return undefined;
  const change = item.changes.find(isRecord);
  return change ? shortText(change.path) : undefined;
}

function toolInfo(item: Record<string, unknown>):
  | { toolName: string; label: string; detail?: string }
  | undefined {
  if (item.type === "command_execution") {
    const detail = shortText(item.command);
    return {
      toolName: "Bash",
      label: "运行命令",
      ...(detail ? { detail } : {}),
    };
  }
  if (item.type === "file_change") {
    const detail = firstChangedPath(item);
    return {
      toolName: "Edit",
      label: "修改文件",
      ...(detail ? { detail } : {}),
    };
  }
  if (item.type === "web_search") {
    const detail = shortText(item.query);
    return {
      toolName: "WebSearch",
      label: "搜索资料",
      ...(detail ? { detail } : {}),
    };
  }
  if (item.type === "mcp_tool_call") {
    const server = typeof item.server === "string" ? item.server : "";
    const tool = typeof item.tool === "string" ? item.tool : "";
    const detail = shortText([server, tool].filter(Boolean).join("."));
    return {
      toolName: "MCP",
      label: "调用外部工具",
      ...(detail ? { detail } : {}),
    };
  }
  return undefined;
}

function parseStats(usage: unknown): CliRunStats | undefined {
  if (!isRecord(usage)) return undefined;
  const inputTokens = asNumber(usage.input_tokens);
  const outputTokens = asNumber(usage.output_tokens);
  const cacheReadTokens = asNumber(usage.cached_input_tokens);
  const totalTokens =
    inputTokens === undefined && outputTokens === undefined
      ? undefined
      : (inputTokens ?? 0) + (outputTokens ?? 0);
  if (
    totalTokens === undefined &&
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
  };
}

function eventErrorMessage(event: CodexEvent): string {
  if (typeof event.message === "string") return event.message;
  if (isRecord(event.error) && typeof event.error.message === "string") {
    return event.error.message;
  }
  return "Codex 执行失败";
}

/** 将 Codex 的命令行和 JSONL 协议适配为 Agent OS 公共事件。 */
export class CodexAdapter implements CliAdapter {
  readonly id = "codex" as const;
  readonly command = "codex";
  readonly displayName = "Codex";

  buildArgs(prompt: string): string[] {
    return [
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      prompt,
    ];
  }

  buildResumeArgs(prompt: string, sessionId: string): string[] {
    return [
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      sessionId,
      prompt,
    ];
  }

  isSessionUnavailable(message: string): boolean {
    const text = message.toLowerCase();
    return (
      /(?:thread|session|conversation)[^\n]*(?:not found|could not find|does not exist|expired|invalid|unknown)/.test(
        text,
      ) ||
      /(?:not found|could not find|does not exist|expired|invalid|unknown)[^\n]*(?:thread|session|conversation)/.test(
        text,
      ) ||
      /no (?:such )?(?:thread|session|conversation)\b/.test(text)
    );
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

    if (event.type === "turn.failed" || event.type === "error") {
      return [{ type: "error", message: eventErrorMessage(event) }];
    }

    if (event.type === "turn.completed") {
      const stats = parseStats(event.usage);
      if (!stats) return [];
      const events: CliEvent[] = [];
      // 实时卡片仍依赖 context 事件；统计结果则由 Runner 与回答跨行合并。
      if (stats.inputTokens !== undefined) {
        events.push({ type: "context", usedTokens: stats.inputTokens });
      }
      events.push({ type: "result", answer: "", stats });
      return events;
    }

    if (!isRecord(event.item)) return [];
    const item = event.item;
    if (event.type === "item.completed") {
      if (
        item.type === "agent_message" &&
        typeof item.text === "string"
      ) {
        return [{ type: "result", answer: item.text }];
      }
    }

    if (typeof item.id !== "string") return [];
    const tool = toolInfo(item);
    if (!tool) return [];
    if (event.type === "item.started") {
      return [
        {
          type: "tool_start",
          toolUseId: item.id,
          ...tool,
        },
      ];
    }
    if (event.type === "item.completed") {
      const exitCode = asNumber(item.exit_code);
      return [
        {
          type: "tool_end",
          toolUseId: item.id,
          failed:
            item.status === "failed" ||
            (exitCode !== undefined && exitCode !== 0),
        },
      ];
    }

    return [];
  }
}
