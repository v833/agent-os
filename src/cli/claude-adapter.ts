/**
 * Claude Code 协议适配器：负责首次/续聊参数、stream-json 事件翻译和
 * 项目 JSONL 原生会话列表；不参与子进程生命周期管理。
 */
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { CliAdapter, CliEvent, CliRunStats, CliSessionSummary } from "./types.js";

/** /resume 卡片最多展示的原生会话数量。 */
const SESSION_LIMIT = 8;

interface ClaudeEvent {
  type?: unknown;
  subtype?: unknown;
  is_error?: unknown;
  result?: unknown;
  session_id?: unknown;
  duration_ms?: unknown;
  num_turns?: unknown;
  usage?: unknown;
  modelUsage?: unknown;
  message?: unknown;
}

interface ClaudeContentBlock {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  is_error?: unknown;
}

const TOOL_LABELS: Record<string, string> = {
  Agent: "启动子任务",
  Bash: "运行命令",
  Edit: "修改文件",
  Glob: "查找文件",
  Grep: "搜索代码",
  Read: "读取文件",
  Task: "启动子任务",
  TaskOutput: "等待子任务完成",
  WebFetch: "读取网页",
  WebSearch: "搜索资料",
  Write: "写入文件",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function shortPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const normalized = value.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.slice(normalized.startsWith("/") ? -2 : -3).join("/");
}

function shortText(value: unknown, maxLength = 72): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > maxLength
    ? `${text.slice(0, maxLength - 1)}…`
    : text;
}

function toolDetail(name: string, input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  if (["Read", "Edit", "Write"].includes(name)) {
    return shortPath(input.file_path);
  }
  if (name === "Glob" || name === "Grep") return shortText(input.pattern);
  if (name === "Bash") return shortText(input.description);
  if (name === "Agent" || name === "Task") {
    return shortText(input.description);
  }
  if (name === "WebSearch") return shortText(input.query);
  return undefined;
}

function messageBlocks(message: unknown): ClaudeContentBlock[] {
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isRecord);
}

function usageTokens(usage: unknown): number | undefined {
  if (!isRecord(usage)) return undefined;
  const values = [
    asNumber(usage.input_tokens),
    asNumber(usage.output_tokens),
    asNumber(usage.cache_read_input_tokens),
    asNumber(usage.cache_creation_input_tokens),
  ].filter((value): value is number => value !== undefined);
  return values.length
    ? values.reduce((sum, value) => sum + value, 0)
    : undefined;
}

function contextWindowTokens(modelUsage: unknown): number | undefined {
  if (!isRecord(modelUsage)) return undefined;
  const windows = Object.values(modelUsage)
    .filter(isRecord)
    .map((usage) => asNumber(usage.contextWindow))
    .filter((value): value is number => value !== undefined && value > 0);
  return windows.length ? Math.max(...windows) : undefined;
}

function parseStats(event: ClaudeEvent): CliRunStats | undefined {
  const usage = isRecord(event.usage) ? event.usage : {};
  const stats: CliRunStats = {
    durationMs: asNumber(event.duration_ms),
    turns: asNumber(event.num_turns),
    totalTokens: usageTokens(usage),
    inputTokens: asNumber(usage.input_tokens),
    outputTokens: asNumber(usage.output_tokens),
    cacheReadTokens: asNumber(usage.cache_read_input_tokens),
    cacheCreationTokens: asNumber(usage.cache_creation_input_tokens),
    contextWindowTokens: contextWindowTokens(event.modelUsage),
  };
  return Object.values(stats).some((value) => value !== undefined)
    ? stats
    : undefined;
}

function outputArgs(prompt: string): string[] {
  // 机器人无法展示交互式确认；仅在受信任且可回退的配置工作目录中使用。
  // 提示词保持为独立参数，不能与用户输入拼成一条 shell 命令。
  return [
    "--dangerously-skip-permissions",
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
  ];
}

function claudeUserPrompt(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  if (typeof message.content === "string") return shortText(message.content);
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter(isRecord)
    .filter((block) => block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join(" ");
  return shortText(text);
}

/** Claude 按 cwd 落盘项目会话目录；特殊字符映射成连字符以便反向定位。 */
function claudeProjectDirectory(configDir: string, cwd: string): string {
  const key = cwd.replace(/[^A-Za-z0-9]/g, "-");
  return join(configDir, "projects", key);
}

/** 从单个 JSONL 会话文件提取摘要，并精确校验其 cwd 与目标一致。 */
async function readClaudeSession(
  filePath: string,
  expectedCwd: string,
): Promise<CliSessionSummary | undefined> {
  const lines = createInterface({ input: createReadStream(filePath) });
  let sessionId: string | undefined;
  let observedCwd: string | undefined;
  let firstPrompt: string | undefined;
  let lastPrompt: string | undefined;
  let title: string | undefined;

  try {
    for await (const line of lines) {
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(row)) continue;
      if (typeof row.sessionId === "string") sessionId = row.sessionId;
      if (typeof row.session_id === "string") sessionId = row.session_id;
      if (typeof row.cwd === "string") observedCwd = row.cwd;
      if (row.type === "ai-title") title = shortText(row.aiTitle) ?? title;
      if (row.type === "last-prompt") {
        lastPrompt = shortText(row.lastPrompt) ?? lastPrompt;
      }
      if (row.type === "user" && !firstPrompt) {
        firstPrompt = claudeUserPrompt(row.message);
      }
    }
  } finally {
    lines.close();
  }

  // Claude 的项目目录可能包含别的 cwd 的记录，必须再次精确过滤。
  if (!sessionId || observedCwd !== expectedCwd) return undefined;
  const metadata = await stat(filePath);
  return {
    id: sessionId,
    title: title ?? lastPrompt ?? firstPrompt ?? "未命名会话",
    updatedAt: metadata.mtime.toISOString(),
  };
}

