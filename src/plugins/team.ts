/**
 * team 服务插件：把 TeamRegistry、团队上下文和 Skill 诊断独立挂到 ctx.team。
 * 团队能力通过 cordis.yml 装配；tasks 只消费类型化提示词 provider，不依赖本插件的具体实现。
 */
import { Service, type Context } from "cordis";
import { TeamRegistry, type MissingSkill } from "../core/team-registry.js";
import type { BotConfig } from "../core/bot-registry.js";

/** 团队注册表的插件服务出口，命令和其他扩展只依赖此契约。 */
export class TeamService extends Service {
  readonly registry: TeamRegistry;

  constructor(ctx: Context, registry: TeamRegistry) {
    super(ctx, "team");
    this.registry = registry;
  }

  get leaderBotId(): string {
    return this.registry.leaderBotId;
  }

  get leader(): BotConfig {
    return this.registry.leader;
  }

  get members(): BotConfig[] {
    return this.registry.members;
  }

  get(botId: string): BotConfig | undefined {
    return this.registry.get(botId);
  }

  contextFor(botId: string): string {
    return this.registry.contextFor(botId);
  }

  findMissingSkills(): Promise<MissingSkill[]> {
    return this.registry.findMissingSkills();
  }
}

export const name = "team";
export const inject = ["config"];

export async function apply(ctx: Context): Promise<void> {
  const service = new TeamService(
    ctx,
    new TeamRegistry(ctx.config.teamLeaderId, ctx.config.bots),
  );

  // Skill 缺失只打印明确警告，不阻止其他成员上线；诊断归团队插件所有。
  for (const missing of await service.findMissingSkills()) {
    console.warn(
      `[Skill] bot=${missing.botId} 找不到 $${missing.skill}，请安装到当前工作目录的 .agents/skills、.claude/skills、Agent OS 内置目录，或用户级 ~/.agents/skills、~/.claude/skills、~/.codex/skills`,
    );
  }

  // tasks 没有硬依赖 team：插件存在时作为 provider 返回上下文，不存在时返回 undefined。
  // 不在团队名册中的 bot 同样降级为 undefined，避免 contextFor 抛错打断任务启动。
  // 用户私聊指挥单个成员（isDirect）时不再注入团队上下文——私聊是直接下达指令，
  // 成员按“直接干活的执行者”而不是“团队协作角色”工作。
  ctx.on("task/prompt-context", (botConfig, { isDirect }) => {
    if (isDirect) return undefined;
    const current = service.get(botConfig.id);
    return current ? service.contextFor(current.id) : undefined;
  });
}
