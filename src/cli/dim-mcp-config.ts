/**
 * DimAgent MCP 配置准备：把插件注册的 stdio Server 合并到
 * DimAgent 官方支持的用户级或项目级 mcp.json，让 `dim exec` headless
 * 自动发现 Agent OS 工具。项目级配置按当前任务工作目录隔离，用户级路径
 * 仍保留给显式调用和测试覆盖。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { ApplicationToolServer } from "./app-tools.js";
import { ensureMcpConfigFile } from "./agy-mcp-config.js";

/** 返回当前 DimAgent 应使用的 MCP 配置路径；显式环境变量优先。 */
export function dimagentMcpConfigPath(cwd?: string): string {
  const override = process.env.DIMAGENT_MCP_CONFIG_PATH?.trim();
  if (override) return override;
  if (cwd?.trim()) return join(cwd, ".mcp.json");
  const dimcodeHome = process.env.DIMCODE_HOME?.trim();
  return join(dimcodeHome || join(homedir(), ".dimcode"), "v2", "mcp.json");
}

/**
 * 确保指定 DimAgent MCP 配置可发现所有插件注册的 MCP Server。
 * 未传路径时使用用户级配置；headless 任务应传入当前工作目录。
 */
export function ensureDimagentMcpConfig(
  servers: readonly ApplicationToolServer[],
  configPath?: string,
): Promise<void> {
  const path = configPath?.trim() || dimagentMcpConfigPath();
  return ensureMcpConfigFile(path, servers, "DimAgent");
}

/** 将 Agent OS 工具注入当前 headless 任务的项目级 `.mcp.json`。 */
export function ensureDimagentProjectMcpConfig(
  cwd: string,
  servers: readonly ApplicationToolServer[],
): Promise<void> {
  return ensureDimagentMcpConfig(servers, dimagentMcpConfigPath(cwd));
}
