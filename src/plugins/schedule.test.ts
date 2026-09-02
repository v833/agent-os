/**
 * schedule 测试：覆盖三种调度规则校验、Scheduler 的创建/暂停/恢复/删除、
 * 幂等去重与并发跳过、持久化恢复、watcher 差异合并、schedule_manage 分发，
 * 以及 /schedule /schedules 命令的路由端到端。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context, Service } from "cordis";
import type { CliAdapter, CliRunResult, CliSessionSummary } from "../cli/types.js";
import type { RunCliOptions } from "../cli/runner.js";
import type { BotConfig } from "../core/bot-registry.js";
import {
  SCHEDULE_MANAGE_TOOL_NAME,
  ScheduleManageRequestSchema,
  ScheduleRuleSchema,
  createScheduledTask,
  scheduleDescription,
  type ScheduledTask,
} from "../core/schedule.js";
import {
  ScheduleStore,
  JsonScheduleStore,
} from "../core/schedule-store.js";
import {
  ScheduleRunStore,
  JsonScheduleRunStore,
} from "../core/schedule-run-store.js";
import {
  Scheduler,
  type ScheduledTaskDispatcher,
} from "../core/scheduler.js";
import { executeScheduleManageRequest } from "../core/schedule-manage-service.js";
import { reconcileScheduleFile } from "../core/schedule-watcher.js";
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
import * as schedulesCommand from "./commands/schedules.js";
import { SessionsService } from "./sessions.js";
import { ScheduleService } from "./schedule.js";
import type { BotRuntime, StartTaskInput } from "./types.js";

// ---------- 规则校验 ----------

test("ScheduleRuleSchema 校验三种规则", () => {
  assert.deepEqual(
    ScheduleRuleSchema.parse({ kind: "once", runAt: "2026-09-01T09:00:00.000Z" }),
    { kind: "once", runAt: "2026-09-01T09:00:00.000Z" },
  );
  assert.deepEqual(
    ScheduleRuleSchema.parse({ kind: "interval", everyMs: 3600_000 }),
    { kind: "interval", everyMs: 3600_000 },
  );
  // cron 缺省时区补 Asia/Shanghai。
  assert.deepEqual(
    ScheduleRuleSchema.parse({ kind: "cron", expression: "0 9 * * *" }),
    { kind: "cron", expression: "0 9 * * *", timezone: "Asia/Shanghai" },
  );
});

test("ScheduleRuleSchema 拒绝非法输入", () => {
  assert.throws(() => ScheduleRuleSchema.parse({ kind: "once" }), /runAt/);
  assert.throws(
    () => ScheduleRuleSchema.parse({ kind: "interval", everyMs: 30_000 }),
    /everyMs/,
  );
  assert.throws(
    () => ScheduleRuleSchema.parse({ kind: "cron", expression: "" }),
    /expression/,
  );
  assert.throws(
    () =>
      ScheduleRuleSchema.parse({
        kind: "cron",
        expression: "61 * * * *",
        timezone: "Asia/Shanghai",
      }),
    /Cron 表达式无效/,
  );
  assert.throws(
    () =>
      ScheduleRuleSchema.parse({
        kind: "cron",
        expression: "0 9 * * *",
        timezone: "Mars/Olympus",
      }),
    /时区无效/,
  );
  assert.throws(() => ScheduleRuleSchema.parse({ kind: "unknown" }));
});

test("createScheduledTask 生成短 id 与 active 状态", () => {
  const task = createScheduledTask({
    creatorOpenId: "ou_x",
    chatId: "oc_x",
    targetBotId: "developer",
    prompt: "检查日志",
    rule: { kind: "interval", everyMs: 3600_000 },
  });
  assert.match(task.id, /^[a-z0-9]{12}$/);
  assert.equal(task.status, "active");
  assert.ok(task.createdAt);
});

test("scheduleDescription 把规则转成可读描述", () => {
  assert.equal(
    scheduleDescription({ kind: "interval", everyMs: 3600_000 }),
    "每 1 小时",
  );
  assert.equal(
    scheduleDescription({ kind: "interval", everyMs: 86400_000 }),
    "每 1 天",
  );
  assert.equal(
    scheduleDescription({ kind: "cron", expression: "0 9 * * *", timezone: "Asia/Shanghai" }),
    "Cron 0 9 * * *",
  );
  assert.match(
    scheduleDescription({ kind: "once", runAt: "2026-09-01T09:00:00.000Z" }),
    /一次性/,
  );
});

// ---------- 调度器 ----------

function fixedNow(iso = "2026-09-01T00:00:00.000Z") {
  let current = Date.parse(iso);
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms;
    },
  };
}

function createFakeDispatcher() {
  const calls: Array<{ task: ScheduledTask; scheduledFor: string }> = [];
  let block = false;
  const blockers = new Map<string, () => void>();
  const dispatcher: ScheduledTaskDispatcher = async (task, scheduledFor) => {
    calls.push({ task, scheduledFor });
    if (block) {
      await new Promise<void>((resolve) =>
        blockers.set(`${task.id}:${scheduledFor}`, resolve),
      );
    }
    return { sessionId: `sess-${task.id}` };
  };
  return {
    calls,
    dispatcher,
    block() {
      block = true;
    },
    release(taskId: string, scheduledFor: string) {
      blockers.get(`${taskId}:${scheduledFor}`)?.();
      blockers.delete(`${taskId}:${scheduledFor}`);
    },
  };
}

function captureTimeouts(t: test.TestContext) {
  interface CapturedTimer {
    callback: () => void;
    delay: number;
    active: boolean;
    handle: NodeJS.Timeout;
  }
  const timers: CapturedTimer[] = [];
  t.mock.method(
    globalThis,
    "setTimeout",
    ((callback: () => void, delay = 0) => {
      const handle = {
        unref() {
          return handle;
        },
      } as unknown as NodeJS.Timeout;
      timers.push({ callback, delay, active: true, handle });
      return handle;
    }) as typeof setTimeout,
  );
  t.mock.method(
    globalThis,
    "clearTimeout",
    ((handle: NodeJS.Timeout) => {
      const timer = timers.find((candidate) => candidate.handle === handle);
      if (timer) timer.active = false;
    }) as typeof clearTimeout,
  );
  return {
    active() {
      return timers.filter((timer) => timer.active);
    },
    fireNext() {
      const timer = timers.find((candidate) => candidate.active);
      assert.ok(timer, "应存在待触发的定时器");
      timer.active = false;
      timer.callback();
      return timer;
    },
  };
}

function intervalOptions(overrides: Partial<Parameters<Scheduler["create"]>[0]> = {}) {
  return {
    creatorOpenId: "ou_owner",
    chatId: "oc_chat",
    targetBotId: "developer",
    prompt: "检查服务日志",
    rule: { kind: "interval" as const, everyMs: 60_000 },
    ...overrides,
  };
}

test("Scheduler create/list/pause/resume", () => {
  const clock = fixedNow();
  const store = new ScheduleStore();
  const runStore = new ScheduleRunStore();
  const fake = createFakeDispatcher();
  const scheduler = new Scheduler({
    scheduleStore: store,
    runStore,
    dispatcher: fake.dispatcher,
    now: clock.now,
  });
  const task = scheduler.create(intervalOptions());
  assert.equal(scheduler.list().length, 1);
  assert.equal(task.status, "active");

  assert.equal(scheduler.pause(task.id)?.status, "paused");
  assert.equal(scheduler.resume(task.id)?.status, "active");
});

test("Scheduler delete/removeMany/removeAll", () => {
  const scheduler = new Scheduler({
    scheduleStore: new ScheduleStore(),
    runStore: new ScheduleRunStore(),
    dispatcher: async () => ({}),
  });
  const a = scheduler.create(intervalOptions());
  const b = scheduler.create(intervalOptions());
  assert.equal(scheduler.removeMany([a.id, b.id]), 2);
  scheduler.create(intervalOptions());
  assert.equal(scheduler.removeAll(), 1);
  assert.equal(scheduler.list().length, 0);
});

test("30 天后的 once 任务分段等待，不会被当成 1ms 立即触发", (t) => {
  const clock = fixedNow();
  const timers = captureTimeouts(t);
  const fake = createFakeDispatcher();
  const scheduler = new Scheduler({
    scheduleStore: new ScheduleStore(),
    runStore: new ScheduleRunStore(),
    dispatcher: fake.dispatcher,
    now: clock.now,
  });
  const task = scheduler.create(
    intervalOptions({
      rule: { kind: "once", runAt: "2026-10-01T00:00:00.000Z" },
    }),
  );

  assert.equal(
    scheduler.list().find((candidate) => candidate.id === task.id)?.nextRunAt,
    "2026-10-01T00:00:00.000Z",
  );
  assert.equal(timers.active()[0]?.delay, 2_147_483_647);
  timers.fireNext();
  assert.equal(fake.calls.length, 0);
  assert.equal(timers.active()[0]?.delay, 2_147_483_647);
  scheduler.stop();
});

test("周期任务按计划时间排下一轮，重叠轮次记为 skipped", async (t) => {
  const clock = fixedNow();
  const timers = captureTimeouts(t);
  const runStore = new ScheduleRunStore();
  const fake = createFakeDispatcher();
  fake.block();
  const scheduler = new Scheduler({
    scheduleStore: new ScheduleStore(),
    runStore,
    dispatcher: fake.dispatcher,
    now: clock.now,
  });
  const task = scheduler.create(intervalOptions());

  clock.advance(60_000);
  timers.fireNext();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fake.calls[0]?.scheduledFor, "2026-09-01T00:01:00.000Z");
  assert.equal(
    scheduler.list()[0]?.nextRunAt,
    "2026-09-01T00:02:00.000Z",
  );

  clock.advance(60_000);
  timers.fireNext();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fake.calls.length, 1);
  assert.ok(runStore.list(task.id).some((run) => run.status === "skipped"));

  fake.release(task.id, "2026-09-01T00:01:00.000Z");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(runStore.list(task.id).some((run) => run.status === "succeeded"));
  scheduler.stop();
});

test("runNow 立即执行一次并写入运行记录", async () => {
  const clock = fixedNow();
  const runStore = new ScheduleRunStore();
  const fake = createFakeDispatcher();
  const scheduler = new Scheduler({
    scheduleStore: new ScheduleStore(),
    runStore,
    dispatcher: fake.dispatcher,
    now: clock.now,
  });
  const task = scheduler.create(intervalOptions());
  const result = await scheduler.runNow(task.id);

  assert.ok(result);
  assert.equal(fake.calls.length, 1);
  const runs = runStore.list(task.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.status, "succeeded");
  assert.ok(runs[0]?.taskId);
});

test("trigger 幂等：同一 scheduledFor 只执行一次", async () => {
  const clock = fixedNow();
  const runStore = new ScheduleRunStore();
  const fake = createFakeDispatcher();
  const scheduler = new Scheduler({
    scheduleStore: new ScheduleStore(),
    runStore,
    dispatcher: fake.dispatcher,
    now: clock.now,
  });
  const task = scheduler.create(
    intervalOptions({ rule: { kind: "once", runAt: "2026-09-02T00:00:00.000Z" } }),
  );
  await scheduler.runNow(task.id);
  await scheduler.runNow(task.id);
  assert.equal(fake.calls.length, 1);
});

test("并发跳过：上一轮未跑完时本轮记 skipped 且不执行", async () => {
  const clock = fixedNow();
  const runStore = new ScheduleRunStore();
  const fake = createFakeDispatcher();
  const scheduler = new Scheduler({
    scheduleStore: new ScheduleStore(),
    runStore,
    dispatcher: fake.dispatcher,
    now: clock.now,
  });
  const task = scheduler.create(intervalOptions());
  fake.block();
  const first = scheduler.runNow(task.id);
  clock.advance(1);
  const second = scheduler.runNow(task.id);
  // 释放第一轮，让两条 runNow 都能收尾。
  fake.release(task.id, "2026-09-01T00:00:00.000Z");
  await Promise.all([first, second]);

  assert.equal(fake.calls.length, 1);
  const runs = runStore.list(task.id);
  assert.equal(runs.length, 2);
  assert.ok(runs.some((run) => run.status === "succeeded"));
  assert.ok(runs.some((run) => run.status === "skipped"));
});

test("once 任务执行后置为 completed", async () => {
  const clock = fixedNow();
  const scheduler = new Scheduler({
    scheduleStore: new ScheduleStore(),
    runStore: new ScheduleRunStore(),
    dispatcher: async () => ({}),
    now: clock.now,
  });
  const task = scheduler.create(
    intervalOptions({ rule: { kind: "once", runAt: "2026-09-02T00:00:00.000Z" } }),
  );
  await scheduler.runNow(task.id);
  assert.equal(scheduler.list()[0]?.status, "completed");
});

test("start 恢复：running 记录标记 failed，过期 once 记 skipped 并 completed", async () => {
  const clock = fixedNow();
  const store = new ScheduleStore();
  const runStore = new ScheduleRunStore();
  const fake = createFakeDispatcher();
  const scheduler = new Scheduler({
    scheduleStore: store,
    runStore,
    dispatcher: fake.dispatcher,
    now: clock.now,
  });
  const interval = scheduler.create(intervalOptions());
  runStore.create(interval.id, "2026-08-31T12:00:00.000Z");
  const expired = scheduler.create(
    intervalOptions({ rule: { kind: "once", runAt: "2026-08-31T00:00:00.000Z" } }),
  );

  await scheduler.start();

  const intervalRuns = runStore.list(interval.id);
  assert.equal(intervalRuns[0]?.status, "failed");
  assert.equal(store.get(expired.id)?.status, "completed");
  const expiredRuns = runStore.list(expired.id);
  assert.equal(expiredRuns[0]?.status, "skipped");
});

// ---------- 持久化 ----------

test("JsonScheduleStore 持久化并过滤坏记录", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "threadpilot-sched-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, "schedules.json");
  const store = new JsonScheduleStore(filePath);
  store.create(
    intervalOptions({ rule: { kind: "cron", expression: "0 9 * * *", timezone: "Asia/Shanghai" } }),
  );

  const rows = JSON.parse(await readFile(filePath, "utf8"));
  rows.push({ id: "", prompt: "" });
  await writeFile(filePath, JSON.stringify(rows), "utf8");

  const restored = new JsonScheduleStore(filePath);
  assert.equal(restored.list().length, 1);
  assert.equal((await readFile(filePath, "utf8")).endsWith("\n"), true);
});

test("非法 Cron 在写入前拒绝，内存与 schedules.json 均不变", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "threadpilot-sched-invalid-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, "schedules.json");
  const store = new JsonScheduleStore(filePath);
  const invalidRule = {
    kind: "cron",
    expression: "61 * * * *",
    timezone: "Asia/Shanghai",
  } as ScheduledTask["rule"];

  assert.throws(
    () => store.create(intervalOptions({ rule: invalidRule })),
    /Cron 表达式无效/,
  );
  assert.deepEqual(store.list(), []);
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), []);

  const task = store.create(intervalOptions());
  const before = await readFile(filePath, "utf8");
  assert.throws(() => store.update(task.id, { rule: invalidRule }));
  assert.equal(store.get(task.id)?.rule.kind, "interval");
  assert.equal(await readFile(filePath, "utf8"), before);
});

test("JsonScheduleRunStore 持久化运行记录", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "threadpilot-sched-runs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, "schedule-runs.json");
  const store = new JsonScheduleRunStore(filePath);
  const run = store.create("abc123", "2026-09-01T00:00:00.000Z");
  assert.ok(run);
  store.markSucceeded(run.id, "task-1");

  const restored = new JsonScheduleRunStore(filePath);
  const runs = restored.list("abc123");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.status, "succeeded");
  assert.equal(runs[0]?.taskId, "task-1");
});

// ---------- watcher ----------

test("reconcileScheduleFile 做新增/更新/删除差异合并", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "threadpilot-sched-watch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, "schedules.json");
  const scheduler = new Scheduler({
    scheduleStore: new ScheduleStore(),
    runStore: new ScheduleRunStore(),
    dispatcher: async () => ({}),
  });
  const keep = scheduler.create(intervalOptions({ id: "keep" }));
  scheduler.create(intervalOptions({ id: "gone" }));

  const fileTasks = [
    {
      ...keep,
      targetBotId: "reviewer",
      updatedAt: new Date().toISOString(),
    },
  ];
  await writeFile(filePath, JSON.stringify(fileTasks), "utf8");

  const changes = reconcileScheduleFile(scheduler, filePath);
  assert.deepEqual(changes, ["删除 gone", "更新 keep"]);
  assert.equal(scheduler.list().length, 1);
  assert.equal(scheduler.list()[0]?.targetBotId, "reviewer");
});

// ---------- schedule_manage 分发 ----------

test("executeScheduleManageRequest 各 action 返回真实结果", async () => {
  const clock = fixedNow();
  const store = new ScheduleStore();
  const runStore = new ScheduleRunStore();
  const scheduler = new Scheduler({
    scheduleStore: store,
    runStore,
    dispatcher: async () => ({}),
    now: clock.now,
  });
  const context = {
    scheduler,
    runStore,
    chatId: "oc_chat",
    creatorOpenId: "ou_owner",
    isTargetBotAllowed: () => true,
  };

  const emptyList = await executeScheduleManageRequest({ action: "list" }, context);
  assert.equal(emptyList.notice, "当前没有定时任务。");

  const added = await executeScheduleManageRequest(
    { action: "add", targetBotId: "developer", prompt: "检查日志", rule: { kind: "interval", everyMs: 3600_000 } },
    context,
  );
  assert.match(added.notice, /已创建/);
  assert.match(added.notice, /下次 2026-09-01T01:00:00.000Z/);

  const listed = await executeScheduleManageRequest({ action: "list" }, context);
  assert.match(listed.notice, /当前共 1 个定时任务/);
  assert.equal(listed.schedules?.length, 1);

  const removed = await executeScheduleManageRequest(
    { action: "remove", id: "missing" },
    context,
  );
  assert.equal(removed.notice, "没有找到定时任务 missing。");
});

test("schedule_manage 按 chat 与创建人隔离，批量创建先校验全部目标成员", async () => {
  const scheduler = new Scheduler({
    scheduleStore: new ScheduleStore(),
    runStore: new ScheduleRunStore(),
    dispatcher: async () => ({}),
  });
  const own = scheduler.create(intervalOptions({ id: "own" }));
  const otherOwner = scheduler.create(
    intervalOptions({ id: "other-owner", creatorOpenId: "ou_other" }),
  );
  const otherChat = scheduler.create(
    intervalOptions({ id: "other-chat", chatId: "oc_other" }),
  );
  const runStore = new ScheduleRunStore();
  const context = {
    scheduler,
    runStore,
    chatId: "oc_chat",
    creatorOpenId: "ou_owner",
    isTargetBotAllowed: (targetBotId: string) => targetBotId === "developer",
  };

  const listed = await executeScheduleManageRequest({ action: "list" }, context);
  assert.deepEqual(listed.schedules?.map((task) => task.id), [own.id]);

  const hidden = await executeScheduleManageRequest(
    { action: "pause", id: otherOwner.id },
    context,
  );
  assert.equal(hidden.notice, `没有找到定时任务 ${otherOwner.id}。`);
  assert.equal(scheduler.list().find((task) => task.id === otherOwner.id)?.status, "active");

  await assert.rejects(
    executeScheduleManageRequest(
      {
        action: "addMany",
        schedules: [
          {
            targetBotId: "developer",
            prompt: "有效计划",
            rule: { kind: "interval", everyMs: 60_000 },
          },
          {
            targetBotId: "missing-bot",
            prompt: "无效计划",
            rule: { kind: "interval", everyMs: 60_000 },
          },
        ],
      },
      context,
    ),
    /目标成员未注册或未启用/,
  );
  assert.equal(scheduler.list().length, 3, "批量校验失败前不能创建部分计划");

  await executeScheduleManageRequest(
    { action: "removeAll", confirm: true },
    context,
  );
  assert.deepEqual(
    scheduler.list().map((task) => task.id).sort(),
    [otherChat.id, otherOwner.id].sort(),
  );
});

test("ScheduleManageRequestSchema 约束批量删除与 removeAll 的 confirm", () => {
  assert.deepEqual(
    ScheduleManageRequestSchema.parse({ action: "removeAll", confirm: true }),
    { action: "removeAll", confirm: true },
  );
  assert.throws(
    () => ScheduleManageRequestSchema.parse({ action: "removeAll" }),
  );
  assert.throws(
    () => ScheduleManageRequestSchema.parse({ action: "addMany", schedules: [] }),
  );
  assert.equal(SCHEDULE_MANAGE_TOOL_NAME, "schedule_manage");
});

// ---------- 命令路由端到端 ----------

function createFakeBot() {
  const calls = { sends: [] as string[], replies: [] as string[], cards: [] as unknown[] };
  const bot = {
    client: {},
    getIdentity: async () => ({ openId: "bot_open", name: "TestBot" }) as BotIdentity,
    send: async (_chatId: string, text: string) => {
      calls.sends.push(text);
      return `send-${calls.sends.length}`;
    },
    reply: async (_id: string, text: string) => {
      calls.replies.push(text);
      return `msg-${calls.replies.length}`;
    },
    replyCard: async (_id: string, card: unknown) => {
      calls.cards.push(card);
      return "card-1";
    },
    replyMention: async () => "mention-1",
    sendResultNotification: async () => undefined,
    updateCard: async () => undefined,
    downloadResource: async () => "downloads/x",
  } as unknown as Bot;
  return { bot, calls };
}

class FakeLarkService extends Service {
  runtimes = new Map<string, BotRuntime>();

  constructor(ctx: Context) {
    super(ctx, "lark");
  }

  bot(id: string): BotRuntime | undefined {
    return this.runtimes.get(id);
  }
}

class FakeTasksService extends Service {
  started: StartTaskInput[] = [];
  startSucceeds = true;

  constructor(ctx: Context) {
    super(ctx, "tasks");
  }

  async startTask(input: StartTaskInput): Promise<boolean> {
    this.started.push(input);
    return this.startSucceeds;
  }
}

const baseBotConfig: BotConfig = {
  id: "testbot",
  appId: "cli_test",
  appSecret: "secret",
  defaultCliId: "codex",
  accessMode: "headless",
  role: "",
  skills: [],
  systemPrompt: "",
  workspaceDir: process.cwd(),
  collaborationMaxRounds: 2,
};

class FakeConfigService extends Service {
  readonly bots: BotConfig[];
  readonly defaultWorkspaces: Record<string, string>;
  readonly defaultProductDeliveryMode = "lark-doc" as const;

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

/** 用真实 router + 命令插件 + 调度器组装完整命令链路。 */
async function createRoutedHost(t: test.TestContext) {
  const root = new Context();
  const fakeBot = createFakeBot();
  new FakeConfigService(root, [baseBotConfig]);
  new FakeCliService(root);
  const lark = new FakeLarkService(root);
  const tasks = new FakeTasksService(root);
  const dir = await mkdtemp(join(tmpdir(), "threadpilot-schedule-"));
  const manager = await SessionManager.open({
    store: new JsonSessionStore(join(dir, "sessions.json")),
  });
  new SessionsService(root).init(manager);
  // 测试未 start() 上下文，root.plugin 只注册不启动；显式构造服务实例。
  new cardsPlugin.CardsService(root);
  new commandsPlugin.CommandsService(root);
  new collaborationPlugin.CollaborationService(root);
  const runStore = new JsonScheduleRunStore(join(dir, "schedule-runs.json"));
  const scheduler = new Scheduler({
    scheduleStore: new JsonScheduleStore(join(dir, "schedules.json")),
    runStore,
    dispatcher: async () => ({}),
  });
  new ScheduleService(root, scheduler, runStore);
  scheduleCommand.apply(root);
  schedulesCommand.apply(root);
  routerPlugin.apply(root);
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  lark.runtimes.set("testbot", {
    config: baseBotConfig,
    bot: fakeBot.bot,
    identity: { openId: "bot_open", name: "TestBot" },
  });

  return { root, scheduler, tasks, bot: fakeBot.bot, calls: fakeBot.calls };
}

