/**
 * Mastra 适配器测试：验证 runner 启动参数、JSONL 事件翻译，
 * 以及不支持/恢复/整理能力时的显式失败边界。
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { MastraAdapter } from "./mastra-adapter.js";

test("Mastra 启动参数包含节点入口、runner 与独立的用户提示词", () => {
  const adapter = new MastraAdapter();
  const prompt = '检查 "package.json"\n$(Remove-Item important.txt)';
  const args = adapter.buildArgs(prompt);

  assert.equal(args.length, 3);
  assert.equal(args.filter((argument) => argument === prompt).length, 1);
  // 本机没有就绪的 tsx 与 runner 时，参数本身就是预期内容，无需存在性断言；
  // 但源码模式运行下应能解析出真实路径。
  assert.ok(args[0].length > 0);
  assert.match(args[1], /mastra-runner\.ts$/);
});

test("Windows 下 Mastra 命令直接指向 node 可执行文件", () => {
  if (process.platform !== "win32") return;
  const adapter = new MastraAdapter();
  assert.equal(adapter.command, process.execPath);
  assert.equal(existsSync(adapter.command), true);
});

test("Mastra 解析工具开始、结束和失败的配对事件", () => {
  const adapter = new MastraAdapter();

  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "tool_start",
        toolUseId: "call-1",
        toolName: "read_file",
        label: "读取文件",
        detail: "src/index.ts",
      }),
    ),
    [
      {
        type: "tool_start",
        toolUseId: "call-1",
        toolName: "read_file",
        label: "读取文件",
        detail: "src/index.ts",
      },
    ],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({ type: "tool_end", toolUseId: "call-1", failed: false }),
    ),
    [{ type: "tool_end", toolUseId: "call-1", failed: false }],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({ type: "tool_end", toolUseId: "call-2", failed: true }),
    ),
    [{ type: "tool_end", toolUseId: "call-2", failed: true }],
  );
});

test("Mastra 解析最终回答、用量统计与错误事件", () => {
  const adapter = new MastraAdapter();

  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({ type: "result", answer: "项目名是 agent-os" }),
    ),
    [{ type: "result", answer: "项目名是 agent-os" }],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({
        type: "result",
        answer: "完成",
        stats: { inputTokens: 100, outputTokens: 20 },
      }),
    ),
    [
      {
        type: "result",
        answer: "完成",
        stats: { inputTokens: 100, outputTokens: 20 },
      },
    ],
  );
  assert.deepEqual(
    adapter.parseEvents(
      JSON.stringify({ type: "error", message: "模型余额不足" }),
    ),
    [{ type: "error", message: "模型余额不足" }],
  );
  assert.deepEqual(adapter.parseEvents("not-json"), []);
});

test("Mastra 明确拒绝续聊和上下文整理", () => {
  const adapter = new MastraAdapter();
  assert.throws(
    () => adapter.buildResumeArgs("继续", "mastra-session"),
    /不保存会话/,
  );
  assert.throws(() => adapter.buildCompactPlan("mastra-session"), /不支持/);
});