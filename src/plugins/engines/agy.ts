/**
 * agy 引擎插件：把 Antigravity CLI 适配器登记到 ctx.cli。
 * 在 cordis.yml 中移除本插件即可整体下线 Antigravity 支持。
 * agy 通过工作区 `.agents/mcp_config.json` 自动发现 MCP；应用工具由适配器在
 * 每轮 headless 启动前写入，仍由 application-tools 插件统一提供描述。
 */
import type { Context } from "cordis";
import { AgyAdapter } from "../../cli/agy-adapter.js";

export const name = "engines/agy";
export const inject = ["cli", "applicationTools"];

export function apply(ctx: Context) {
  ctx.cli.register(new AgyAdapter(() => ctx.applicationTools.list()));
}