/** 将 Claude Code 的命令行和 JSONL 协议适配为 Agent OS 公共事件。 */
export class ClaudeAdapter implements CliAdapter {
  readonly id = "claude" as const;
  readonly command = "claude";
  readonly displayName = "Claude Code";
  readonly accessMode = "headless" as const;

  buildArgs(prompt: string): string[] {
    return outputArgs(prompt);
  }

  buildResumeArgs(prompt: string, sessionId: string): string[] {
    return ["--resume", sessionId, ...outputArgs(prompt)];
  }

  buildCompactPlan(sessionId: string, instructions?: string) {
    const command = instructions?.trim()
      ? `/compact ${instructions.trim()}`
      : "/compact";
    return {
      protocol: "claude-stream-json" as const,
      command: this.command,
      args: this.buildResumeArgs(command, sessionId),
    };
  }

  isSessionUnavailable(message: string): boolean {
    const text = message.toLowerCase();
    return (
      /(?:session|conversation)[^\n]*(?:not found|could not find|does not exist|expired|invalid|unknown)/.test(
        text,
      ) ||
      /(?:not found|could not find|does not exist|expired|invalid|unknown)[^\n]*(?:session|conversation)/.test(
        text,
      ) ||
      /no (?:such )?(?:session|conversation)\b/.test(text)
    );
  }

  /** 读取 Claude 当前项目目录下的 JSONL 原生会话，供 /resume 卡片展示。 */
  async listNativeSessions(cwd: string): Promise<CliSessionSummary[]> {
    const configDir =
      process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
    const projectDir = claudeProjectDirectory(configDir, cwd);
    let names: string[];
    try {
      names = await readdir(projectDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const sessions = await Promise.all(
      names
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => readClaudeSession(join(projectDir, name), cwd)),
    );
    return sessions
      .filter((session): session is CliSessionSummary => session !== undefined)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, SESSION_LIMIT);
  }

  /** 兼容旧的单事件调用；运行链路统一使用 parseEvents。 */
  parseEvent(line: string): CliEvent | undefined {
    return this.parseEvents(line)[0];
  }

  parseEvents(line: string): CliEvent[] {
    let event: ClaudeEvent;
    try {
      event = JSON.parse(line) as ClaudeEvent;
    } catch {
      // stdout 偶尔混入诊断文本；忽略噪音，继续等待完整 JSONL 事件。
      return [];
    }

    const sessionId =
      typeof event.session_id === "string" ? event.session_id : undefined;

    // init 比最终结果更早暴露 session_id，Runner 会保留它直到本轮结束。
    if (event.type === "system" && event.subtype === "init" && sessionId) {
      return [{ type: "session", sessionId }];
    }
    if (event.type === "assistant") {
      const message = isRecord(event.message) ? event.message : {};
      const usedTokens = usageTokens(message.usage);
      const contextEvents: CliEvent[] =
        usedTokens === undefined ? [] : [{ type: "context", usedTokens }];
      const toolEvents = messageBlocks(event.message).flatMap(
        (block): CliEvent[] => {
          if (
            block.type !== "tool_use" ||
            typeof block.id !== "string" ||
            typeof block.name !== "string"
          ) {
            return [];
          }
          const detail = toolDetail(block.name, block.input);
          return [
            {
              type: "tool_start",
              toolUseId: block.id,
              toolName: block.name,
              label: TOOL_LABELS[block.name] ?? `调用 ${block.name}`,
              ...(detail ? { detail } : {}),
            },
          ];
        },
      );
      // 一条 assistant 消息可能同时携带用量和多个工具，必须全部返回。
      return [...contextEvents, ...toolEvents];
    }
    if (event.type === "user") {
      return messageBlocks(event.message).flatMap((block): CliEvent[] => {
        if (
          block.type !== "tool_result" ||
          typeof block.tool_use_id !== "string"
        ) {
          return [];
        }
        return [
          {
            type: "tool_end",
            toolUseId: block.tool_use_id,
            failed: block.is_error === true,
          },
        ];
      });
    }

    if (event.type !== "result") return [];
    if (event.is_error) {
      return [
        {
          type: "error",
          message:
            typeof event.result === "string"
              ? event.result
              : "Claude Code 执行失败",
          ...(sessionId ? { sessionId } : {}),
        },
      ];
    }
    if (typeof event.result !== "string") return [];

    const stats = parseStats(event);
    return [
      {
        type: "result",
        answer: event.result,
        ...(sessionId ? { sessionId } : {}),
        ...(stats ? { stats } : {}),
      },
    ];
  }
}
