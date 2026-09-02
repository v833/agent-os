/**
 * 提示词管理服务插件测试：
 * 验证插件生命周期挂载、内置模板、
 * 目录扫描覆盖与任务级提示词流水线组装。
 */
import assert from "node:assert/strict";
import { Context } from "cordis";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as promptsPlugin from "./prompts.js";
import type { BotConfig } from "../core/bot-registry.js";
import { createInteractionPolicy } from "../core/interaction-policy.js";

function testBotConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id: "dev-bot",
    appId: "cli_app_id",
    appSecret: "app_secret",
    defaultCliId: "claude",
    accessMode: "headless",
    role: "资深全栈工程师",
    systemPrompt: "遵循最佳工程实践",
    skills: [],
    workspaceDir: process.cwd(),
    collaborationMaxRounds: 3,
    ...overrides,
  };
}

test("prompts 插件在 Cordis 中正常挂载并提供内置模板", async () => {
  const ctx = new Context();
  await ctx.plugin(promptsPlugin);

  assert.ok(ctx.prompts);
  const directRole = ctx.prompts.render("role.direct-chat");
  assert.match(directRole, /你是用户的直接执行助手/);

  const feishuPolicy = ctx.prompts.render("policy.feishu-output", {
    direct: false,
    documentRequested: false,
  });
  assert.match(feishuPolicy, /飞书输出规则/);
  assert.match(feishuPolicy, /1200 个中文字符以内/);

  const qaReview = ctx.prompts.render("qa.review", {
    revision: "rev-123",
    originalPrompt: "修复登录 bug",
  });
  assert.match(qaReview, /固定审查 revision：rev-123/);
  assert.match(qaReview, /原始任务：修复登录 bug/);
});

