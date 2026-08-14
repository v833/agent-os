/**
 * claude 引擎插件：把 Claude Code 适配器登记到 ctx.cli。
 * 在 cordis.yml 中移除本插件即可整体下线 Claude Code 支持。
 */
import type { Context } from "cordis";
import { ClaudeAdapter } from "../../cli/claude-adapter.js";

export const name = "engines/claude";
export const inject = ["cli"];

export function apply(ctx: Context) {
  ctx.cli.register(new ClaudeAdapter());
}
