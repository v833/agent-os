/**
 * Bot 注册表：在 Agent OS 启动前读取并校验多 bot 配置，
 * 把环境变量中的飞书凭证解析成入口可直接使用的运行配置。
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { CliAccessMode, CliId } from "../cli/types.js";
import { resolveWorkspacePath } from "./workspace.js";

/** 单台已启用 bot 的完整运行配置，不再包含间接的环境变量名。 */
export interface BotConfig {
  id: string;
  appId: string;
  appSecret: string;
  defaultCliId: CliId;
  accessMode: CliAccessMode;
  /** 一句话职责说明，用于飞书团队卡片展示与提示词中的身份描述。 */
  role: string;
  /** 该成员处理任务时必须遵守的项目 Skill 名称（如 grill-me）。 */
  skills: string[];
  systemPrompt: string;
  workspaceDir: string;
  /** 当前 bot 完成任务后接收审查任务的目标 bot。 */
  reviewBy?: string;
  /** 一次 bot 协作允许发生的最大交接次数。 */
  collaborationMaxRounds: number;
  /**
   * 该 bot 执行 CLI 时注入的网络代理 URL（可选）；配置后会把 HTTP_PROXY/
   * HTTPS_PROXY/ALL_PROXY 注入子进程，供需要代理访问云端服务的引擎（如 agy）使用。
   * 不配置则不注入，保持直连。
   */
  proxy?: string;
}

/** 完整团队配置：负责人的稳定 ID 与全部启用的成员。 */
export interface AgentOsConfig {
  teamLeaderId: string;
  defaultProductDeliveryMode: ProductDeliveryMode;
  bots: BotConfig[];
}

/** 产品方案的唯一交付方式；同一任务不能同时维护两种产物。 */
export type ProductDeliveryMode = "local" | "lark-doc";

/** 把 bot 级代理配置转换为标准 CLI 子进程环境；缺省时继承父进程环境。 */
export function botCliEnvironment(
  config: BotConfig,
): Record<string, string> | undefined {
  if (!config.proxy) return undefined;
  return {
    HTTP_PROXY: config.proxy,
    HTTPS_PROXY: config.proxy,
    ALL_PROXY: config.proxy,
    NO_PROXY: "localhost,127.0.0.1,::1",
  };
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
  defaultCli: z.string().trim().min(1),
  accessMode: z.enum(["headless", "acp"]).optional(),
  // mode 作为短字段兼容；文档统一使用不易与 agent/plan 模式混淆的 accessMode。
  mode: z.enum(["headless", "acp"]).optional(),
  workspace: z.string().trim().min(1).optional(),
  systemPrompt: z.string().trim().optional().default(""),
  role: z.string().trim().min(1),
  skills: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/))
    .optional()
    .default([]),
  reviewBy: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/)
    .optional(),
  // 团队默认最多 16 轮交接，防止协作失控循环；任务完成时会立即结束。
  collaborationMaxRounds: z
    .number()
    .int()
    .min(1)
    .max(32)
    .optional()
    .default(16),
  // 网络代理 URL（可选）：bot 执行 CLI 时注入 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY。
  proxy: z.string().url().optional(),
  enabled: z.boolean().optional().default(true),
});

const BotConfigFileSchema = z.object({
  teamLeader: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  // 未配置时保留旧版本地产物流程；需要云文档时在配置中显式选择。
  defaultProductDeliveryMode: z.enum(["local", "lark-doc"]).optional().default("local"),
  bots: z.array(BotSchema).min(1),
});

/** 校验注册表，并只返回凭证完整的已启用 bot。 */
export function parseAgentOsConfig(
  input: unknown,
  env: Environment,
  baseDirectory = process.cwd(),
): AgentOsConfig {
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
      if (bot.accessMode && bot.mode && bot.accessMode !== bot.mode) {
        throw new Error(`bot ${bot.id} 的 accessMode 与 mode 配置冲突`);
      }
      const accessMode = bot.accessMode ?? bot.mode ?? "headless";
      // ACP 接入是标准能力：任何 defaultCli 都可声明使用，前提是该引擎已通过
      // engines/acp 等插件注册对应接入模式（运行时由 cli 注册表校验并报错）。
      return {
        id: bot.id,
        appId,
        appSecret,
        defaultCliId: bot.defaultCli,
        accessMode,
        role: bot.role,
        skills: [...new Set(bot.skills)],
        systemPrompt: bot.systemPrompt,
        ...(bot.reviewBy ? { reviewBy: bot.reviewBy } : {}),
        collaborationMaxRounds: bot.collaborationMaxRounds,
        ...(bot.proxy ? { proxy: bot.proxy } : {}),
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
  if (!enabledIds.has(parsed.teamLeader)) {
    throw new Error(`teamLeader 指向未启用的 bot: ${parsed.teamLeader}`);
  }
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
  return {
    teamLeaderId: parsed.teamLeader,
    defaultProductDeliveryMode: parsed.defaultProductDeliveryMode,
    bots: configs,
  };
}

/** 兼容入口：只返回启用成员，供仍按旧签名读取的调用方使用。 */
export function parseBotConfigs(
  input: unknown,
  env: Environment,
  baseDirectory = process.cwd(),
): BotConfig[] {
  return parseAgentOsConfig(input, env, baseDirectory).bots;
}

/** 从 JSON 文件加载完整团队配置，并把配置错误补充为启动可读信息。 */
export async function loadAgentOsConfig(
  filePath: string,
  env: Environment = process.env,
  baseDirectory = process.cwd(),
): Promise<AgentOsConfig> {
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
    return parseAgentOsConfig(JSON.parse(content), env, baseDirectory);
  } catch (error) {
    throw new Error(`bot 配置文件格式错误: ${(error as Error).message}`);
  }
}

/** 兼容入口：只返回启用成员列表。 */
export async function loadBotConfigs(
  filePath: string,
  env: Environment = process.env,
  baseDirectory = process.cwd(),
): Promise<BotConfig[]> {
  return (await loadAgentOsConfig(filePath, env, baseDirectory)).bots;
}
