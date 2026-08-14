/**
 * config 服务插件：加载并校验 bot 注册表（config/bots.json + 环境变量凭证），
 * 为其他插件提供 ctx.config。它是装配树的第一层，lark/sessions 都依赖它。
 */
import { Service, type Context } from "cordis";
import { resolve } from "node:path";
import { loadBotConfigs, type BotConfig } from "../core/bot-registry.js";

/** 提供已加载 bot 配置的只读入口，其他服务按 bot ID 查询。 */
export class ConfigService extends Service {
  bots: BotConfig[] = [];
  defaultWorkspaces: Record<string, string> = {};

  constructor(ctx: Context) {
    super(ctx, "config");
  }

  bot(id: string): BotConfig | undefined {
    return this.bots.find((bot) => bot.id === id);
  }
}

export const name = "config";

export interface Config {
  /** bots.json 路径；缺省时按 BOTS_CONFIG 环境变量或 config/bots.json。 */
  botsPath?: string;
  baseDirectory?: string;
}

export async function apply(ctx: Context, config: Config = {}) {
  const service = new ConfigService(ctx);
  const botsPath = resolve(
    config.baseDirectory ?? process.cwd(),
    config.botsPath ?? process.env.BOTS_CONFIG ?? "config/bots.json",
  );
  // 配置解析失败直接让插件加载失败，阻止后续依赖它的插件启动。
  service.bots = await loadBotConfigs(botsPath);
  service.defaultWorkspaces = Object.fromEntries(
    service.bots.map((bot) => [bot.id, bot.workspaceDir]),
  );
  console.log(`[配置] 已加载 ${service.bots.length} 个 bot 注册表`);
}
