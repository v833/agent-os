/**
 * TeamRegistry 测试：成员查询、团队上下文生成与项目 Skill 存在性检查。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BotConfig } from "./bot-registry.js";
import { builtInSkillsDirectory } from "./project-skills.js";
import { TeamRegistry } from "./team-registry.js";

function member(
  id: string,
  overrides: Partial<BotConfig> = {},
): BotConfig {
  return {
    id,
    appId: `cli_${id}`,
    appSecret: "secret",
    defaultCliId: "claude",
    accessMode: "headless",
    role: `${id} 的职责`,
    skills: [],
    systemPrompt: "",
    workspaceDir: process.cwd(),
    collaborationMaxRounds: 16,
    ...overrides,
  };
}

const team = [
  member("ceo-assistant", { role: "CEO 助理，负责理解目标、组织成员并汇总团队结论" }),
  member("product", { role: "产品经理，负责澄清需求", skills: ["grill-me"] }),
  member("developer", { role: "开发工程师，负责完成实现" }),
];

test("构造时校验 Team Leader 必须是成员之一", () => {
  assert.throws(
    () => new TeamRegistry("missing", team),
    /Team Leader 不存在: missing/,
  );
});

test("按 ID 查询成员并返回 leader 与完整名单", () => {
  const registry = new TeamRegistry("ceo-assistant", team);
  assert.equal(registry.leader.id, "ceo-assistant");
  assert.equal(registry.get("product")?.role, "产品经理，负责澄清需求");
  assert.equal(registry.get("nobody"), undefined);
  assert.deepEqual(
    registry.members.map((member) => member.id),
    ["ceo-assistant", "product", "developer"],
  );
});

test("contextFor 生成成员名单、Skill 提示与当前身份约束", () => {
  const registry = new TeamRegistry("ceo-assistant", team);
  const context = registry.contextFor("product");
  assert.match(context, /ceo-assistant（Team Leader）：CEO 助理/);
  assert.match(context, /product：产品经理，负责澄清需求；Skills：\$grill-me/);
  assert.match(context, /developer：开发工程师/);
  assert.match(context, /你当前以 product 的身份工作/);
  assert.match(context, /不能冒充这些长期团队成员/);
  assert.throws(() => registry.contextFor("outsider"), /团队成员不存在: outsider/);
});

test("findMissingSkills 仅报告工作区和内置目录都缺失的项目 Skill", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-os-team-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  // product 的 grill-me 已安装，developer 的 review-me 缺失。
  const skillsDir = join(directory, ".agents", "skills", "grill-me");
  await mkdir(skillsDir, { recursive: true });
  await writeFile(join(skillsDir, "SKILL.md"), "# grill-me\n", "utf8");

  const localTeam = [
    member("product", {
      workspaceDir: directory,
      skills: ["grill-me"],
    }),
    member("developer", {
      workspaceDir: directory,
      skills: ["review-me"],
    }),
  ];
  const registry = new TeamRegistry("product", localTeam);
  const missing = await registry.findMissingSkills();
  assert.equal(missing.length, 1);
  assert.equal(missing[0]?.botId, "developer");
  assert.equal(missing[0]?.skill, "review-me");
  assert.deepEqual(missing[0]?.searchedPaths, [
    join(directory, ".agents", "skills", "review-me", "SKILL.md"),
    join(directory, ".claude", "skills", "review-me", "SKILL.md"),
    join(builtInSkillsDirectory, "review-me", "SKILL.md"),
  ]);
});

test("product workspace 在仓库外时使用三项 Agent OS 内置 Skill", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-os-product-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new TeamRegistry("product", [
    member("product", {
      workspaceDir: directory,
      skills: ["grill-me", "to-spec", "to-tickets"],
    }),
  ]);

  assert.deepEqual(await registry.findMissingSkills(), []);
});
