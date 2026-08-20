/**
 * 应用工具公共契约：描述由插件注册的 stdio MCP Server，并把同一份描述
 * 转换为各执行协议所需的启动参数。这里不包含任何具体业务工具。
 */
import type { McpServer } from "@agentclientprotocol/sdk";
import type { AcpMcpTransport } from "./types.js";

/** 一个应用工具插件向执行引擎暴露的 stdio MCP Server。 */
export interface ApplicationToolServer {
  id: string;
  command: string;
  args: readonly string[];
  tools: readonly string[];
  /** ACP 不支持 stdio 时可声明 loopback HTTP MCP 入口；headless 仍使用 command/args。 */
  acp?: {
    type: "http";
    url: string;
    headers?: readonly { name: string; value: string }[];
  };
}

export type ApplicationToolProvider = () => readonly ApplicationToolServer[];

/** 将 Agent OS 的 stdio Server 描述转换成 ACP session/* 请求所需的结构。 */
export function acpMcpServers(
  servers: readonly ApplicationToolServer[],
  supportedTransports?: readonly AcpMcpTransport[],
): McpServer[] {
  const supported = supportedTransports ? new Set(supportedTransports) : undefined;
  return servers.flatMap((server) => {
    const transport: AcpMcpTransport = server.acp?.type ?? "stdio";
    if (supported && !supported.has(transport)) return [];
    if (server.acp) {
      return [{
        type: "http",
        name: server.id,
        url: server.acp.url,
        headers: (server.acp.headers ?? []).map((header) => ({ ...header })),
      } as McpServer];
    }
    return [{
      name: server.id,
      command: server.command,
      args: [...server.args],
      env: [],
    } as McpServer];
  });
}

/** 找出因 ACP transport 能力不足而不会被发送的应用工具，供 daemon 记录可诊断 warning。 */
export function unsupportedAcpMcpServers(
  servers: readonly ApplicationToolServer[],
  supportedTransports?: readonly AcpMcpTransport[],
): readonly string[] {
  if (!supportedTransports) return [];
  const supported = new Set(supportedTransports);
  return servers
    .filter((server) => !supported.has(server.acp?.type ?? "stdio"))
    .map((server) => server.id);
}

/** Claude Code 会把 MCP 工具名展开成 `mcp__<server>__<tool>`。 */
export function claudeMcpToolName(serverId: string, toolName: string): string {
  return `mcp__${serverId}__${toolName}`;
}

/** 从 Claude Code 的展开名称还原已注册的应用工具名。 */
export function findClaudeApplicationTool(
  servers: readonly ApplicationToolServer[],
  wireName: string,
): string | undefined {
  for (const server of servers) {
    const tool = server.tools.find(
      (candidate) => claudeMcpToolName(server.id, candidate) === wireName,
    );
    if (tool) return tool;
  }
  return undefined;
}

/** 从 Codex 的 server/tool 字段识别已注册的应用工具。 */
export function findCodexApplicationTool(
  servers: readonly ApplicationToolServer[],
  serverId: unknown,
  toolName: unknown,
): string | undefined {
  if (typeof serverId !== "string" || typeof toolName !== "string") {
    return undefined;
  }
  const server = servers.find((candidate) => candidate.id === serverId);
  return server?.tools.includes(toolName) ? toolName : undefined;
}

/** 从 agy/Gemini 的工具名（裸名或 MCP 展开名）识别已注册应用工具。 */
export function findAgyApplicationTool(
  servers: readonly ApplicationToolServer[],
  wireName: unknown,
): string | undefined {
  if (typeof wireName !== "string") return undefined;
  for (const server of servers) {
    for (const tool of server.tools) {
      if (
        wireName === tool ||
        wireName === `${server.id}.${tool}` ||
        wireName === `${server.id}/${tool}` ||
        wireName === `mcp__${server.id}__${tool}`
      ) {
        return tool;
      }
    }
  }
  return undefined;
}

/** 从 ACP 的工具名（裸名或常见 MCP 展开名）识别已注册应用工具。 */
export function findAcpApplicationTool(
  servers: readonly ApplicationToolServer[],
  wireName: unknown,
): string | undefined {
  if (typeof wireName !== "string") return undefined;
  for (const server of servers) {
    for (const tool of server.tools) {
      if (
        wireName === tool ||
        wireName === `${server.id}.${tool}` ||
        wireName === `${server.id}/${tool}` ||
        wireName === `${server.id}:${tool}` ||
        wireName === `${server.id}__${tool}` ||
        wireName === `mcp__${server.id}__${tool}`
      ) {
        return tool;
      }
    }
  }
  return undefined;
}

/** Claude Code 的 MCP 配置参数（--mcp-config JSON）。 */
export function claudeAppToolArgs(
  servers: readonly ApplicationToolServer[],
): string[] {
  if (servers.length === 0) return [];
  return [
    "--mcp-config",
    JSON.stringify({
      mcpServers: Object.fromEntries(
        servers.map((server) => [
          server.id,
          {
            type: "stdio",
            command: server.command,
            args: server.args,
          },
        ]),
      ),
    }),
  ];
}

/** Codex 的 MCP 配置参数（-c 点路径写法，值按 JSON 编码）。 */
export function codexAppToolArgs(
  servers: readonly ApplicationToolServer[],
): string[] {
  return servers.flatMap((server) => [
    "-c",
    `mcp_servers.${server.id}.command=${JSON.stringify(server.command)}`,
    "-c",
    `mcp_servers.${server.id}.args=${JSON.stringify(server.args)}`,
  ]);
}
