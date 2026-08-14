/**
 * Bot 注册表：在 Agent OS 启动前读取并校验多 bot 配置，
 * 把环境变量中的飞书凭证解析成入口可直接使用的运行配置。
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { CliId } from "../cli/types.js";
import { resolveWorkspacePath } from "./workspace.js";

/** 单台已启用 bot 的完整运行配置，不再包含间接的环境变量名。 */
export interface BotConfig {
  id: string;
  appId: string;
  appSecret: string;
  defaultCliId: CliId;
  systemPrompt: string;
  workspaceDir: string;
  /** 当前 bot 完成任务后接收审查任务的目标 bot。 */
  reviewBy?: string;
  /** 一次 bot 协作允许发生的最大交接次数。 */
  collaborationMaxRounds: number;
}

type Environment = Record<string, string | undefined>;

const BotSchema = z.object({
  id: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9_-]{0,31}$/,
      "bot id 只能使用小写字母、数字、连字符和下划线",
    ),
  appIdEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  appSecretEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  defaultCli: z.enum(["claude", "codex", "mastra"]),
  workspace: z.string().trim().min(1).optional(),
  systemPrompt: z.string().trim().optional().default(""),
  reviewBy: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/)
    .optional(),
  collaborationMaxRounds: z.number().int().min(1).max(4).optional().default(2),
  enabled: z.boolean().optional().default(true),
});

const BotConfigFileSchema = z.object({
  bots: z.array(BotSchema).min(1),
});

/** 校验注册表，并只返回凭证完整的已启用 bot。 */
export function parseBotConfigs(
  input: unknown,
  env: Environment,
  baseDirectory = process.cwd(),
): BotConfig[] {
  const parsed = BotConfigFileSchema.parse(input);
  const ids = new Set<string>();
  for (const bot of parsed.bots) {
    if (ids.has(bot.id)) throw new Error(`bot id 不能重复: ${bot.id}`);
    ids.add(bot.id);
  }

  const configs = parsed.bots
    .filter((bot) => bot.enabled)
    .map((bot) => {
      const appId = env[bot.appIdEnv]?.trim() ?? "";
      const appSecret = env[bot.appSecretEnv]?.trim() ?? "";
      if (!appId) {
        throw new Error(`bot ${bot.id} 缺少环境变量 ${bot.appIdEnv}`);
      }
      if (!appSecret) {
        throw new Error(`bot ${bot.id} 缺少环境变量 ${bot.appSecretEnv}`);
      }
      return {
        id: bot.id,
        appId,
        appSecret,
        defaultCliId: bot.defaultCli,
        systemPrompt: bot.systemPrompt,
        ...(bot.reviewBy ? { reviewBy: bot.reviewBy } : {}),
        collaborationMaxRounds: bot.collaborationMaxRounds,
        workspaceDir: resolveWorkspacePath(
          bot.workspace ??
            (env.CLI_WORKDIR?.trim() ||
              env.CLAUDE_WORKDIR?.trim() ||
              "."),
          baseDirectory,
        ),
      };
  });
  if (configs.length === 0) throw new Error("至少需要启用一个 bot");
  const enabledIds = new Set(configs.map((config) => config.id));
  for (const config of configs) {
    if (config.reviewBy && !enabledIds.has(config.reviewBy)) {
      throw new Error(
        `bot ${config.id} 的 reviewBy 指向未启用的 bot: ${config.reviewBy}`,
      );
    }
    if (config.reviewBy === config.id) {
      throw new Error(`bot ${config.id} 不能把自己配置为 reviewBy`);
    }
  }
  return configs;
}

/** 从 JSON 文件加载 bot 注册表，并把配置错误补充为启动可读信息。 */
export async function loadBotConfigs(
  filePath: string,
  env: Environment = process.env,
  baseDirectory = process.cwd(),
): Promise<BotConfig[]> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `找不到 bot 配置文件: ${filePath}。请复制 config/bots.example.json 后填写配置。`,
      );
    }
    throw error;
  }

  try {
    return parseBotConfigs(JSON.parse(content), env, baseDirectory);
  } catch (error) {
    throw new Error(`bot 配置文件格式错误: ${(error as Error).message}`);
  }
}

/** 把当前 bot 的角色说明放到原始任务前，空角色不改写任务。 */
export function buildBotPrompt(systemPrompt: string, prompt: string): string {
  const role = systemPrompt.trim();
  if (!role) return prompt;
  return `角色：${role}\n\n任务：${prompt}`;
}
