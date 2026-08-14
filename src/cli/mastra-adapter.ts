/**
 * Mastra 适配器：把 Mastra Agent 包装成 Agent OS 的第三种 CLI 类引擎。
 * 与 Codex/Claude 一样通过子进程驱动——用 node + tsx 拉起 mastra-runner，
 * 使其复用 Runner 的超时、取消、进程树清理与 JSONL 事件翻译链路。
 */
import { fileURLToPath } from "node:url";
import type { CliAdapter, CliEvent } from "./types.js";

// tsx 的 ESM 入口由包导出表提供；运行与测试都基于源码（tsx 模式），
// 因此 runner 也始终指向 src/ 下的 TypeScript 入口，与 dist 无关。
const tsxCliPath = fileURLToPath(import.meta.resolve("tsx/cli"));
const runnerPath = fileURLToPath(
  new URL("../agents/mastra-runner.ts", import.meta.url),
);

interface MastraEvent {
  type?: unknown;
  toolUseId?: unknown;
  toolName?: unknown;
  label?: unknown;
  detail?: unknown;
  failed?: unknown;
  answer?: unknown;
  message?: unknown;
  stats?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 把 runner 输出的 JSONL 行翻译成 Agent OS 公共事件。 */
export class MastraAdapter implements CliAdapter {
  readonly id = "mastra" as const;
  // 用 node 可执行文件直接托管 tsx，避免 Windows 下 .cmd/.ps1 包装器
  // 破坏 spawn(shell=false) 的安全边界。
  readonly command = process.execPath;
  readonly displayName = "Mastra Agent";

  buildArgs(prompt: string): string[] {
    return [tsxCliPath, runnerPath, prompt];
  }

  /** Mastra 引擎没有原生会话恢复能力，任何恢复尝试都应该显式失败。 */
  buildResumeArgs(_prompt: string, _sessionId: string): string[] {
    throw new Error("Mastra 引擎不保存会话，请直接发起新任务");
  }

  /** Mastra 没有原生上下文整理协议，/compact 应使用普通新任务代替。 */
  buildCompactPlan(_sessionId: string): never {
    throw new Error("Mastra 引擎不支持 /compact");
  }

  parseEvents(line: string): CliEvent[] {
    let event: MastraEvent;
    try {
      event = JSON.parse(line) as MastraEvent;
    } catch {
      return [];
    }

    if (event.type === "tool_start") {
      if (
        typeof event.toolUseId !== "string" ||
        typeof event.toolName !== "string"
      ) {
        return [];
      }
      return [
        {
          type: "tool_start",
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          label: typeof event.label === "string" ? event.label : "调用工具",
          ...(typeof event.detail === "string" && event.detail
            ? { detail: event.detail }
            : {}),
        },
      ];
    }

    if (event.type === "tool_end") {
      if (typeof event.toolUseId !== "string") return [];
      return [
        {
          type: "tool_end",
          toolUseId: event.toolUseId,
          failed: event.failed === true,
        },
      ];
    }

    if (event.type === "result") {
      const stats = isRecord(event.stats) ? event.stats : {};
      const inputTokens =
        typeof stats.inputTokens === "number" && Number.isFinite(stats.inputTokens)
          ? stats.inputTokens
          : undefined;
      const outputTokens =
        typeof stats.outputTokens === "number" &&
        Number.isFinite(stats.outputTokens)
          ? stats.outputTokens
          : undefined;
      return [
        {
          type: "result",
          answer: typeof event.answer === "string" ? event.answer : "",
          ...(inputTokens !== undefined || outputTokens !== undefined
            ? {
                stats: {
                  ...(inputTokens !== undefined ? { inputTokens } : {}),
                  ...(outputTokens !== undefined ? { outputTokens } : {}),
                },
              }
            : {}),
        },
      ];
    }

    if (event.type === "error") {
      return [
        {
          type: "error",
          message:
            typeof event.message === "string"
              ? event.message
              : "Mastra Agent 执行失败",
        },
      ];
    }

    return [];
  }
}