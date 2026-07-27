/** 会话命令测试：覆盖带提及的合法命令和普通文本误识别边界。 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseCommand } from "./command-parser.js";

test("识别三条会话命令和可选机器人提及", () => {
  assert.deepEqual(parseCommand("/status"), { name: "status" });
  assert.deepEqual(parseCommand("@MyBot /close"), { name: "close" });
  assert.deepEqual(parseCommand("@Agent OS /help  "), { name: "help" });
});

test("普通文本和不支持的命令不会被误识别", () => {
  assert.equal(parseCommand("帮我运行 /status 看看"), undefined);
  assert.equal(parseCommand("/unknown"), undefined);
  assert.equal(parseCommand("status"), undefined);
});
