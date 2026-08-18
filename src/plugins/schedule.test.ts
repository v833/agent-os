/**
 * schedule 测试：覆盖周期解析（cron / 自然语言）、触发时间计算、
 * 到点触发、目标话题 busy/closed 跳过、删除与持久化重启恢复。
 * 用假 lark/tasks 服务 + 真实 SessionManager/JsonScheduleStore 组装最小宿主。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context, Service } from "cordis";
import type { CliAccessMode, CliId } from "../cli/types.js";
import type {
  CliAdapter,
  CliRunResult,
  CliSessionSummary,
} from "../cli/types.js";
import type { RunCliOptions } from "../cli/runner.js";
import type { BotConfig } from "../core/bot-registry.js";
import { parseSchedule } from "../core/schedule-parser.js";
import {
  JsonScheduleStore,
  type ScheduleTask,
} from "../core/schedule-store.js";
import { SessionManager } from "../core/session-manager.js";
import { JsonSessionStore } from "../core/session-store.js";
import type {
  Bot,
  BotIdentity,
  IncomingMessage,
} from "../im/lark.js";
import * as cardsPlugin from "./cards.js";
import * as collaborationPlugin from "./collaboration.js";
import * as commandsPlugin from "./commands.js";
import * as routerPlugin from "./router.js";
import * as scheduleCommand from "./commands/schedule.js";
import { waitForAllActive } from "./loader.js";
import { SessionsService } from "./sessions.js";
import { ScheduleService } from "./schedule.js";
import type { BotRuntime, StartTaskInput } from "./types.js";

function createFakeBot() {
  const calls = { sends: [] as string[], replies: [] as string[] };
  const bot = {
    client: {},
    getIdentity: async () =>
      ({ openId: "bot_open", name: "TestBot" }) as BotIdentity,
    send: async (_chatId: string, text: string) => {
      calls.sends.push(text);
      return `send-${calls.sends.length}`;
    },
    reply: async (_id: string, text: string) => {
      calls.replies.push(text);
      return `msg-${calls.replies.length}`;
    },
    replyCard: async () => "card-1",
    replyMention: async () => "mention-1",
    updateCard: async () => undefined,
    downloadResource: async () => "downloads/x",
  } as unknown as Bot;
  return { bot, calls };
}

/** 假 lark 服务：运行时表由测试填充，替换真实飞书连接。 */
class FakeLarkService extends Service {
  runtimes = new Map<string, BotRuntime>();

  constructor(ctx: Context) {
    super(ctx, "lark");
  }

  bot(id: string): BotRuntime | undefined {
    return this.runtimes.get(id);
  }
}

/** 假 tasks 服务：只记录 startTask 调用，不真正执行 CLI。 */
class FakeTasksService extends Service {
  started: StartTaskInput[] = [];

  constructor(ctx: Context) {
    super(ctx, "tasks");
  }

  startTask(input: StartTaskInput): void {
    this.started.push(input);
  }
}

interface Host {
  root: Context;
  schedule: ScheduleService;
  tasks: FakeTasksService;
  bot: ReturnType<typeof createFakeBot>["bot"];
  calls: ReturnType<typeof createFakeBot>["calls"];
}

/** 组装最小宿主：真实 ScheduleService + 假 lark/tasks + 真实会话模型。 */
async function createHost(
  t: test.TestContext,
  sessionsDir = "",
): Promise<Host> {
  const root = new Context();
  const fakeBot = createFakeBot();
  const lark = new FakeLarkService(root);
  const tasks = new FakeTasksService(root);
  const dir =
    sessionsDir || (await mkdtemp(join(tmpdir(), "agent-os-schedule-")));
  const manager = await SessionManager.open({
    store: new JsonSessionStore(join(dir, "sessions.json")),
  });
  const sessionsService = new SessionsService(root);
  sessionsService.init(manager);
  const schedule = new ScheduleService(root, "Etc/GMT-8");
  await schedule.init(new JsonScheduleStore(join(dir, "schedules.json")));
  // croner job 持有 unref 定时器，测试结束必须清理，否则临时目录无法删除。
  t.after(async () => {
    schedule.dispose();
    if (!sessionsDir) await rm(dir, { recursive: true, force: true });
  });

  lark.runtimes.set("testbot", {
    config: {
      id: "testbot",
      appId: "cli_test",
      appSecret: "secret",
      defaultCliId: "codex",
      accessMode: "headless",
      systemPrompt: "",
      workspaceDir: process.cwd(),
      collaborationMaxRounds: 2,
    },
    bot: fakeBot.bot,
    identity: { openId: "bot_open", name: "TestBot" },
  });

  return { root, schedule, tasks, bot: fakeBot.bot, calls: fakeBot.calls };
}

