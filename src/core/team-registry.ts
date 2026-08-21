/**
 * 团队注册表：按 ID 查询长期成员、为当前成员生成团队上下文，
 * 并在启动时检查配置中的项目 Skill 是否能从工作区、内置或用户级目录解析。
 * 它不负责派发任务，协作机制仍由 collaboration 服务承担。
 */
import type { BotConfig } from "./bot-registry.js";
import {
  projectSkillPaths,
  resolveProjectSkill,
} from "./project-skills.js";

export interface MissingSkill {
  botId: string;
  skill: string;
  searchedPaths: string[];
}

export class TeamRegistry {
  private readonly configs = new Map<string, BotConfig>();

  constructor(
    readonly leaderBotId: string,
    configs: BotConfig[],
  ) {
    for (const config of configs) this.configs.set(config.id, config);
    if (!this.configs.has(leaderBotId)) {
      throw new Error(`Team Leader 不存在: ${leaderBotId}`);
    }
  }

  get leader(): BotConfig {
    return this.configs.get(this.leaderBotId)!;
  }

  get members(): BotConfig[] {
    return [...this.configs.values()];
  }

  get(botId: string): BotConfig | undefined {
    return this.configs.get(botId);
  }

  contextFor(currentBotId: string): string {
    const current = this.configs.get(currentBotId);
    if (!current) throw new Error(`团队成员不存在: ${currentBotId}`);
    const roster = this.members.map((member) => {
      const leader = member.id === this.leaderBotId ? "（Team Leader）" : "";
      const skills =
        member.skills.length > 0
          ? `；Skills：${member.skills.map((skill) => `$${skill}`).join("、")}`
          : "";
      return `- ${member.id}${leader}：${member.role}${skills}`;
    });
    return [
      "你所在的 Agent 团队：",
      ...roster,
      `你当前以 ${current.id} 的身份工作。只处理交给你的职责；需要其他成员参与时，清楚说明希望交给谁以及期望结果。`,
      "团队名单中的成员都是真实的飞书 bot。CLI 内部子 Agent 适合处理临时分工，不能冒充这些长期团队成员。",
    ].join("\n");
  }

  async findMissingSkills(): Promise<MissingSkill[]> {
    const missing: MissingSkill[] = [];
    for (const config of this.members) {
      for (const skill of config.skills) {
        const searchedPaths = projectSkillPaths(config.workspaceDir, skill);
        if (!(await resolveProjectSkill(config.workspaceDir, skill))) {
          missing.push({ botId: config.id, skill, searchedPaths });
        }
      }
    }
    return missing;
  }
}
