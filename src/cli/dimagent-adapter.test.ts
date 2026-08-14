/**
 * DimAgent 适配器测试：验证 headless 参数构造、会话续接、
 * JSONL 事件翻译和不支持原生 compact 的边界。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DimagentAdapter } from "./dimagent-adapter.js";

test("DimAgent 默认使用 headless，并把提示词作为独立参数", () => {
  const adapter = new DimagentAdapter();
  const prompt = '检查 "package.json"\n$(Remove-Item important.txt)';

  assert.equal(adapter.command, "dim");
  assert.equal(adapter.accessMode, "headless");
  assert.deepEqual(adapter.buildArgs(prompt), [
    "exec",
    "--json",
    "--policy",
    "full-access",
    prompt,
  ]);
  assert.deepEqual(adapter.buildResumeArgs("继续", "dim-session"), [
    "exec",
    "resume",
    "--json",
    "dim-session",
    "继续",
  ]);
});

test("DimAgent headless 解析会话、工具、回答和用量", () => {
  const adapter = new DimagentAdapter();

  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({ type: "session_started", session_id: "dim-session" }),
    ),
    [{ type: "session", sessionId: "dim-session" }],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "tool_start",
        toolUseId: "tool-1",
        toolName: "Read",
        label: "读取文件",
        detail: "src/index.ts",
      }),
    ),
    [
      {
        type: "tool_start",
        toolUseId: "tool-1",
        toolName: "Read",
        label: "读取文件",
        detail: "src/index.ts",
      },
    ],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "result",
        answer: "检查完成",
        usage: { input_tokens: 20, output_tokens: 5 },
      }),
    ),
    [
      {
        type: "result",
        answer: "检查完成",
        stats: { totalTokens: 25, inputTokens: 20, outputTokens: 5 },
      },
    ],
  );
});

test("DimAgent 明确拒绝原生 compact 并识别失效会话", () => {
  const adapter = new DimagentAdapter();

  assert.throws(() => adapter.buildCompactPlan("dim-session"), /暂不支持/);
  assert.equal(
    adapter.isSessionUnavailable("session does not exist: dim-session"),
    true,
  );
});
