/**
 * Codex 协议适配器：负责 codex exec 的首次/续聊参数、JSONL 事件翻译和
 * app-server 原生会话列表；让同一个飞书话题可以用 thread_id 延续 Codex 上下文。
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolveCliCommand } from "./command-resolver.js";
import type { CliAdapter, CliEvent, CliRunStats, CliSessionSummary } from "./types.js";

/** /resume 卡片最多展示的原生会话数量。 */
const SESSION_LIMIT = 8;
/** 读取 Codex 原生会话列表的协议超时。 */
const REQUEST_TIMEOUT_MS = 15_000;

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

function codexUpdatedAtOf(thread: Record<string, unknown>): string {
  const value = thread.updatedAt ?? thread.updated_at;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value > 10_000_000_000 ? value : value * 1000).toISOString();
  }
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return new Date(0).toISOString();
}

interface AppServerMessage {
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

function appServerError(message: AppServerMessage): string | undefined {
  if (!isRecord(message.error)) return undefined;
  return typeof message.error.message === "string"
    ? message.error.message
    : "Codex 会话列表读取失败";
}

/** 将 Codex 的命令行和 JSONL 协议适配为 Agent OS 公共事件。 */
export class CodexAdapter implements CliAdapter {
  readonly id = "codex" as const;
  readonly command = "codex";
  readonly displayName = "Codex";
  readonly accessMode = "headless" as const;
  // Codex 的流式连接会因上游请求失败瞬时断开，Runner 据此做有限重试。
  readonly retryOnDisconnect = true;
  readonly compactDetail = "使用原生默认策略整理上下文";

  buildArgs(prompt: string): string[] {
    return [
      "exec",
      "--json",
      "--sandbox",
      "danger-full-access",
      "--skip-git-repo-check",
      prompt,
    ];
  }

  buildResumeArgs(prompt: string, sessionId: string): string[] {
    return [
      "exec",
      "resume",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      sessionId,
      prompt,
    ];
  }

  buildCompactPlan(sessionId: string) {
    return {
      protocol: "codex-app-server" as const,
      command: this.command,
      args: ["app-server"],
      sessionId,
    };
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

  /** 通过 Codex app-server 协议读取当前工作目录的原生会话，供 /resume 卡片展示。 */
  listNativeSessions(cwd: string): Promise<CliSessionSummary[]> {
    return new Promise((resolve, reject) => {
      const executable = resolveCliCommand(this.command);
      const child = spawn(
        executable.command,
        [...executable.argsPrefix, "app-server"],
        {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      const lines = createInterface({ input: child.stdout });
      let stderr = "";
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        lines.close();
      };
      const send = (message: Record<string, unknown>) => {
        if (!child.stdin.destroyed) {
          child.stdin.write(`${JSON.stringify(message)}\n`);
        }
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        child.kill();
        reject(error);
      };
      const succeed = (sessions: CliSessionSummary[]) => {
        if (settled) return;
        settled = true;
        cleanup();
        child.kill();
        resolve(sessions);
      };
      timer = setTimeout(
        () => fail(new Error("Codex 会话列表读取超时")),
        REQUEST_TIMEOUT_MS,
      );

      lines.on("line", (line) => {
        let message: AppServerMessage;
        try {
          message = JSON.parse(line) as AppServerMessage;
        } catch {
          return;
        }
        const error = appServerError(message);
        if (error) {
          fail(new Error(error));
          return;
        }
        if (message.id === 1) {
          send({ method: "initialized", params: {} });
          send({
            id: 2,
            method: "thread/list",
            params: {
              cwd,
              limit: SESSION_LIMIT,
              sortKey: "updated_at",
              sortDirection: "desc",
              sourceKinds: ["cli", "vscode", "exec", "appServer"],
            },
          });
          return;
        }
        if (message.id !== 2 || !isRecord(message.result)) return;
        const data = Array.isArray(message.result.data)
          ? message.result.data.filter(isRecord)
          : [];
        const sessions = data.flatMap((thread): CliSessionSummary[] => {
          if (typeof thread.id !== "string") return [];
          if (typeof thread.cwd === "string" && thread.cwd !== cwd) return [];
          return [
            {
              id: thread.id,
              title:
                shortText(thread.name) ??
                shortText(thread.preview) ??
                "未命名会话",
              updatedAt: codexUpdatedAtOf(thread),
            },
          ];
        });
        succeed(
          sessions
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
            .slice(0, SESSION_LIMIT),
        );
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.once("error", (error) => fail(error));
      child.once("close", (code) => {
        if (settled) return;
        fail(
          new Error(stderr.trim() || `Codex app-server 提前退出，状态码 ${code}`),
        );
      });

      send({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "agent_os",
            title: "Agent OS",
            version: "0.1.0",
          },
        },
      });
    });
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