test("内置字符串模板与仓库默认 Markdown 模板保持一致", async () => {
  const dir = await mkdtemp(join(tmpdir(), "prompts-consistency-"));
  try {
    const emptyGlobalDir = join(dir, "empty-global");
    const emptyWorkspaceDir = join(dir, "empty-workspace");
    await mkdir(emptyGlobalDir, { recursive: true });
    await mkdir(emptyWorkspaceDir, { recursive: true });

    const builtinCtx = new Context();
    await builtinCtx.plugin(promptsPlugin, {
      promptsDir: emptyGlobalDir,
      workspaceOverrideDir: emptyWorkspaceDir,
    });

    const fileCtx = new Context();
    await fileCtx.plugin(promptsPlugin, {
      promptsDir: join(process.cwd(), "prompts"),
      workspaceOverrideDir: emptyWorkspaceDir,
    });

    const cases = [
      ["role.direct-chat", {}],
      ["policy.doc-request", {}],
      ["product.spec-correction", {}],
      ["qa.review", { revision: "rev-1", originalPrompt: "修复登录问题" }],
    ] as const;
    for (const [id, data] of cases) {
      assert.equal(
        fileCtx.prompts.render(id, data),
        builtinCtx.prompts.render(id, data),
        `${id} 的 Markdown 默认模板必须与内置模板一致`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("prompts 插件从目录扫描加载 .md 文件覆盖", async () => {
  const dir = await mkdtemp(join(tmpdir(), "prompts-test-"));
  try {
    const qaDir = join(dir, "qa");
    await mkdir(qaDir, { recursive: true });
    await writeFile(
      join(qaDir, "review.md"),
      `---
description: 自定义审查
---
工作区特定 QA 审查规则：{{revision}}
原始任务：{{originalPrompt}}`,
      "utf-8",
    );

    const ctx = new Context();
    await ctx.plugin(promptsPlugin, { promptsDir: dir });

    const rendered = ctx.prompts.render("qa.review", {
      revision: "rev-abc",
      originalPrompt: "重构网络层",
    });
    assert.equal(
      rendered,
      "工作区特定 QA 审查规则：rev-abc\n原始任务：重构网络层",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("composeTaskPrompt 任务流水线支持插件事件扩展与排序", async () => {
  const ctx = new Context();
  await ctx.plugin(promptsPlugin);

  let receivedMode: string | undefined;
  // 注册一个模拟策略插件，通过 task/prompt-compose 注入片段
  ctx.on("task/prompt-compose", (collector, _botConfig, _taskPrompt, options) => {
    receivedMode = options.defaultProductDeliveryMode;
    collector.add(
      {
        id: "security-policy",
        priority: 50,
        content: "安全规则：严禁提交硬编码密钥。",
      },
      {
        id: "git-policy",
        priority: 45,
        content: "Git 规则：提交信息符合 Conventional Commits。",
      },
    );
  });

  const bot = testBotConfig({ id: "developer", role: "开发助手" });
  const result = await ctx.prompts.composeTaskPrompt(bot, "实现用户注销接口", {
    interaction: createInteractionPolicy("team"),
    defaultProductDeliveryMode: "lark-doc",
  });

  assert.match(result, /^你的角色：开发助手/);
  assert.match(result, /Git 规则：提交信息符合 Conventional Commits/);
  assert.match(result, /安全规则：严禁提交硬编码密钥/);
  assert.match(result, /当前任务：实现用户注销接口$/);

  // 校验 priority 顺序：45 (git) 在 50 (security) 之前
  const gitIndex = result.indexOf("Git 规则");
  const securityIndex = result.indexOf("安全规则");
  assert.ok(gitIndex < securityIndex, "Git 策略应在安全策略之前");
  assert.equal(receivedMode, "lark-doc");
});

test("禁用或空的保留 ID 片段不会抑制默认提示词", async () => {
  const ctx = new Context();
  await ctx.plugin(promptsPlugin);

  ctx.on("task/prompt-compose", (collector) => {
    collector.add(
      { id: "current-task", content: "", enabled: false },
      { id: "feishu-output-policy", content: "   " },
    );
  });

  const result = await ctx.prompts.composeTaskPrompt(
    testBotConfig(),
    "执行任务",
    { interaction: createInteractionPolicy("direct") },
  );
  assert.match(result, /当前任务：执行任务/);
  assert.match(result, /飞书输出规则（必须遵守）：/);
});

test("提示词扩展失败时阻止任务提示词继续组装", async () => {
  const ctx = new Context();
  await ctx.plugin(promptsPlugin);
  ctx.on("task/prompt-compose", () => {
    throw new Error("策略加载失败");
  });

  await assert.rejects(
    ctx.prompts.composeTaskPrompt(testBotConfig(), "执行任务"),
    /策略加载失败/,
  );
});

test("composeTaskPrompt 私聊直达模式下的行为", async () => {
  const ctx = new Context();
  await ctx.plugin(promptsPlugin);

  const bot = testBotConfig();
  const result = await ctx.prompts.composeTaskPrompt(bot, "查询系统状态", {
    interaction: createInteractionPolicy("direct"),
  });

  assert.match(result, /^你是用户的直接执行助手/);
  assert.doesNotMatch(result, /你的角色：资深全栈工程师/);
  assert.match(result, /飞书输出规则（必须遵守）：/);
  assert.match(result, /未通过 \/doc 显式请求时，不要创建、编辑或上传飞书云文档/);
  assert.doesNotMatch(result, /lark-cli 身份规则/);
  assert.match(result, /当前任务：查询系统状态$/);
});

test("composeTaskPrompt 完整注入 4 个核心策略片段（飞书输出、lark 身份、产品方案交付、/doc 规则）", async () => {
  const ctx = new Context();
  await ctx.plugin(promptsPlugin);

  const productBot = testBotConfig({
    id: "product-manager",
    role: "产品经理",
    skills: ["to-spec", "lark-doc"],
  });

  // 1. 团队模式下：应包含 feishu-output、lark-identity、product-delivery
  const teamResult = await ctx.prompts.composeTaskPrompt(productBot, "设计新功能方案", {
    interaction: createInteractionPolicy("team"),
    defaultProductDeliveryMode: "lark-doc",
  });

  assert.match(teamResult, /飞书输出规则（必须遵守）：/);
  assert.match(teamResult, /lark-cli 身份规则（必须遵守）：/);
  assert.match(teamResult, /本 bot 的 lark-cli profile 为 `product-manager`/);
  assert.match(teamResult, /产品方案交付规则（必须遵守）：/);
  assert.match(teamResult, /当前默认交付方式：lark-doc。/);
  assert.match(teamResult, /必须实际调用 request_spec_approval/);
  assert.doesNotMatch(teamResult, /用户通过 \/doc 显式请求文档交付/);

  // 2. /doc 显式文档请求模式下：应包含 doc-request 与 lark-identity，不包含 product-delivery
  const docResult = await ctx.prompts.composeTaskPrompt(productBot, "生成分析报告", {
    interaction: createInteractionPolicy("team", true),
  });

  assert.match(docResult, /用户通过 \/doc 显式请求文档交付：/);
  assert.match(docResult, /lark-cli 身份规则（必须遵守）：/);
  assert.match(docResult, /飞书输出规则（必须遵守）：/);
  assert.doesNotMatch(docResult, /产品方案交付规则/);
});

test("prompts 插件支持 Layer 2 全局目录与 Layer 3 工作区目录分层覆盖（工作区优先）", async () => {
  const globalDir = await mkdtemp(join(tmpdir(), "prompts-global-"));
  const wsDir = await mkdtemp(join(tmpdir(), "prompts-ws-"));
  try {
    // 全局目录写入 qa/review.md 与 policy/doc-request.md
    await mkdir(join(globalDir, "qa"), { recursive: true });
    await mkdir(join(globalDir, "policy"), { recursive: true });
    await writeFile(
      join(globalDir, "qa", "review.md"),
      "全局 QA 模板：{{revision}}",
      "utf-8",
    );
    await writeFile(
      join(globalDir, "policy", "doc-request.md"),
      "全局 Doc 策略模板",
      "utf-8",
    );

    // 工作区目录重写 qa/review.md（覆盖全局），但不重写 doc-request
    await mkdir(join(wsDir, "qa"), { recursive: true });
    await writeFile(
      join(wsDir, "qa", "review.md"),
      "工作区特化 QA 模板：{{revision}}",
      "utf-8",
    );

    const ctx = new Context();
    await ctx.plugin(promptsPlugin, {
      promptsDir: globalDir,
      workspaceOverrideDir: wsDir,
    });

    // qa.review 应该被工作区层覆盖
    const qaRendered = ctx.prompts.render("qa.review", { revision: "v2" });
    assert.equal(qaRendered, "工作区特化 QA 模板：v2");
    assert.equal(ctx.prompts.getLayer("qa.review"), "workspace");

    // policy.doc-request 应该生效全局层
    const docRendered = ctx.prompts.render("policy.doc-request");
    assert.equal(docRendered, "全局 Doc 策略模板");
    assert.equal(ctx.prompts.getLayer("policy.doc-request"), "global");
  } finally {
    await rm(globalDir, { recursive: true, force: true });
    await rm(wsDir, { recursive: true, force: true });
  }
});

test("composeTaskPrompt 加载工作区优先的 Project Skill 片段", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "prompts-skill-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const skillDirectory = join(directory, ".agents", "skills", "grill-me");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: grill-me\n---\n\n# Workspace Grill\n",
    "utf8",
  );

  const ctx = new Context();
  await ctx.plugin(promptsPlugin);

  const bot = testBotConfig({
    id: "developer",
    role: "开发助手",
    skills: ["grill-me"],
    workspaceDir: directory,
  });
  const result = await ctx.prompts.composeTaskPrompt(bot, "澄清这个需求", {
    interaction: createInteractionPolicy("team"),
  });

  assert.match(result, /<project-skill name="grill-me" source="workspace">/);
  assert.match(result, /# Workspace Grill/);
  assert.match(result, /当前任务：澄清这个需求$/);
});
