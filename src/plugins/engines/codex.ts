/**
 * codex 引擎插件：把 Codex 适配器登记到 ctx.cli。
 * 在 cordis.yml 中移除本插件即可整体下线 Codex 支持。
 */
import type { Context } from "cordis";
import { CodexAdapter } from "../../cli/codex-adapter.js";

export const name = "engines/codex";
export const inject = ["cli", "applicationTools"];

export function apply(ctx: Context) {
  ctx.cli.register(new CodexAdapter(() => ctx.applicationTools.list()));
}
