/**
 * Mastra runner 事件解析测试：验证把 Mastra fullStream 的三种工具 chunk
 * （tool-call / tool-result / tool-error）翻译成统一事件，
 * 特别是失败路径必须正确配对出 tool_end。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseMastraChunk,
  type RunnerEvent,
} from "./mastra-runner.js";

const TOOL_LABELS: Record<string, string> = {
  read_file: "读取文件",
  write_file: "写入文件",
  run_command: "运行命令",
};

function toolDetail(name: string, args: unknown): string | undefined {
  const record = args as Record<string, unknown> | undefined;
  if (name === "read_file" || name === "write_file") {
    return typeof record?.path === "string" ? record.path : undefined;
  }
  if (name === "run_command") {
    return typeof record?.command === "string" ? record.command : undefined;
  }
  return undefined;
}

test("tool-call 翻译成 tool_start", () => {
  assert.deepEqual(
    parseMastraChunk(
      {
        type: "tool-call",
        payload: {
          toolCallId: "call-1",
          toolName: "read_file",
          args: { path: "src/index.ts" },
        },
      },
      TOOL_LABELS,
      toolDetail,
    ),
    [
      {
        type: "tool-start",
        toolUseId: "call-1",
        toolName: "read_file",
        label: "读取文件",
        detail: "src/index.ts",
      },
    ],
  );
});

test("tool-result 在 isError 时翻译成 tool_end failed=true", () => {
  assert.deepEqual(
    parseMastraChunk(
      {
        type: "tool-result",
        payload: { toolCallId: "call-2", isError: true },
      },
      TOOL_LABELS,
      toolDetail,
    ),
    [{ type: "tool-end", toolUseId: "call-2", failed: true }],
  );
});

test("tool-error 翻译成 tool_end failed=true", () => {
  assert.deepEqual(
    parseMastraChunk(
      { type: "tool-error", payload: { toolCallId: "call-3" } },
      TOOL_LABELS,
      toolDetail,
    ),
    [{ type: "tool-end", toolUseId: "call-3", failed: true }],
  );
  assert.deepEqual(parseMastraChunk({ type: "unknown" }, TOOL_LABELS, toolDetail), []);
  assert.deepEqual(
    parseMastraChunk(
      {
        type: "tool-result",
        payload: { result: "ok" }, // 缺 toolCallId：应给 tool_end，id 用空串兜底
      },
      TOOL_LABELS,
      toolDetail,
    ),
    [{ type: "tool-end", toolUseId: "", failed: false }],
  );
});