function registerOptions(
  overrides: Partial<Parameters<ScheduleService["register"]>[0]> = {},
) {
  return {
    schedule: "0 9 * * *",
    prompt: "读取 data/logs/error.log 并总结最新错误",
    botId: "testbot",
    chatId: "oc_chat",
    threadId: "omt_thread",
    rootId: "",
    messageId: "om_command",
    cliId: "codex" as CliId,
    accessMode: "headless" as CliAccessMode,
    workspaceDir: process.cwd(),
    ownerOpenId: "ou_owner",
    ...overrides,
  };
}

// ---------- 周期解析 ----------

test("parseSchedule 接受 5 段 cron 并原样返回", () => {
  const spec = parseSchedule("0 9 * * *");
  assert.deepEqual(spec, { expr: "0 9 * * *", display: "0 9 * * *" });
});

test("parseSchedule 把自然语言周期转换为 cron 表达式", () => {
  assert.deepEqual(parseSchedule("每 30 分钟"), {
    expr: "*/30 * * * *",
    display: "每 30 分钟",
  });
  assert.deepEqual(parseSchedule("每2小时"), {
    expr: "0 */2 * * *",
    display: "每 2 小时",
  });
  assert.deepEqual(parseSchedule("每 3 天"), {
    expr: "0 0 */3 * *",
    display: "每 3 天",
  });
  assert.deepEqual(parseSchedule("每小时"), {
    expr: "0 * * * *",
    display: "每小时",
  });
  assert.deepEqual(parseSchedule("每天 9:00"), {
    expr: "0 9 * * *",
    display: "每天 09:00",
  });
  assert.deepEqual(parseSchedule("每天早上9点"), {
    expr: "0 9 * * *",
    display: "每天 09:00",
  });
  assert.deepEqual(parseSchedule("每天"), {
    expr: "0 0 * * *",
    display: "每天 00:00",
  });
});

test("parseSchedule 拒绝无效 cron 与无法识别的文本", () => {
  assert.throws(() => parseSchedule("61 * * * *"), /cron 表达式无效/);
  assert.throws(() => parseSchedule("每 0 分钟"), /1-59/);
  assert.throws(() => parseSchedule("每 100 小时"), /1-24/);
  assert.throws(() => parseSchedule("每 40 天"), /1-30/);
  assert.throws(() => parseSchedule("每天 25 点"), /0-23/);
  assert.throws(() => parseSchedule("乱七八糟"), /无法识别的周期/);
  assert.throws(() => parseSchedule("   "), /周期不能为空/);
});

// ---------- 持久化 ----------

test("schedules.json 不存在时按首次启动返回空列表", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agent-os-sched-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new JsonScheduleStore(join(dir, "data", "schedules.json"));
  assert.deepEqual(await store.load(), []);
});

test("保存后可以完整恢复定时任务，坏记录被过滤", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agent-os-sched-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, "data", "schedules.json");
  const store = new JsonScheduleStore(filePath);
  const tasks: ScheduleTask[] = [
    {
      id: "sched-001",
      schedule: "每 30 分钟",
      expr: "*/30 * * * *",
      display: "每 30 分钟",
      prompt: "总结日志",
      botId: "developer",
      chatId: "oc_chat",
      threadId: "omt_thread",
      rootId: "",
      messageId: "om_cmd",
      cliId: "codex",
      accessMode: "acp",
      workspaceDir: process.cwd(),
      ownerOpenId: "ou_owner",
      enabled: true,
      lastRunAt: "2026-08-14T02:00:00.000Z",
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T02:00:00.000Z",
    },
  ];

  await store.save(tasks);

  // 混入一条坏记录后加载，坏记录应被过滤并重写文件。
  const rows = JSON.parse(await readFile(filePath, "utf8"));
  rows.push({ id: "", schedule: "" });
  await writeFile(filePath, JSON.stringify(rows), "utf8");

  const restored = await store.load();
  assert.equal(restored.length, 1);
  assert.equal(restored[0]?.accessMode, "acp");
  assert.equal(restored[0]?.lastRunAt, "2026-08-14T02:00:00.000Z");
  assert.equal((await readFile(filePath, "utf8")).endsWith("\n"), true);
});

// ---------- 触发语义 ----------

test("register 创建任务并持久化，nextRunAt 能给出下次触发时间", async (t) => {
  const host = await createHost(t);
  const task = await host.schedule.register(registerOptions());
  assert.equal(task.id, "sched-001");
  assert.equal(task.display, "0 9 * * *");
  assert.ok(host.schedule.nextRunAt(task.id) instanceof Date);
});

