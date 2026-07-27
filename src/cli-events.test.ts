import assert from "node:assert/strict";
import test from "node:test";
import { parseCliEventLine } from "./cli-events.js";

test("解析 Codex 事件时间线", () => {
  assert.deepEqual(
    parseCliEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    ),
    ["会话开始 thread_id=thread-1"],
  );
  assert.deepEqual(
    parseCliEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "2" },
      }),
    ),
    ["模型说: 2"],
  );
  assert.deepEqual(
    parseCliEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", command: "Get-ChildItem" },
      }),
    ),
    ["执行命令: Get-ChildItem"],
  );
  assert.deepEqual(
    parseCliEventLine(
      JSON.stringify({ type: "turn.completed", usage: { output_tokens: 5 } }),
    ),
    ['完成 tokens={"output_tokens":5}'],
  );
});

test("解析 Claude Code 事件时间线", () => {
  assert.deepEqual(
    parseCliEventLine(
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "session-1",
        model: "claude",
      }),
    ),
    ["会话开始 session_id=session-1 model=claude"],
  );
  assert.deepEqual(
    parseCliEventLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Bash" },
            { type: "text", text: "2" },
          ],
        },
      }),
    ),
    ["调用工具: Bash", "模型说: 2"],
  );
  assert.deepEqual(
    parseCliEventLine(
      JSON.stringify({
        type: "result",
        num_turns: 1,
        duration_ms: 500,
        total_cost_usd: 0.01,
        result: "2",
      }),
    ),
    ["完成 turns=1 耗时=500ms 成本=$0.01", "最终回答: 2"],
  );
});

test("忽略非 JSON 日志和不关心的事件", () => {
  assert.deepEqual(parseCliEventLine("network reconnecting"), []);
  assert.deepEqual(parseCliEventLine('{"type":"turn.started"}'), []);
});
