/**
 * CLI 事件流探针：从标准输入逐行读取 Codex/Claude JSONL，
 * 实时打印带相对时间戳的统一事件时间线。
 */
import { createInterface } from "node:readline";
import { parseCliEventLine } from "./cli-events.js";

const startedAt = Date.now();
// 使用相对时间更容易观察模型思考、工具执行和最终回复各自耗时。
const stamp = () => `[${((Date.now() - startedAt) / 1000).toFixed(1)}s]`;

const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
  // 单个原始事件可能展开成多行人类可读信息，例如 Claude 的结果和账单。
  for (const message of parseCliEventLine(line)) {
    console.log(`${stamp()} ${message}`);
  }
});
