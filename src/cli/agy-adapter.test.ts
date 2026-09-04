/**
 * Antigravity CLI (agy) 适配器测试：
 * 验证 headless 参数构造、stream-json 事件翻译（真实 1.1.x 协议：
 * event 判别 + init/step_update/result 嵌套、state=ACTIVE/DONE 工具配对、
 * result.response 终态回答）、会话续接、compact 边界与失效会话识别。
 * 事件样例基于本机 agy 1.1.16 探针校准。
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
    "--print-timeout",
    "30m",
    "--dangerously-skip-permissions",
    "-p",
    "1加1等于几？",
    "--output-format",
    "stream-json",
  ]);
  assert.deepEqual(adapter.buildResumeArgs("继续", "conv-abc"), [
    "--conversation",
    "conv-abc",
    "--print-timeout",
    "30m",
    "--dangerously-skip-permissions",
    "-p",
    "继续",
    "--output-format",
    "stream-json",
  ]);

  const customAdapter = new AgyAdapter(() => [], "45m");
  assert.deepEqual(customAdapter.buildArgs("你好"), [
    "--print-timeout",
    "45m",
    "--dangerously-skip-permissions",
    "-p",
    "你好",
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

test("AgyAdapter 识别工作区 MCP 的应用工具调用", () => {
  const adapter = new AgyAdapter(() => [
    {
      id: "threadpilot_clarification",
      command: process.execPath,
      args: ["server.js"],
      tools: ["request_clarification"],
    },
  ]);

  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conv-abc",
          step_index: 4,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "mcp__threadpilot_clarification__request_clarification",
          tool_info: {
            parameters: {
              title: "需求澄清",
              questions: [],
            },
          },
        },
      }),
    ),
    [
      {
        type: "tool_start",
        toolUseId: "step-4",
        toolName: "mcp__threadpilot_clarification__request_clarification",
        label: "调用 mcp__threadpilot_clarification__request_clarification",
      },
      {
        type: "tool_call",
        toolUseId: "step-4",
        toolName: "request_clarification",
        input: { title: "需求澄清", questions: [] },
      },
    ],
  );
});

test("AgyAdapter 兼容 tool_name 与 tool_info.name 分开提供 MCP 工具名", () => {
  const adapter = new AgyAdapter(() => [
    {
      id: "threadpilot_clarification",
      command: process.execPath,
      args: ["server.js"],
      tools: ["request_clarification"],
    },
  ]);
  const events = adapter.parseEvents(
    JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 5,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "MCP",
        tool_info: {
          name: "threadpilot_clarification/request_clarification",
          parameters: { title: "澄清" },
        },
      },
    }),
  );
  assert.equal(
    events.find((event) => event.type === "tool_call")?.toolName,
    "request_clarification",
  );
});

test("AgyAdapter 解析 call_mcp_tool 惰性转发的工具调用并提取内层参数", () => {
  const adapter = new AgyAdapter(() => [
    {
      id: "threadpilot_dispatch_task",
      command: process.execPath,
      args: ["server.js"],
      tools: ["dispatch_task"],
    },
  ]);
  const events = adapter.parseEvents(
    JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 6,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "call_mcp_tool",
        tool_info: {
          name: "call_mcp_tool",
          parameters: {
            ServerName: "threadpilot_dispatch_task",
            ToolName: "dispatch_task",
            Arguments: JSON.stringify({
              targetBotId: "product",
              objective: "编写规范",
              instruction: "请细化需求",
            }),
          },
        },
      },
    }),
  );
  assert.deepEqual(events, [
    {
      type: "tool_start",
      toolUseId: "step-6",
      toolName: "call_mcp_tool",
      label: "调用 call_mcp_tool",
    },
    {
      type: "tool_call",
      toolUseId: "step-6",
      toolName: "dispatch_task",
      input: {
        targetBotId: "product",
        objective: "编写规范",
        instruction: "请细化需求",
      },
    },
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
        complete: true,
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
  // 提取 agy 超时真实错误（result 内嵌 error 与 status=ERROR）
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conv-timeout",
          status: "ERROR",
          response: "",
          error: "timeout waiting for response",
        },
      }),
    ),
    [
      {
        type: "error",
        message: "timeout waiting for response",
        sessionId: "conv-timeout",
      },
    ],
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

test("AgyAdapter 识别认证需求错误（未登录时的真实 stderr 与 result 文案）", () => {
  const adapter = new AgyAdapter();

  // agy 未认证时真实输出的关键片段。
  assert.equal(
    adapter.isAuthRequired(
      "Authentication required. Please visit the URL to log in:\n  https://accounts.google.com/o/oauth2/auth?...",
    ),
    true,
  );
  assert.equal(
    adapter.isAuthRequired(
      "Or, paste the authorization code here and press Enter:\nError: authentication timed out.",
    ),
    true,
  );
  assert.equal(adapter.isAuthRequired("authentication failed or timed out"), true);
  assert.equal(adapter.isAuthRequired("authentication required"), true);
  // 与登录无关的错误不能误判。
  assert.equal(adapter.isAuthRequired("conversation not found: x"), false);
  assert.equal(adapter.isAuthRequired("普通编译错误"), false);
});
