/** 会话命令测试：覆盖带提及的合法命令和普通文本误识别边界。 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseCliRequest, parseCommand } from "./command-parser.js";

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

test("解析新话题显式指定的 CLI 与真实任务正文", () => {
  assert.deepEqual(parseCliRequest("/codex 检查项目"), {
    cliId: "codex",
    prompt: "检查项目",
  });
  assert.deepEqual(parseCliRequest("@MyBot /claude 修复类型错误"), {
    cliId: "claude",
    prompt: "修复类型错误",
  });
  assert.deepEqual(parseCliRequest("@MyBot /codex\n检查 package.json"), {
    cliId: "codex",
    prompt: "检查 package.json",
  });
  assert.deepEqual(
    parseCliRequest("@Agent OS /claude 检查项目", "Agent OS"),
    {
      cliId: "claude",
      prompt: "检查项目",
    },
  );
});

test("空 CLI 指令保留引擎选择，普通文本不误识别", () => {
  assert.deepEqual(parseCliRequest("/codex"), {
    cliId: "codex",
    prompt: "",
  });
  assert.deepEqual(parseCliRequest("@MyBot /claude  "), {
    cliId: "claude",
    prompt: "",
  });
  assert.equal(parseCliRequest("帮我解释 /codex 的作用"), undefined);
  assert.equal(
    parseCliRequest("@Agent OS 帮我解释 /codex 的作用", "Agent OS"),
    undefined,
  );
  assert.equal(parseCliRequest("/status"), undefined);
});
