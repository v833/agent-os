/**
 * CLI 注册表：集中登记 Agent OS 支持的执行引擎，并负责校验默认引擎配置，
 * 让消息入口只依赖统一适配器契约，不直接创建供应商实现。
 */
import { ClaudeAdapter } from "./claude-adapter.js";
import { CodexAdapter } from "./codex-adapter.js";
import { DimagentAdapter } from "./dimagent-adapter.js";
import { MastraAdapter } from "./mastra-adapter.js";
import { resolve as resolvePath } from "node:path";
import type { CliAccessMode, CliAdapter, CliId } from "./types.js";

const adapters: Record<CliId, CliAdapter> = {
  claude: new ClaudeAdapter(),
  codex: new CodexAdapter(),
  mastra: new MastraAdapter(),
  dimagent: new DimagentAdapter(),
};
const dimagentAcpAdapter = new DimagentAdapter("acp");

/** 按持久化的引擎 ID 返回对应适配器。 */
export function getCliAdapter(
  id: CliId,
  accessMode: CliAccessMode = "headless",
): CliAdapter {
  if (accessMode === "acp") {
    if (id !== "dimagent") {
      throw new Error(`执行引擎 ${id} 不支持 ACP 接入模式`);
    }
    return dimagentAcpAdapter;
  }
  return adapters[id];
}

/** 返回全部已注册适配器，供启动日志和能力检查使用。 */
export function listCliAdapters(): CliAdapter[] {
  return Object.values(adapters);
}

/** 解析 DEFAULT_CLI；用户未配置时按项目约定默认使用 Codex。 */
export function parseCliId(value: string | undefined): CliId {
  if (!value) return "codex";
  if (value === "claude" || value === "codex" || value === "mastra" || value === "dimagent") {
    return value;
  }
  throw new Error(
    `不支持的 DEFAULT_CLI: ${value}，请填写 claude、codex、mastra 或 dimagent`,
  );
}

interface CliWorkdirEnv {
  CLI_WORKDIR?: string;
  CLAUDE_WORKDIR?: string;
}

/** 解析统一工作目录；空的新配置不会屏蔽旧 Claude 工作目录。 */
export function resolveCliWorkdir(
  env: CliWorkdirEnv = process.env,
  cwd = process.cwd(),
): string {
  return resolvePath(
    env.CLI_WORKDIR?.trim() || env.CLAUDE_WORKDIR?.trim() || cwd,
  );
}
