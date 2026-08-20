/**
 * DimAgent 适配器测试：验证 headless 参数构造、dim 0.3.x JSONL 事件翻译
 * （text:delta 跨行累积、run:ended 收尾、工具与上下文事件）、
 * 会话续接和不支持原生 compact 的边界。
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

test("DimAgent 解析会话、流式答案累积与用量统计", () => {
  const adapter = new DimagentAdapter();
  const sid = "sess_abc";

  // 首事件发出会话；text:delta 跨行累积；run:ended 收尾并带统计。
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({ eventType: "run:accepted", sessionId: sid, payload: {} }),
    ),
    [{ type: "session", sessionId: sid }],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({ eventType: "text:delta", sessionId: sid, payload: { delta: "检查完成" } }),
    ),
    [],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({ eventType: "text:delta", sessionId: sid, payload: { delta: "，共 3 项" } }),
    ),
    [],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        eventType: "run:ended",
        sessionId: sid,
        payload: {
          status: "completed",
          reason: "end_turn",
          usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
        },
      }),
    ),
    [
      {
        type: "result",
        answer: "检查完成，共 3 项",
        sessionId: sid,
        stats: { totalTokens: 25, inputTokens: 20, outputTokens: 5 },
      },
    ],
  );
});

test("DimAgent 翻译工具调用与上下文事件", () => {
  const adapter = new DimagentAdapter();
  const sid = "sess_tool";

  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({ eventType: "run:accepted", sessionId: sid, payload: {} }),
    ),
    [{ type: "session", sessionId: sid }],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        eventType: "tool:started",
        sessionId: sid,
        payload: {
          toolCallId: "call-1",
          toolName: "exec",
          toolInput: { command: "gh issue list" },
        },
      }),
    ),
    [
      {
        type: "tool_start",
        toolUseId: "call-1",
        toolName: "exec",
        label: "运行命令",
        detail: "gh issue list",
      },
    ],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({ eventType: "context:usage", sessionId: sid, payload: { usedTokens: 123 } }),
    ),
    [{ type: "context", usedTokens: 123 }],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        eventType: "tool:completed",
        sessionId: sid,
        payload: {
          toolCallId: "call-1",
          toolName: "exec",
          toolResult: { content: "ok", isError: false },
        },
      }),
    ),
    [{ type: "tool_end", toolUseId: "call-1", failed: false }],
  );
});

test("DimAgent 识别已注册 MCP 工具并翻译为统一 tool_call", () => {
  const adapter = new DimagentAdapter(() => [
    {
      id: "agent_os_clarification",
      command: process.execPath,
      args: ["server.js"],
      tools: ["request_clarification"],
    },
  ]);
  const sid = "sess_mcp";

  adapter.parseEvents(
    JSON.stringify({ eventType: "run:accepted", sessionId: sid, payload: {} }),
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        eventType: "tool:started",
        sessionId: sid,
        payload: {
          toolCallId: "call-mcp",
          toolName: "agent_os_clarification__request_clarification",
          toolInput: { questions: [] },
        },
      }),
    ),
    [
      {
        type: "tool_start",
        toolUseId: "call-mcp",
        toolName: "agent_os_clarification__request_clarification",
        label: "调用 agent_os_clarification__request_clarification",
        detail: JSON.stringify({ questions: [] }),
      },
      {
        type: "tool_call",
        toolUseId: "call-mcp",
        toolName: "request_clarification",
        input: { questions: [] },
      },
    ],
  );
});

test("DimAgent 失败收尾发出 error 而非 result", () => {
  const adapter = new DimagentAdapter();
  const sid = "sess_fail";

  adapter.parseEvents(
    JSON.stringify({ eventType: "run:accepted", sessionId: sid, payload: {} }),
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        eventType: "run:ended",
        sessionId: sid,
        payload: { status: "failed", reason: "error" },
      }),
    ),
    [
      {
        type: "error",
        message: "DimAgent 执行未完成（failed）",
        sessionId: sid,
      },
    ],
  );
  // 状态已清理：再次 run:ended 不应再产出 result。
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        eventType: "run:ended",
        sessionId: sid,
        payload: { status: "completed", reason: "end_turn" },
      }),
    ),
    [],
  );
});

test("DimAgent 不同会话的状态互不串扰", () => {
  const adapter = new DimagentAdapter();

  adapter.parseEvents(
    JSON.stringify({ eventType: "run:accepted", sessionId: "sess_a", payload: {} }),
  );
  adapter.parseEvents(
    JSON.stringify({ eventType: "text:delta", sessionId: "sess_a", payload: { delta: "甲" } }),
  );
  adapter.parseEvents(
    JSON.stringify({ eventType: "run:accepted", sessionId: "sess_b", payload: {} }),
  );
  adapter.parseEvents(
    JSON.stringify({ eventType: "text:delta", sessionId: "sess_b", payload: { delta: "乙" } }),
  );

  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        eventType: "run:ended",
        sessionId: "sess_a",
        payload: { status: "completed" },
      }),
    ),
    [{ type: "result", answer: "甲", sessionId: "sess_a" }],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        eventType: "run:ended",
        sessionId: "sess_b",
        payload: { status: "completed" },
      }),
    ),
    [{ type: "result", answer: "乙", sessionId: "sess_b" }],
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