test("/schedule 自然语言经 router 启动任务并引导 schedule_manage", async (t) => {
  const host = await createRoutedHost(t);
  await host.root.parallel(
    "bot/message",
    incomingMessage("/schedule 每小时检查一次服务日志"),
    host.bot,
    baseBotConfig,
  );

  assert.equal(host.tasks.started.length, 1);
  const requested = host.tasks.started[0]!.requestedPrompt;
  assert.ok(requested.includes("每小时检查一次服务日志"));
  assert.ok(requested.includes("schedule_manage"));
});

test("/schedules 经 router 回复列表卡片", async (t) => {
  const host = await createRoutedHost(t);
  host.scheduler.create({
    creatorOpenId: "ou_owner",
    chatId: "oc_chat",
    targetBotId: "testbot",
    prompt: "检查日志",
    rule: { kind: "interval", everyMs: 3600_000 },
  });
  await host.root.parallel(
    "bot/message",
    incomingMessage("/schedules"),
    host.bot,
    baseBotConfig,
  );

  assert.equal(host.calls.cards.length, 1);
  assert.equal(host.tasks.started.length, 0);
});

test("/schedule pause 直接暂停计划", async (t) => {
  const host = await createRoutedHost(t);
  const task = host.scheduler.create({
    creatorOpenId: "ou_owner",
    chatId: "oc_chat",
    targetBotId: "testbot",
    prompt: "检查日志",
    rule: { kind: "interval", everyMs: 3600_000 },
  });
  await host.root.parallel(
    "bot/message",
    incomingMessage(`/schedule pause ${task.id}`),
    host.bot,
    baseBotConfig,
  );

  assert.equal(host.scheduler.list()[0]?.status, "paused");
  assert.equal(host.tasks.started.length, 0);
});

