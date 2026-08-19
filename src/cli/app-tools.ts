/**
 * 应用工具公共契约：描述由插件注册的 stdio MCP Server，并把同一份描述
 * 转换为 Claude Code / Codex 各自的启动参数。这里不包含任何具体业务工具。
 */

/** 一个应用工具插件向执行引擎暴露的 stdio MCP Server。 */
export interface ApplicationToolServer {
  id: string;
  command: string;
  args: readonly string[];
  tools: readonly string[];
}

export type ApplicationToolProvider = () => readonly ApplicationToolServer[];

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
