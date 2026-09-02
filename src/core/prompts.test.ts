/**
 * 提示词管理器核心领域模型测试：模板注册、插值、校验、分层覆盖与流水线组装。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  composePromptFragments,
  interpolatePrompt,
  parsePromptMarkdown,
  PromptRegistry,
} from "./prompts.js";
import { selectTaskSkills } from "./prompt-policies.js";

test("selectTaskSkills 按交互模式隔离 direct 与 team 的项目 Skill", () => {
  const skills = ["grill-me", "lark-doc"];

  assert.deepEqual(selectTaskSkills(skills, "direct", false), []);
  assert.deepEqual(selectTaskSkills(skills, "direct", true), ["lark-doc"]);
  assert.deepEqual(selectTaskSkills(skills, "team", false), skills);
  assert.deepEqual(
    selectTaskSkills(["grill-me", "lark-doc"], "team", true),
    ["grill-me", "lark-doc"],
  );
  assert.deepEqual(
    selectTaskSkills(["grill-me"], "team", true),
    ["grill-me", "lark-doc"],
  );
});

test("interpolatePrompt 基础变量与嵌套变量插值", () => {
  const template = "你好，{{name}}！欢迎使用 {{app.name}} v{{app.version}}。未定义字段：{{missing}}。";
  const result = interpolatePrompt(template, {
    name: "Alice",
    app: {
      name: "ThreadPilot",
      version: "1.0",
    },
  });
  assert.equal(result, "你好，Alice！欢迎使用 ThreadPilot v1.0。未定义字段：。");
});

test("parsePromptMarkdown 解析有无 Frontmatter 的 Markdown 模板", () => {
  const raw = `---
description: 测试提示词
version: 1.0
---
这是正文：{{task}}
第二行内容。`;

  const parsed = parsePromptMarkdown(raw);
  assert.equal(parsed.metadata.description, "测试提示词");
  assert.equal(parsed.metadata.version, "1.0");
  assert.equal(parsed.template, "这是正文：{{task}}\n第二行内容。");

  const plain = parsePromptMarkdown("纯正文提示词\n第二行");
  assert.deepEqual(plain.metadata, {});
  assert.equal(plain.template, "纯正文提示词\n第二行");
});

test("composePromptFragments 按 priority 排序并过滤空值", () => {
  const fragments = [
    { id: "task", content: "当前任务：写测试", priority: 100 },
    { id: "role", content: "你的角色：开发工程师", priority: 10 },
    { id: "empty", content: "   ", priority: 20 },
    { id: "disabled", content: "被禁用的策略", priority: 30, enabled: false },
    undefined,
    { id: "policy", content: "规则：遵守规范", priority: 50 },
  ];

  const result = composePromptFragments(fragments);
  assert.equal(
    result,
    "你的角色：开发工程师\n\n规则：遵守规范\n\n当前任务：写测试",
  );
});

test("PromptRegistry 模板定义与渲染", () => {
  const registry = new PromptRegistry();
  registry.define({
    id: "greet",
    template: "Hello, {{name}}!",
  });

  assert.equal(registry.render("greet", { name: "Bob" }), "Hello, Bob!");
  assert.throws(() => registry.render("non_existent"), /提示词模板不存在: non_existent/);
});

test("PromptRegistry 支持函数模板与 Schema 校验", () => {
  const registry = new PromptRegistry();
  registry.define({
    id: "calc",
    schema: z.object({
      a: z.number(),
      b: z.number(),
    }),
    template: (data) => `计算结果：${data.a + data.b}`,
  });

  assert.equal(registry.render("calc", { a: 10, b: 20 }), "计算结果：30");
  assert.throws(() => registry.render("calc", { a: "not_number" as any, b: 20 }), /expected number/i);
});

test("PromptRegistry 分层覆盖优先级、清理与回退", () => {
  const registry = new PromptRegistry();
  registry.define({
    id: "qa.review",
    template: "Layer 1: 内置策略：{{revision}}",
  });
  assert.equal(registry.getLayer("qa.review"), "builtin");
  assert.equal(
    registry.render("qa.review", { revision: "rev-1" }),
    "Layer 1: 内置策略：rev-1",
  );

  const globalOk = registry.setOverride(
    "qa.review",
    "Layer 2: 全局策略：{{revision}}",
    "global",
  );
  assert.equal(globalOk, true);
  assert.equal(registry.getLayer("qa.review"), "global");
  assert.equal(
    registry.render("qa.review", { revision: "rev-1" }),
    "Layer 2: 全局策略：rev-1",
  );

  const wsOk = registry.setOverride(
    "qa.review",
    "Layer 3: 工作区策略：{{revision}}",
    "workspace",
  );
  assert.equal(wsOk, true);
  assert.equal(registry.getLayer("qa.review"), "workspace");
  assert.equal(
    registry.render("qa.review", { revision: "rev-1" }),
    "Layer 3: 工作区策略：rev-1",
  );

  const lowerOk = registry.setOverride("qa.review", "尝试降级覆盖", "global");
  assert.equal(lowerOk, false);
  assert.equal(
    registry.render("qa.review", { revision: "rev-1" }),
    "Layer 3: 工作区策略：rev-1",
  );

  assert.equal(registry.removeOverride("qa.review"), true);
  assert.equal(registry.getLayer("qa.review"), "global");
  assert.equal(
    registry.render("qa.review", { revision: "rev-1" }),
    "Layer 2: 全局策略：rev-1",
  );

  registry.clearOverrides("global");
  assert.equal(registry.getLayer("qa.review"), "builtin");
  assert.equal(
    registry.render("qa.review", { revision: "rev-1" }),
    "Layer 1: 内置策略：rev-1",
  );
});
