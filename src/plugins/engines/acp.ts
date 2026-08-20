/**
 * acp 引擎插件：把标准 Agent Client Protocol 接入能力登记到 ctx.cli。
 * 通过 cordis.yml 的 engines 列表声明任意多个 ACP 引擎（id/command/args），
 * 即可接入任何提供 ACP server 的 CLI；不配置时默认提供 DimAgent 的 ACP 接入，
 * 以保持历史配置（defaultCli=dimagent + accessMode=acp）开箱即用。
 */
import type { Context } from "cordis";
import { AcpAdapter, type AcpEngineConfig } from "../../cli/acp-adapter.js";

export const name = "engines/acp";
export const inject = ["cli", "applicationTools"];

export interface Config {
  /** 要注册的 ACP 引擎列表；缺省时注册 DimAgent 的 ACP 接入。 */
  engines?: AcpEngineConfig[];
}

/** 默认 ACP 引擎：DimAgent 的 `dim acp` stdio server。 */
const DEFAULT_ACP_ENGINES: AcpEngineConfig[] = [
  {
    id: "dimagent",
    command: "dim",
    args: ["acp"],
    displayName: "DimAgent",
    resumeMethod: "load",
    minAgentVersion: "0.3.10",
    acpMcpTransports: ["http", "sse"],
    session: {
      configOptions: { permission: "full-access", mode: "agent" },
    },
  },
];

export function apply(ctx: Context, config: Config = {}) {
  for (const engine of config.engines ?? DEFAULT_ACP_ENGINES) {
    ctx.cli.register(new AcpAdapter(engine, () => ctx.applicationTools.list()));
  }
}
