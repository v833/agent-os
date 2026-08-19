/**
 * 澄清请求数据结构测试：Schema 边界校验与工具调用历史提取。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  ClarificationRequestSchema,
  findClarificationRequest,
} from "./clarification.js";

test("合法澄清请求通过校验并填充默认值", () => {
  const parsed = ClarificationRequestSchema.safeParse({
    questions: [
      {
        id: "entry",
        prompt: "从哪里进入用户详情？",
        recommendedOptionId: "name",
        options: [
          { id: "name", label: "点击列表姓名" },
          { id: "menu", label: "从操作菜单进入" },
        ],
      },
    ],
  });
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.title, "需求澄清");
    assert.equal(parsed.data.intro, "");
  }
});

test("拒绝重复的选项 ID 与不存在的推荐项", () => {
  const duplicateOption = ClarificationRequestSchema.safeParse({
    questions: [
      {
        id: "entry",
        prompt: "从哪里进入？",
        options: [
          { id: "name", label: "点击姓名" },
          { id: "name", label: "从菜单进入" },
        ],
      },
    ],
  });
  assert.equal(duplicateOption.success, false);

  const missingRecommended = ClarificationRequestSchema.safeParse({
    questions: [
      {
        id: "entry",
        prompt: "从哪里进入？",
        recommendedOptionId: "ghost",
        options: [
          { id: "name", label: "点击姓名" },
          { id: "menu", label: "从菜单进入" },
        ],
      },
    ],
  });
  assert.equal(missingRecommended.success, false);
});

test("拒绝重复的问题 ID 与越界的问题/选项数量", () => {
  const option = (id: string) => ({ id, label: `选项 ${id}` });
  const question = (id: string) => ({
    id,
    prompt: `问题 ${id}?`,
    options: [option("1"), option("2")],
  });

  const duplicateQuestion = ClarificationRequestSchema.safeParse({
    questions: [question("a"), question("a")],
  });
  assert.equal(duplicateQuestion.success, false);

  const tooManyQuestions = ClarificationRequestSchema.safeParse({
    questions: Array.from({ length: 6 }, (_, index) =>
      question(`q${index}`),
    ),
  });
  assert.equal(tooManyQuestions.success, false);

  const tooFewOptions = ClarificationRequestSchema.safeParse({
    questions: [{ ...question("a"), options: [option("1")] }],
  });
  assert.equal(tooFewOptions.success, false);
});

test("findClarificationRequest 提取最近一次合法澄清请求", () => {
  const valid = {
    title: "确认范围",
    questions: [
      {
        id: "entry",
        prompt: "从哪里进入？",
        options: [
          { id: "name", label: "点击姓名" },
          { id: "menu", label: "从菜单进入" },
        ],
      },
    ],
  };
  const calls = [
    { toolName: "Bash", input: { command: "ls" } },
    { toolName: "request_clarification", input: valid },
  ];
  assert.equal(findClarificationRequest(calls)?.title, "确认范围");

  // 跳过其他工具与未通过校验的调用，只认最近一次合法请求。
  const broken = { title: "", questions: [] };
  const mixed = [
    { toolName: "request_clarification", input: broken },
    { toolName: "request_clarification", input: valid },
  ];
  assert.equal(findClarificationRequest(mixed)?.questions.length, 1);

  assert.equal(findClarificationRequest(undefined), undefined);
  assert.equal(
    findClarificationRequest([{ toolName: "Bash", input: {} }]),
    undefined,
  );
});
