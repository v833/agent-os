/**
 * dimagent 引擎插件：把 DimAgent 的 headless 适配器登记到 ctx.cli。
 * DimAgent 的 ACP 接入由 engines/acp 插件提供（标准 ACP 适配器）。
 * 在 cordis.yml 中移除本插件即可整体下线 DimAgent headless 支持。
 */
import type { Context } from "cordis";
import { DimagentAdapter } from "../../cli/dimagent-adapter.js";

export const name = "engines/dimagent";
export const inject = ["cli", "applicationTools"];

export function apply(ctx: Context) {
  ctx.cli.register(new DimagentAdapter(() => ctx.applicationTools.list()));
}
