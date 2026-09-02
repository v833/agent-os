/**
 * observability 插件集成测试：
 * 验证在 Cordis 上下文中装配 observability 与 commands/metrics 插件，
 * 测试事件监听、指标聚合、Trace 记录落盘以及 /metrics 飞书命令路由。
 */
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Context } from "cordis";
import { ObservabilityService } from "./observability.js";
import * as metricsCommand from "./commands/metrics.js";
import { CommandsService } from "./commands.js";
import type { TaskResultPayload, QAResultPayload } from "./types.js";
import type { Bot, IncomingMessage } from "../im/lark.js";
import type { BotConfig } from "../core/bot-registry.js";
import type { Session } from "../core/session-manager.js";

function createMockBot(): { bot: Bot; replies: string[] } {
  const replies: string[] = [];
  const bot = {
    reply: async (_replyToMessageId: string, content: string) => {
      replies.push(content);
    },
  } as unknown as Bot;
  return { bot, replies };
}

function createMockBotConfig(id = "developer"): BotConfig {
  return {
    id,
    appId: "APP_ID",
    appSecret: "APP_SECRET",
    defaultCliId: "codex",
    accessMode: "headless",
    workspaceDir: "/workspace",
    role: "开发工程师",
    skills: [],
    systemPrompt: "prompt",
    collaborationMaxRounds: 16,
  };
}

