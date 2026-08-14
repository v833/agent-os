/**
 * CLI 适配层公共契约：统一 Codex、Claude Code 与 DimAgent 的参数构造和事件语义，
 * 让 Agent OS 的进程控制与具体供应商协议彼此独立。
 */

/** 引擎标识；内置引擎保持字面量提示，同时允许插件注册任意扩展 id（如 ACP 引擎）。 */
export type CliId = "codex" | "claude" | "dimagent" | (string & {});

/** DimAgent 的接入协议；其他引擎目前只支持 headless。 */
export type CliAccessMode = "headless" | "acp";

export interface CliRunStats {
  durationMs?: number;
  turns?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
}

/** /resume 卡片使用的轻量原生会话摘要，不包含消息正文。 */
export interface CliSessionSummary {
  id: string;
  title: string;
  updatedAt: string;
}

/** 描述某个 CLI 的原生上下文整理协议和启动参数。 */
export type CliCompactPlan =
  | {
      protocol: "claude-stream-json";
      command: string;
      args: string[];
    }
  | {
      protocol: "codex-app-server";
      command: string;
      args: string[];
      sessionId: string;
    };

export type CliEvent =
  | { type: "session"; sessionId: string }
  | {
      type: "tool_start";
      toolUseId: string;
      toolName: string;
      label: string;
      detail?: string;
    }
  | { type: "tool_end"; toolUseId: string; failed: boolean }
  | { type: "context"; usedTokens: number }
  | {
      type: "result";
      answer: string;
      sessionId?: string;
      stats?: CliRunStats;
    }
  | { type: "error"; message: string; sessionId?: string };

/** 描述一种可由通用 Runner 驱动的无头 CLI。 */
export interface CliAdapter {
  readonly id: CliId;
  readonly command: string;
  readonly displayName: string;
  readonly accessMode?: CliAccessMode;
  buildArgs(prompt: string): string[];
  buildResumeArgs(prompt: string, sessionId: string): string[];
  buildCompactPlan(sessionId: string, instructions?: string): CliCompactPlan;
  parseEvents(line: string): CliEvent[];
  /** 判断失败信息是否明确表示恢复指针已经失效。 */
  isSessionUnavailable?(message: string): boolean;
  /** 列出该引擎在当前工作目录的原生会话，供 /resume 卡片展示；未实现表示不支持。 */
  listNativeSessions?(cwd: string): Promise<CliSessionSummary[]>;
  /** 是否对明确瞬时断流做有限重试（目前只有 Codex 声明）。 */
  readonly retryOnDisconnect?: boolean;
  /** 原生上下文整理的策略描述；缺省用通用文案。 */
  readonly compactDetail?: string;
}

/** CLI 一轮执行完成后返回给会话层的统一结果。 */
export interface CliRunResult {
  answer: string;
  sessionId?: string;
  stats?: CliRunStats;
}