test("重启后用新宿主从磁盘恢复任务并可继续触发", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agent-os-schedule-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = await createHost(t, dir);
  await first.schedule.register(registerOptions({ schedule: "每 30 分钟" }));
  first.schedule.dispose();

  // 新 root + 新服务实例模拟进程重启，磁盘中的任务应恢复并保持可触发。
  const second = await createHost(t, dir);
  const restored = second.schedule.list();
  assert.equal(restored.length, 1);
  assert.equal(restored[0]?.id, "sched-001");
  assert.equal(restored[0]?.expr, "*/30 * * * *");
  const outcome = await second.schedule.trigger("sched-001");
  assert.deepEqual(outcome, { status: "started" });
});

test("trigger 到点执行：发锚点消息并交给 tasks.startTask", async (t) => {
  const host = await createHost(t);
  const task = await host.schedule.register(registerOptions());

  const outcome = await host.schedule.trigger(task.id);

  assert.deepEqual(outcome, { status: "started" });
  assert.equal(host.calls.sends.length, 1);
  assert.ok(host.calls.sends[0]?.includes("定时任务"));
  assert.equal(host.tasks.started.length, 1);
  const started = host.tasks.started[0]!;
  assert.equal(started.replyToMessageId, "send-1");
  assert.equal(started.requestedPrompt, task.prompt);
  assert.equal(started.senderOpenId, "ou_owner");
  assert.equal(started.session.threadId, "omt_thread");
  assert.ok(host.schedule.get(task.id)?.lastRunAt);
});

test("目标话题 active 时到点触发会跳过并记录", async (t) => {
  const host = await createHost(t);
  const options = registerOptions();
  const task = await host.schedule.register(options);

  // 先用相同地址创建并占用会话，模拟用户任务正在执行。
  const manager = host.root.sessions.manager;
  const created = await manager.resolve(
    {
      messageId: options.messageId,
      chatId: options.chatId,
      threadId: options.threadId,
      rootId: options.rootId,
    },
    options.cliId,
    options.botId,
  );
  await manager.transition(created.session.id, "active");

  const outcome = await host.schedule.trigger(task.id);

  assert.deepEqual(outcome, { status: "skipped", reason: "busy" });
  assert.equal(host.tasks.started.length, 0);
  assert.ok(host.schedule.get(task.id)?.lastSkippedAt);
});

test("目标话题 closed 时到点触发会跳过", async (t) => {
  const host = await createHost(t);
  const options = registerOptions();
  const task = await host.schedule.register(options);

  const manager = host.root.sessions.manager;
  const created = await manager.resolve(
    {
      messageId: options.messageId,
      chatId: options.chatId,
      threadId: options.threadId,
      rootId: options.rootId,
    },
    options.cliId,
    options.botId,
  );
  await manager.transition(created.session.id, "closed");

  const outcome = await host.schedule.trigger(task.id);

  assert.deepEqual(outcome, { status: "skipped", reason: "closed" });
  assert.equal(host.tasks.started.length, 0);
});

test("remove 删除任务后不再触发", async (t) => {
  const host = await createHost(t);
  const task = await host.schedule.register(registerOptions());

  assert.equal(await host.schedule.remove(task.id), true);
  assert.equal(await host.schedule.remove("sched-999"), false);

  const outcome = await host.schedule.trigger(task.id);
  assert.deepEqual(outcome, { status: "error", reason: "任务不存在或已停用" });
  assert.equal(host.tasks.started.length, 0);
});

test("trigger 对不存在的任务返回错误", async (t) => {
  const host = await createHost(t);
  const outcome = await host.schedule.trigger("sched-999");
  assert.deepEqual(outcome, { status: "error", reason: "任务不存在或已停用" });
});

test("多个任务按顺序生成稳定递增 ID", async (t) => {
  const host = await createHost(t);
  const first = await host.schedule.register(
    registerOptions({ schedule: "0 9 * * *" }),
  );
  const second = await host.schedule.register(
    registerOptions({ schedule: "每 30 分钟" }),
  );
  assert.equal(first.id, "sched-001");
  assert.equal(second.id, "sched-002");
  assert.equal(host.schedule.list().length, 2);
});

// ---------- 命令路由端到端 ----------

const baseBotConfig: BotConfig = {
  id: "testbot",
  appId: "cli_test",
  appSecret: "secret",
  defaultCliId: "codex",
  accessMode: "headless",
  systemPrompt: "",
  workspaceDir: process.cwd(),
  collaborationMaxRounds: 2,
};

class FakeConfigService extends Service {
  readonly bots: BotConfig[];
  readonly defaultWorkspaces: Record<string, string>;

  constructor(ctx: Context, bots: BotConfig[]) {
    super(ctx, "config");
    this.bots = bots;
    this.defaultWorkspaces = Object.fromEntries(
      bots.map((bot) => [bot.id, bot.workspaceDir]),
    );
  }

