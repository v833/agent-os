/**
 * CLI MCP 配置准备：把插件注册的 stdio Server 合并到指定配置文件，
 * 让 headless 执行引擎自动发现 Agent OS 工具；只写入执行引擎提供的
 * server，不覆盖用户已有的其他 MCP 配置。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ApplicationToolServer } from "./app-tools.js";

interface AgyMcpConfig {
  mcpServers?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

const pendingWrites = new Map<string, Promise<void>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readConfig(path: string, label: string): Promise<AgyMcpConfig> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  if (!content.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`${label} MCP 配置格式错误: ${path}`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error(`${label} MCP 配置必须是 JSON 对象: ${path}`);
  }
  if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)) {
    throw new Error(`${label} MCP 配置的 mcpServers 必须是对象: ${path}`);
  }
  return parsed as AgyMcpConfig;
}

/** 把 Agent OS 的 stdio Server 合并进一个 CLI 的 mcpServers 配置文件。 */
export async function ensureMcpConfigFile(
  path: string,
  servers: readonly ApplicationToolServer[],
  label = "MCP",
): Promise<void> {
  if (servers.length === 0) return;
  const previous = pendingWrites.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    const config = await readConfig(path, label);
    const mcpServers = isRecord(config.mcpServers) ? config.mcpServers : {};
    for (const server of servers) {
      // stdio 配置使用 command/args；tools 仅供 Agent OS 结果路由，不写入文件。
      mcpServers[server.id] = {
        command: server.command,
        args: [...server.args],
      };
    }
    config.mcpServers = mcpServers;
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      await rename(temporaryPath, path);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  });
  pendingWrites.set(path, current);
  try {
    await current;
  } finally {
    if (pendingWrites.get(path) === current) pendingWrites.delete(path);
  }
}

/** 确保 agy 在指定工作区及全局配置发现当前已注册的 Agent OS MCP Server。 */
export async function ensureAgyMcpConfig(
  cwd: string,
  servers: readonly ApplicationToolServer[],
): Promise<void> {
  await ensureMcpConfigFile(join(cwd, ".agents", "mcp_config.json"), servers, "agy");
  await ensureMcpConfigFile(
    join(homedir(), ".gemini", "config", "mcp_config.json"),
    servers,
    "agy global",
  ).catch(() => undefined);
}
