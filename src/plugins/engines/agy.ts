/**
 * agy 引擎插件：把 Antigravity CLI 适配器登记到 ctx.cli。
 * 在 cordis.yml 中移除本插件即可整体下线 Antigravity 支持。
 * 注：agy 1.1.x 无命令行 MCP 注入点，不接入 Agent OS 应用工具。
 */
import type { Context } from "cordis";
import { AgyAdapter } from "../../cli/agy-adapter.js";

export const name = "engines/agy";
export const inject = ["cli"];

export function apply(ctx: Context) {
  ctx.cli.register(new AgyAdapter());
}
