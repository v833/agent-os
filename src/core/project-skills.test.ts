/**
 * 项目 Skill 解析测试：验证工作区覆盖、内置回退与真实缺失边界。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  builtInSkillsDirectory,
  projectSkillPaths,
  resolveProjectSkill,
} from "./project-skills.js";

test("工作区 .agents Skill 优先于 .claude 与 ThreadPilot 内置版本", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "threadpilot-skills-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const agentsSkill = join(
    directory,
    ".agents",
    "skills",
    "grill-me",
    "SKILL.md",
  );
  const claudeSkill = join(
    directory,
    ".claude",
    "skills",
    "grill-me",
    "SKILL.md",
  );
  await mkdir(join(agentsSkill, ".."), { recursive: true });
  await mkdir(join(claudeSkill, ".."), { recursive: true });
  await writeFile(agentsSkill, "# workspace agents\n", "utf8");
  await writeFile(claudeSkill, "# workspace claude\n", "utf8");

  const resolved = await resolveProjectSkill(directory, "grill-me");
  assert.equal(resolved?.path, agentsSkill);
  assert.equal(resolved?.source, "workspace");
  assert.equal(resolved?.content, "# workspace agents\n");
});

test("工作区没有同名 Skill 时回退到 ThreadPilot 内置版本", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "threadpilot-skills-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const resolved = await resolveProjectSkill(directory, "to-spec");
  assert.equal(
    resolved?.path,
    join(builtInSkillsDirectory, "to-spec", "SKILL.md"),
  );
  assert.equal(resolved?.source, "built-in");
  assert.match(resolved?.content ?? "", /name: to-spec/);
});

test("工作区和内置目录都不存在时返回完整查找路径", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "threadpilot-skills-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const missingSkill = `missing-${basename(directory)}`;

  assert.equal(await resolveProjectSkill(directory, missingSkill), undefined);
  assert.deepEqual(projectSkillPaths(directory, missingSkill), [
    join(directory, ".agents", "skills", missingSkill, "SKILL.md"),
    join(directory, ".claude", "skills", missingSkill, "SKILL.md"),
    join(builtInSkillsDirectory, missingSkill, "SKILL.md"),
    join(homedir(), ".agents", "skills", missingSkill, "SKILL.md"),
    join(homedir(), ".claude", "skills", missingSkill, "SKILL.md"),
    join(homedir(), ".codex", "skills", missingSkill, "SKILL.md"),
  ]);
});
