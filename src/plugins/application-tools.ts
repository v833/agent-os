/**
 * application-tools 服务插件：维护应用工具 MCP Server 注册表。
 * 业务插件登记 server，执行引擎只读取通用描述，不依赖具体工具实现。
 */
import { Service, type Context } from "cordis";
import type { ApplicationToolServer } from "../cli/app-tools.js";

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** 应用工具 MCP Server 注册表；同时拒绝会造成结果路由歧义的重名工具。 */
export class ApplicationToolsService extends Service {
  private readonly servers = new Map<string, ApplicationToolServer>();

  constructor(ctx: Context) {
    super(ctx, "applicationTools");
  }

  register(server: ApplicationToolServer): () => void {
    if (!NAME_PATTERN.test(server.id)) {
      throw new Error(`应用工具 server id 非法: ${server.id}`);
    }
    if (!server.command.trim()) {
      throw new Error(`应用工具 ${server.id} 的启动命令不能为空`);
    }
    if (server.tools.length === 0) {
      throw new Error(`应用工具 ${server.id} 至少需要声明一个工具`);
    }
    if (this.servers.has(server.id)) {
      throw new Error(`应用工具 server 已注册: ${server.id}`);
    }
    const knownTools = new Set(
      [...this.servers.values()].flatMap((candidate) => candidate.tools),
    );
    for (const tool of server.tools) {
      if (!NAME_PATTERN.test(tool)) {
        throw new Error(`应用工具名非法: ${tool}`);
      }
      if (knownTools.has(tool)) {
        throw new Error(`应用工具名重复: ${tool}`);
      }
    }

    const registered = {
      ...server,
      args: [...server.args],
      tools: [...server.tools],
    };
    this.servers.set(server.id, registered);
    return () => {
      if (this.servers.get(server.id) === registered) {
        this.servers.delete(server.id);
      }
    };
  }

  list(): ApplicationToolServer[] {
    return [...this.servers.values()].map((server) => ({
      ...server,
      args: [...server.args],
      tools: [...server.tools],
    }));
  }
}

export const name = "application-tools";

export function apply(ctx: Context) {
  new ApplicationToolsService(ctx);
}