test("/schedule 不能管理其他创建人的计划", async (t) => {
  const host = await createRoutedHost(t);
  const task = host.scheduler.create({
    creatorOpenId: "ou_other",
    chatId: "oc_chat",
    targetBotId: "testbot",
    prompt: "检查日志",
    rule: { kind: "interval", everyMs: 3600_000 },
  });
  await host.root.parallel(
    "bot/message",
    incomingMessage(`/schedule pause ${task.id}`),
    host.bot,
    baseBotConfig,
  );

  assert.equal(host.scheduler.list()[0]?.status, "active");
  assert.equal(host.calls.replies.at(-1), `没有找到定时任务 ${task.id}。`);
});

test("/schedule run 触发一次执行", async (t) => {
  const host = await createRoutedHost(t);
  const task = host.scheduler.create({
    creatorOpenId: "ou_owner",
    chatId: "oc_chat",
    targetBotId: "testbot",
    prompt: "检查日志",
    rule: { kind: "interval", everyMs: 3600_000 },
  });
  await host.root.parallel(
    "bot/message",
    incomingMessage(`/schedule run ${task.id}`),
    host.bot,
    baseBotConfig,
  );

  assert.equal(host.tasks.started.length, 0);
  assert.ok(host.scheduler.list()[0]?.lastRunAt);
});
