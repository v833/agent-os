/**
 * Claude Code 协议适配器：负责首次/续聊参数和 stream-json 事件翻译，
 * 不参与子进程生命周期管理。
 */
import type { CliAdapter, CliEvent } from "./types.js";

interface ClaudeEvent {
  type?: unknown;
  subtype?: unknown;
  is_error?: unknown;
  result?: unknown;
  session_id?: unknown;
}

function outputArgs(prompt: string): string[] {
  // 提示词保持为独立参数，不能与用户输入拼成一条 shell 命令。
  return ["-p", prompt, "--output-format", "stream-json", "--verbose"];
}

/** 将 Claude Code 的命令行和 JSONL 协议适配为 Agent OS 公共事件。 */
export class ClaudeAdapter implements CliAdapter {
  readonly id = "claude" as const;
  readonly command = "claude";
  readonly displayName = "Claude Code";

  buildArgs(prompt: string): string[] {
    return outputArgs(prompt);
  }

  buildResumeArgs(prompt: string, sessionId: string): string[] {
    return ["--resume", sessionId, ...outputArgs(prompt)];
  }

  parseEvent(line: string): CliEvent | undefined {
    let event: ClaudeEvent;
    try {
      event = JSON.parse(line) as ClaudeEvent;
    } catch {
      // stdout 偶尔混入诊断文本；忽略噪音，继续等待完整 JSONL 事件。
      return undefined;
    }

    const sessionId =
      typeof event.session_id === "string" ? event.session_id : undefined;

    // init 比最终结果更早暴露 session_id，Runner 会保留它直到本轮结束。
    if (event.type === "system" && event.subtype === "init" && sessionId) {
      return { type: "session", sessionId };
    }

    if (event.type !== "result") return undefined;
    if (event.is_error) {
      return {
        type: "error",
        message:
          typeof event.result === "string"
            ? event.result
            : "Claude Code 执行失败",
        ...(sessionId ? { sessionId } : {}),
      };
    }
    if (typeof event.result !== "string") return undefined;

    return {
      type: "result",
      answer: event.result,
      ...(sessionId ? { sessionId } : {}),
    };
  }
}
