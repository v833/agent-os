/**
 * Antigravity CLI (agy) 适配器测试：
 * 验证 headless 参数构造、stream-json 事件翻译（真实 1.1.x 协议：
 * event 判别 + init/step_update/result 嵌套、state=ACTIVE/DONE 工具配对、
 * result.response 终态回答）、会话续接、compact 边界与失效会话识别。
 * 事件样例基于本机 agy 1.1.15 探针校准。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { AgyAdapter } from "./agy-adapter.js";
test("AgyAdapter 默认使用 headless，并构造首次/续聊参数", () => {
  const adapter = new AgyAdapter();

  assert.equal(adapter.command, "agy");
  assert.equal(adapter.accessMode, "headless");
  assert.equal(adapter.displayName, "Antigravity");
  assert.deepEqual(adapter.buildArgs("1加1等于几？"), [
    "--dangerously-skip-permissions",
    "-p",
    "1加1等于几？",
    "--output-format",
    "stream-json",
  ]);
  assert.deepEqual(adapter.buildResumeArgs("继续", "conv-abc"), [
    "--conversation",
    "conv-abc",
    "--dangerously-skip-permissions",
    "-p",
    "继续",
    "--output-format",
    "stream-json",
  ]);
});

test("AgyAdapter 解析 init 与 step_update（用户输入/检查点/文本增量）", () => {
  const adapter = new AgyAdapter();

  // init 事件顶层携带 conversation_id。
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        event: "init",
        conversation_id: "conv-abc",
        init: { cwd: "C:\\proj", tools: ["view_file", "run_command"], permission_mode: "always-proceed" },
      }),
    ),
    [{ type: "session", sessionId: "conv-abc" }],
  );
  // 非工具步骤不产事件（避免把中间过程当答案）。
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        event: "step_update",
        step_update: { conversation_id: "conv-abc", step_index: 0, state: "DONE", step_type: "user_input" },
      }),
    ),
    [],
  );
  // agent_response 步骤的 usage 贡献 context 事件。
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conv-abc",
          step_index: 2,
          state: "DONE",
          step_type: "agent_response",
          text_delta: "思考中",
          usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, cache_read_tokens: 10 },
        },
      }),
    ),
    [{ type: "context", usedTokens: 100 }],
  );
});

test("AgyAdapter 用 state=ACTIVE/DONE 配对工具调用", () => {
  const adapter = new AgyAdapter();
  const active = {
    event: "step_update",
    step_update: {
      conversation_id: "conv-abc",
      step_index: 3,
      state: "ACTIVE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: { name: "run_command", parameters: { CommandLine: "echo hello" } },
    },
  };
  const done = {
    event: "step_update",
    step_update: {
      ...active.step_update,
      state: "DONE",
      duration_seconds: 2.26,
      tool_info: { ...active.step_update.tool_info, output: "hello\r\n" },
    },
  };

  assert.deepEqual(adapter.parseEvents(JSON.stringify(active)), [
    {
      type: "tool_start",
      toolUseId: "step-3",
      toolName: "run_command",
      label: "执行终端命令",
    },
  ]);
  assert.deepEqual(adapter.parseEvents(JSON.stringify(done)), [
    { type: "tool_end", toolUseId: "step-3", failed: false },
  ]);
});

test("AgyAdapter 解析终态 result（response 为最终回答）", () => {
  const adapter = new AgyAdapter();

  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conv-abc",
          status: "SUCCESS",
          response: "命令 `echo hello` 的输出：hello\n",
          num_turns: 1,
          usage: { input_tokens: 120, output_tokens: 60, total_tokens: 180, cache_read_tokens: 10 },
        },
      }),
    ),
    [
      {
        type: "result",
        answer: "命令 `echo hello` 的输出：hello\n",
        sessionId: "conv-abc",
        stats: { inputTokens: 120, outputTokens: 60, totalTokens: 180, cacheReadTokens: 10 },
      },
    ],
  );
});

test("AgyAdapter 状态失败且无回答时发 error，显式 error 字段也发 error", () => {
  const adapter = new AgyAdapter();

  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({ event: "result", result: { conversation_id: "conv-x", status: "ERROR" } }),
    ),
    [
      { type: "error", message: "agy 执行未完成（ERROR）", sessionId: "conv-x" },
    ],
  );
  assert.deepEqual(
    adapter.parseEvents(JSON.stringify({ event: "error", error: "conversation not found" })),
    [{ type: "error", message: "conversation not found" }],
  );
  // 非法 JSON 静默忽略。
  assert.deepEqual(adapter.parseEvents("not-json"), []);
});

test("AgyAdapter 没有原生 compact 协议时明确拒绝 /compact", () => {
  const adapter = new AgyAdapter();

  assert.throws(
    () => adapter.buildCompactPlan("conv-abc", "精简"),
    /暂不支持原生 \/compact/,
  );
  assert.throws(() => adapter.buildCompactPlan("conv-abc"), /暂不支持原生 \/compact/);
});

test("AgyAdapter 识别会话失效错误（含 agy 对不存在会话的真实 stderr 文案）", () => {
  const adapter = new AgyAdapter();

  // agy 1.1.x 对不存在会话的实际输出（退出码仍为 0，必须能识别）。
  assert.equal(
    adapter.isSessionUnavailable('warning: conversation "nonexistent-conv-123" not found'),
    true,
  );
  assert.equal(adapter.isSessionUnavailable("conversation not found: x"), true);
  assert.equal(adapter.isSessionUnavailable("no active conversation"), true);
  assert.equal(adapter.isSessionUnavailable("invalid conversation id"), true);
  assert.equal(adapter.isSessionUnavailable("普通错误信息"), false);
});