  bot(id: string): BotConfig | undefined {
    return this.bots.find((bot) => bot.id === id);
  }
}

const fakeAdapter: CliAdapter = {
  id: "codex",
  command: "fake-codex",
  displayName: "FakeCodex",
  accessMode: "headless",
  buildArgs: () => [],
  buildResumeArgs: () => [],
  buildCompactPlan: () => ({
    protocol: "codex-app-server",
    command: "fake",
    args: [],
    sessionId: "",
  }),
  parseEvents: () => [],
};

class FakeCliService extends Service {
  constructor(ctx: Context) {
    super(ctx, "cli");
  }

  register(): void {}

  get(): CliAdapter {
    return fakeAdapter;
  }

  list(): CliAdapter[] {
    return [fakeAdapter];
  }

  run(options: RunCliOptions): Promise<CliRunResult> {
    return new Promise((resolve) => {
      options.signal?.addEventListener(
        "abort",
        () => resolve({ answer: "", sessionId: "sess-1" }),
        { once: true },
      );
    });
  }

  compact(): Promise<{ sessionId: string; compacted: boolean }> {
    return Promise.resolve({ sessionId: "sess-1", compacted: true });
  }

  listNativeSessions(): Promise<CliSessionSummary[]> {
    return Promise.resolve([]);
  }
}

function incomingMessage(text: string): IncomingMessage {
  return {
    messageId: "om_command",
    chatId: "oc_chat",
    chatType: "group",
    messageType: "text",
    text,
    rawContent: JSON.stringify({ text }),
    rootId: "",
    threadId: "omt_thread",
    senderType: "user",
    senderOpenId: "ou_owner",
    mentions: [],
  };
}

/** 用真实 router + 命令插件 + schedule 服务组装完整命令链路。 */
async function createRoutedHost(t: test.TestContext) {
  const root = new Context();
  const fakeBot = createFakeBot();
  new FakeConfigService(root, [baseBotConfig]);
  new FakeCliService(root);
  const lark = new FakeLarkService(root);
  const tasks = new FakeTasksService(root);
  const dir = await mkdtemp(join(tmpdir(), "agent-os-schedule-"));
  const manager = await SessionManager.open({
    store: new JsonSessionStore(join(dir, "sessions.json")),
  });
  new SessionsService(root).init(manager);
  root.plugin(cardsPlugin);
  root.plugin(commandsPlugin);
  root.plugin(collaborationPlugin);
  const schedule = new ScheduleService(root, "Etc/GMT-8");
  await schedule.init(new JsonScheduleStore(join(dir, "schedules.json")));
  scheduleCommand.apply(root);
  routerPlugin.apply(root);
  t.after(async () => {
    schedule.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  lark.runtimes.set("testbot", {
    config: baseBotConfig,
    bot: fakeBot.bot,
    identity: { openId: "bot_open", name: "TestBot" },
  });

  return { root, schedule, tasks, bot: fakeBot.bot, calls: fakeBot.calls };
}

test("/schedule add 经 router 派发后创建任务并回复", async (t) => {
  const host = await createRoutedHost(t);
  await host.root.parallel(
    "bot/message",
    incomingMessage('/schedule add "每 30 分钟" 读取 data/logs/error.log'),
    host.bot,
    baseBotConfig,
  );

  assert.equal(host.schedule.list().length, 1);
  const task = host.schedule.list()[0]!;
  assert.equal(task.id, "sched-001");
  assert.equal(task.expr, "*/30 * * * *");
  assert.equal(task.prompt, "读取 data/logs/error.log");
  assert.ok(
    host.calls.sends.length === 0 && host.tasks.started.length === 0,
    "命令阶段不应触发执行",
  );
});

test("/schedule list 与 /schedule remove 经 router 派发正常", async (t) => {
  const host = await createRoutedHost(t);
  await host.schedule.register(registerOptions({ schedule: "每 30 分钟" }));
  await host.schedule.register(
    registerOptions({ schedule: "0 9 * * *", messageId: "om_cmd2" }),
  );

  await host.root.parallel(
    "bot/message",
    incomingMessage("/schedule list"),
    host.bot,
    baseBotConfig,
  );
  await host.root.parallel(
    "bot/message",
    incomingMessage("/schedule remove sched-001"),
    host.bot,
    baseBotConfig,
  );

  const remaining = host.schedule.list();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.id, "sched-002");
});

test("/schedule add 使用非法周期时回复错误且不创建任务", async (t) => {
  const host = await createRoutedHost(t);
  await host.root.parallel(
    "bot/message",
    incomingMessage('/schedule add "乱七八糟" 读取日志'),
    host.bot,
    baseBotConfig,
  );

  assert.equal(host.schedule.list().length, 0);
});
