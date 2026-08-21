/**
 * 项目 Skill 解析器：按工作区覆盖、Agent OS 内置、用户级的顺序查找 Skill，
 * 供启动诊断与任务提示词共用，避免两条路径对“已安装”的判断不一致。
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const agentOsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Agent OS 随仓库分发的内置 Skill 根目录。 */
export const builtInSkillsDirectory = join(agentOsRoot, ".agents", "skills");

export interface ResolvedProjectSkill {
  name: string;
  path: string;
  source: "workspace" | "built-in" | "user";
  content: string;
}

/** 返回 Skill 的完整查找路径，顺序同时定义覆盖优先级。 */
export function projectSkillPaths(
  workspaceDir: string,
  skill: string,
): string[] {
  return [
    join(workspaceDir, ".agents", "skills", skill, "SKILL.md"),
    join(workspaceDir, ".claude", "skills", skill, "SKILL.md"),
    join(builtInSkillsDirectory, skill, "SKILL.md"),
    join(homedir(), ".agents", "skills", skill, "SKILL.md"),
    join(homedir(), ".claude", "skills", skill, "SKILL.md"),
    join(homedir(), ".codex", "skills", skill, "SKILL.md"),
  ];
}

/**
 * 读取优先级最高的 Skill。只有路径不存在时才继续回退；权限或 I/O 错误
 * 必须向上抛出，防止静默加载较低优先级的过期版本。
 */
export async function resolveProjectSkill(
  workspaceDir: string,
  skill: string,
): Promise<ResolvedProjectSkill | undefined> {
  const paths = projectSkillPaths(workspaceDir, skill);
  for (const [index, path] of paths.entries()) {
    try {
      return {
        name: skill,
        path,
        source: index < 2 ? "workspace" : index === 2 ? "built-in" : "user",
        content: await readFile(path, "utf8"),
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
  }
  return undefined;
}