function createMockSession(botId = "developer"): Session {
  return {
    id: "sess-001",
    botId,
    chatId: "chat-001",
    threadId: "thread-001",
    workspaceDir: "/workspace",
    cliId: "codex",
    accessMode: "headless",
    cliSessionId: "cli-sess-001",
    status: "idle",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function createMockMessage(text = "/metrics"): IncomingMessage {
  return {
    messageId: "msg-req-001",
    chatId: "chat-001",
    threadId: "thread-001",
    rootId: "",
    chatType: "group",
    messageType: "text",
    text,
    rawContent: text,
    senderType: "user",
    senderOpenId: "ou_user1",
    mentions: [],
  };
}

test("observability 插件在 Cordis 中挂载并响应 task/result 和 task/failed 事件", async () => {
  const ctx = new Context();
  const observability = new ObservabilityService(ctx, {
    maxTracesInMemory: 50,
  });

  const botConfig = createMockBotConfig("developer");
  const session = createMockSession("developer");
  const { bot } = createMockBot();

  await ctx.parallel("task/started", {
    botConfig,
    session,
    taskId: "task-success",
    traceId: "trace-success",
    startedAt: Date.now() - 2500,
  });
  assert.equal(observability.getSummary().runningTasks, 1);

  // 触发一次成功任务
  const successPayload: TaskResultPayload = {
    bot,
    botConfig,
    session,
    requestedPrompt: "请编写一个单元测试",
    answer: "测试已编写完毕",
    replyToMessageId: "msg-001",
    hasThread: true,
    traceId: "trace-success",
    durationMs: 2500,
    stats: {
      totalTokens: 1200,
      inputTokens: 900,
      outputTokens: 300,
      cacheReadTokens: 100,
      cacheCreationTokens: 50,
    },
    toolMetrics: {
      read_file: { invocations: 1, failures: 0 },
      write_file: { invocations: 1, failures: 0 },
    },
  };

  await ctx.parallel("task/result", successPayload);
  // 上游重试重复广播同一终态时，Trace 与工具指标都只能结算一次。
  await ctx.parallel("task/result", successPayload);

  // 触发一次失败任务
  const failedSession = createMockSession("qa");
  await ctx.parallel("task/started", {
    botConfig: createMockBotConfig("qa"),
    session: failedSession,
    taskId: "task-failed",
    traceId: "trace-failed",
    startedAt: Date.now() - 1500,
  });
  const failedPayload: TaskResultPayload = {
    bot,
    botConfig: createMockBotConfig("qa"),
    session: failedSession,
    requestedPrompt: "请执行回归测试",
    answer: "",
    replyToMessageId: "msg-002",
    hasThread: true,
    durationMs: 1500,
    error: "Command execution failed with exit code 1",
    traceId: "trace-failed",
    stats: { totalTokens: 100, inputTokens: 100 },
    toolMetrics: { shell: { invocations: 1, failures: 1 } },
  };

  await ctx.parallel("task/failed", failedPayload);

  for (const terminal of ["paused", "cancelled"] as const) {
    const terminalSession = createMockSession(terminal);
    const traceId = `trace-${terminal}`;
    await ctx.parallel("task/started", {
      botConfig: createMockBotConfig(terminal),
      session: terminalSession,
      traceId,
      startedAt: Date.now() - 100,
    });
    await ctx.parallel(`task/${terminal}`, {
      bot,
      botConfig: createMockBotConfig(terminal),
      session: terminalSession,
      requestedPrompt: "等待流程",
      answer: "",
      replyToMessageId: `msg-${terminal}`,
      hasThread: true,
      traceId,
      durationMs: 100,
    });
  }

  // 触发一次 QA 结论
  const qaPayload: QAResultPayload = {
    ...successPayload,
    qaResult: {
      verdict: "pass",
      revision: "rev-123",
      tests: [{ command: "npm test", status: "passed", exitCode: 0 }],
      findings: [],
      nextAction: "close",
    },
  };
  await ctx.parallel("qa/result", qaPayload);

  const summary = observability.getSummary();
  assert.equal(summary.totalTasks, 4);
  assert.equal(summary.successTasks, 1);
  assert.equal(summary.failedTasks, 1);
  assert.equal(summary.pausedTasks, 1);
  assert.equal(summary.cancelledTasks, 1);
  assert.equal(summary.runningTasks, 0);
  assert.equal(summary.successRate, 50);
  assert.equal(summary.tokens.total, 1300);
  assert.equal(summary.tokens.input, 1000);
  assert.equal(summary.tokens.output, 300);
  assert.equal(summary.byBot.developer.totalTasks, 1);
  assert.equal(summary.byBot.qa.totalTasks, 1);
  assert.equal(summary.byTool.read_file.invocations, 1);
  assert.equal(summary.byTool.shell.failures, 1);
  assert.equal(summary.qa.pass, 1);

  const recent = observability.getRecentTraces();
  assert.equal(recent.length, 4);
  assert.equal(recent.filter((trace) => trace.traceId === "trace-success").length, 1);
});

test("observability 插件支持 exportToFile 异步写入 JSONL 文件", async () => {
  const tmpLogPath = join(tmpdir(), `threadpilot-trace-test-${Date.now()}.jsonl`);

  const ctx = new Context();
  new ObservabilityService(ctx, {
    exportToFile: true,
    traceLogPath: tmpLogPath,
  });

  const { bot } = createMockBot();
  await ctx.parallel("task/result", {
    bot,
    botConfig: createMockBotConfig("assistant"),
    session: createMockSession("assistant"),
    requestedPrompt: "总结今日待办",
    answer: "今日待办列表如下...",
    replyToMessageId: "msg-003",
    hasThread: true,
    durationMs: 800,
    error: "Authorization code SECRET-CODE-123",
    stats: { totalTokens: 450 },
  });

  // 读取文件内容
  const content = await readFile(tmpLogPath, "utf8");
  assert.ok(content.includes("assistant"));
  assert.equal(content.includes("总结今日待办"), false, "Trace 文件不得落盘用户提示词");
  assert.equal(content.includes("SECRET-CODE-123"), false, "Trace 文件不得落盘原始错误详情");

  await rm(tmpLogPath, { force: true });
});

test("/metrics 命令插件正确响应飞书大盘请求并支持子命令", async () => {
  const ctx = new Context();
  const commands = new CommandsService(ctx);
  const observability = new ObservabilityService(ctx);
  metricsCommand.apply(ctx);

  const { bot, replies } = createMockBot();
  const botConfig = createMockBotConfig("developer");
  const session = createMockSession("developer");

  // 记录一次任务
  await ctx.parallel("task/result", {
    bot,
    botConfig,
    session,
    requestedPrompt: "重构模块 A",
    answer: "重构完成",
    replyToMessageId: "msg-001",
    hasThread: true,
    durationMs: 1200,
    stats: { totalTokens: 800 },
  });
  await ctx.parallel("task/result", {
    bot,
    botConfig,
    session: { ...session, id: "sess-other", chatId: "chat-other" },
    requestedPrompt: "其他群的敏感任务内容",
    answer: "完成",
    replyToMessageId: "msg-other",
    hasThread: true,
    durationMs: 500,
    stats: { totalTokens: 9900 },
  });

  const mockMessage = createMockMessage("/metrics");
  const handler = commands.get("metrics")!;
  assert.ok(handler);

  // 1. 全局大盘 /metrics
  await handler({
    ctx,
    bot,
    botConfig,
    message: mockMessage,
    session,
    isNew: false,
    hasThread: true,
    taskId: "metrics-test-task",
    resolvedText: "/metrics",
    command: { name: "metrics", args: "" },
    cliAdapter: { id: "codex", displayName: "Codex" } as any,
  });

  assert.equal(replies.length, 1);
  assert.match(replies[0], /ThreadPilot 可观测性大盘/);
  assert.match(replies[0], /developer/);
  assert.match(replies[0], /任务总量：1/);
  assert.doesNotMatch(replies[0], /10,700/);

  // 2. /metrics traces
  await handler({
    ctx,
    bot,
    botConfig,
    message: mockMessage,
    session,
    isNew: false,
    hasThread: true,
    taskId: "metrics-test-task",
    resolvedText: "/metrics traces",
    command: { name: "metrics", args: "traces" },
    cliAdapter: { id: "codex", displayName: "Codex" } as any,
  });

  assert.equal(replies.length, 2);
  assert.match(replies[1], /最近链路追踪/);
  assert.doesNotMatch(replies[1], /重构模块 A|其他群的敏感任务内容/);
  assert.match(replies[1], /✅/);

  // 3. /metrics bot developer
  await handler({
    ctx,
    bot,
    botConfig,
    message: mockMessage,
    session,
    isNew: false,
    hasThread: true,
    taskId: "metrics-test-task",
    resolvedText: "/metrics bot developer",
    command: { name: "metrics", args: "bot developer" },
    cliAdapter: { id: "codex", displayName: "Codex" } as any,
  });

  assert.equal(replies.length, 3);
  assert.match(replies[2], /Bot 指标：developer/);

  // 4. 未公开的 reset 不再提供清空能力
  await handler({
    ctx,
    bot,
    botConfig,
    message: mockMessage,
    session,
    isNew: false,
    hasThread: true,
    taskId: "metrics-test-task",
    resolvedText: "/metrics reset",
    command: { name: "metrics", args: "reset" },
    cliAdapter: { id: "codex", displayName: "Codex" } as any,
  });

  assert.equal(replies.length, 4);
  assert.match(replies[3], /支持的用法/);
  assert.equal(observability.getSummary().totalTasks, 2);

  // 5. 不允许借 bot 子命令读取其他 Bot 的全局数据
  await handler({
    ctx,
    bot,
    botConfig,
    message: mockMessage,
    session,
    isNew: false,
    hasThread: true,
    taskId: "metrics-test-task",
    resolvedText: "/metrics bot qa",
    command: { name: "metrics", args: "bot qa" },
    cliAdapter: { id: "codex", displayName: "Codex" } as any,
  });
  assert.match(replies[4], /只能查询当前 Bot/);
});

test("当 observability 插件未启用时，commands/metrics 依赖未满足而不激活", async () => {
  const ctx = new Context();
  const commands = new CommandsService(ctx);
  ctx.plugin(metricsCommand);

  // 依赖未就绪，命令未被注册
  assert.equal(commands.get("metrics"), undefined);
});
