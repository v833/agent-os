/** 会话命令测试：覆盖带提及的合法命令和普通文本误识别边界。 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseCliRequest, parseCommand } from "./command-parser.js";

test("识别会话控制命令和可选机器人提及", () => {
  assert.deepEqual(parseCommand("/status"), { name: "status" });
  assert.deepEqual(parseCommand("@MyBot /close"), { name: "close" });
  assert.deepEqual(parseCommand("@Agent OS /help  "), { name: "help" });
  assert.deepEqual(parseCommand("/new"), { name: "new" });
  assert.deepEqual(parseCommand("@Agent OS /resume"), { name: "resume" });
  assert.deepEqual(parseCommand("/compact"), {
    name: "compact",
    instructions: undefined,
  });
  assert.deepEqual(parseCommand("/compact 保留接口约定，省略测试日志"), {
    name: "compact",
    instructions: "保留接口约定，省略测试日志",
  });
});

test("解析 /cd 的查询、带空格路径和机器人提及", () => {
  assert.deepEqual(parseCommand("/cd"), { name: "cd", path: undefined });
  assert.deepEqual(parseCommand("@Agent OS /cd ../another project  "), {
    name: "cd",
    path: "../another project",
  });
  assert.deepEqual(parseCommand("/cd C:\\work\\project"), {
    name: "cd",
    path: "C:\\work\\project",
  });
});

test("解析 /schedule 的 add / list / remove 与机器人提及", () => {
  assert.deepEqual(parseCommand('/schedule add "每 30 分钟" 读取日志'), {
    name: "schedule",
    action: "add",
    schedule: "每 30 分钟",
    prompt: "读取日志",
  });
  assert.deepEqual(
    parseCommand('@Agent OS /schedule add "0 9 * * *" 每日总结'),
    {
      name: "schedule",
      action: "add",
      schedule: "0 9 * * *",
      prompt: "每日总结",
    },
  );
  assert.deepEqual(parseCommand("/schedule list"), {
    name: "schedule",
    action: "list",
  });
  assert.deepEqual(parseCommand("/schedule remove sched-001"), {
    name: "schedule",
    action: "remove",
    id: "sched-001",
  });
  assert.deepEqual(parseCommand("/schedule remove #sched-001"), {
    name: "schedule",
    action: "remove",
    id: "sched-001",
  });
});

test("/schedule 缺引号或参数不完整时不会被误识别", () => {
  assert.equal(parseCommand("/schedule"), undefined);
  assert.equal(parseCommand("/schedule add 每 30 分钟 读取日志"), undefined);
  assert.equal(parseCommand('/schedule add "每 30 分钟"'), undefined);
  assert.equal(parseCommand("/schedule remove"), undefined);
  assert.equal(parseCommand("帮我 /schedule list"), undefined);
});

test("普通文本和不支持的命令不会被误识别", () => {
  assert.equal(parseCommand("帮我运行 /status 看看"), undefined);
  assert.equal(parseCommand("/unknown"), undefined);
  assert.equal(parseCommand("status"), undefined);
  assert.equal(parseCommand("帮我执行 /cd 检查项目"), undefined);
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
  assert.deepEqual(parseCliRequest("/dimagent 检查项目"), {
    cliId: "dimagent",
    prompt: "检查项目",
  });
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
