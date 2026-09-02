/**
 * bitable-board 插件集成测试：用假 Bitable 客户端与假服务装配 Cordis 上下文，
 * 验证事件同步、节流合并、失败重试与反向拉起轮询的行为，不依赖真实飞书。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Context, Service } from "cordis";
import { SessionManager } from "../core/session-manager.js";
import {
  BOARD_STATES,
  DEFAULT_BOARD_FIELDS,
  type BoardRecord,
  type BoardState,
} from "../core/bitable-board.js";
import type { BotConfig } from "../core/bot-registry.js";
import type { CollaborationMessage } from "../core/collaboration.js";
import type { Session } from "../core/session-manager.js";
import type { Bot, BotIdentity } from "../im/lark.js";
import type {
  QAResultPayload,
  StartTaskInput,
  TaskResultPayload,
} from "./types.js";
import {
  BitableBoardService,
  BoardService,
  apply as applyBitableBoard,
  createBitableRecordClient,
  loadBoardStorage,
  saveBoardStorage,
  type BitableRecordClient,
} from "./bitable-board.js";
import { rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

class FakeConfigService extends Service {
  readonly bots: BotConfig[];

  constructor(ctx: Context, bots: BotConfig[]) {
    super(ctx, "config");
    this.bots = bots;
  }

  bot(id: string): BotConfig | undefined {
    return this.bots.find((bot) => bot.id === id);
  }
}

class FakeLarkService extends Service {
  runtimes = new Map<string, { config: BotConfig; bot: Bot }>();

  constructor(ctx: Context) {
    super(ctx, "lark");
  }

  bot(id: string): { config: BotConfig; bot: Bot } | undefined {
    return this.runtimes.get(id);
  }
}

class FakeSessionsService extends Service {
  readonly manager = new SessionManager();

  constructor(ctx: Context) {
    super(ctx, "sessions");
  }
}

class FakeTasksService extends Service {
  readonly started: StartTaskInput[] = [];

  constructor(
    ctx: Context,
    private readonly succeeds: boolean,
  ) {
    super(ctx, "tasks");
  }

  async startTask(input: StartTaskInput): Promise<boolean> {
    this.started.push(input);
    return this.succeeds;
  }
}

function createBotConfig(id = "developer"): BotConfig {
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

function createSession(botId = "developer"): Session {
  return {
    id: "sess-001",
    botId,
    chatId: "chat-001",
    threadId: "thread-001",
    workspaceDir: "/workspace",
    cliId: "codex",
    accessMode: "headless",
    status: "idle",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** 记录出站调用的假 Bitable 客户端；用内存表模拟记录读写。 */
function createFakeClient() {
  const calls = {
    lists: 0,
    creates: [] as Record<string, unknown>[],
    createTokens: [] as string[],
    updates: [] as { recordId: string; fields: Record<string, unknown> }[],
  };
  let nextCreateError: unknown;
  let nextCreateResponseError: unknown;
  let nextListError: unknown;
  let nextListRecords: BoardRecord[] | undefined;
  const store = new Map<string, Record<string, unknown>>();
  const recordsByToken = new Map<string, string>();
  const client: BitableRecordClient = {
    async list() {
      calls.lists += 1;
      if (nextListError !== undefined) {
        const error = nextListError;
        nextListError = undefined;
        throw error;
      }
      if (nextListRecords) {
        const records = nextListRecords;
        nextListRecords = undefined;
        return records;
      }
      return [...store.entries()].map(([recordId, fields]) => ({
        recordId,
        taskId: (fields[DEFAULT_BOARD_FIELDS.taskId] as string) ?? "",
        title: (fields[DEFAULT_BOARD_FIELDS.title] as string) ?? "",
        bot: (fields[DEFAULT_BOARD_FIELDS.bot] as string) ?? "",
        owner: (fields[DEFAULT_BOARD_FIELDS.owner] as string) ?? "",
        state: Array.isArray(fields[DEFAULT_BOARD_FIELDS.state])
          ? (fields[DEFAULT_BOARD_FIELDS.state] as string[])[0]
          : ((fields[DEFAULT_BOARD_FIELDS.state] as string) ?? ""),
        chatId: (fields[DEFAULT_BOARD_FIELDS.chatId] as string) ?? "",
      }));
    },
    async create(fields, clientToken) {
      calls.creates.push(fields);
      calls.createTokens.push(clientToken);
      if (nextCreateError !== undefined) {
        const error = nextCreateError;
        nextCreateError = undefined;
        throw error;
      }
      const existingRecordId = recordsByToken.get(clientToken);
      if (existingRecordId) return { recordId: existingRecordId };
      const recordId = `rec-${recordsByToken.size + 1}`;
      recordsByToken.set(clientToken, recordId);
      store.set(recordId, fields);
      if (nextCreateResponseError !== undefined) {
        const error = nextCreateResponseError;
        nextCreateResponseError = undefined;
        throw error;
      }
      return { recordId };
    },
    async update(recordId, fields) {
      calls.updates.push({ recordId, fields });
      const merged = { ...(store.get(recordId) ?? {}), ...fields };
      store.set(recordId, merged);
    },
  };
  return {
    client,
    calls,
    store,
    failNextCreate(error: unknown) {
      nextCreateError = error;
    },
    loseNextCreateResponse(error: unknown) {
      nextCreateResponseError = error;
    },
    failNextList(error: unknown) {
      nextListError = error;
    },
    seedList(records: BoardRecord[]) {
      nextListRecords = records;
    },
  };
}

function createFakeBot() {
  const sends: string[] = [];
  const bot = {
    client: {},
    send: async (chatId: string, text: string) => {
      sends.push(`${chatId}:${text}`);
      return `msg-${sends.length}`;
    },
    getIdentity: async () => ({ openId: "bot_open", name: "TestBot" }) as BotIdentity,
  } as unknown as Bot;
  return { bot, sends };
}

function setup(options: {
  sync?: boolean;
  pull?: boolean;
  fallbackChatId?: string;
  bots?: BotConfig[];
  client?: BitableRecordClient;
  maxRetries?: number;
  taskStartSucceeds?: boolean;
  autoMount?: boolean;
  storagePath?: string;
} = {}) {
  const root = new Context();
  const bots = options.bots ?? [createBotConfig("developer")];
  const config = new FakeConfigService(root, bots);
  const lark = new FakeLarkService(root);
  const sessions = new FakeSessionsService(root);
  const tasks = new FakeTasksService(root, options.taskStartSucceeds ?? true);
  const fakeBot = createFakeBot();
  for (const botConfig of bots) {
    lark.runtimes.set(botConfig.id, { config: botConfig, bot: fakeBot.bot });
  }
  const fakeClient = createFakeClient();
  const client = options.client ?? fakeClient.client;
  const service = new BitableBoardService(root, {
    appToken: "appToken",
    tableId: "tbl001",
    sync: options.sync ?? true,
    pull: options.pull ?? false,
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    ...(options.fallbackChatId ? { fallbackChatId: options.fallbackChatId } : {}),
    ...(options.storagePath ? { storagePath: options.storagePath } : {}),
  });
  if (options.autoMount !== false) {
    void service.mount(
      {
        appToken: "appToken",
        tableId: "tbl001",
        saveToStorage: false,
      },
      client,
    );
  }
  return {
    root,
    config,
    lark,
    sessions,
    tasks,
    service,
    fakeClient,
    bot: fakeBot.bot,
    sends: fakeBot.sends,
    bots,
  };
}

function resultPayload(overrides: Partial<TaskResultPayload> = {}): TaskResultPayload {
  return {
    bot: {} as Bot,
    botConfig: createBotConfig("developer"),
    session: createSession("developer"),
    requestedPrompt: "修复登录超时问题",
    answer: "已修复",
    replyToMessageId: "msg-001",
    hasThread: true,
    taskId: "task-001",
    durationMs: 30000,
    stats: { totalTokens: 1200 },
    toolCalls: [],
    traceId: "trace-result-1",
    ...overrides,
  };
}

function qaCollaboration(stage: "review" | "rework"): CollaborationMessage {
  return {
    dispatchId: `dispatch-${stage}`,
    taskId: "task-qa",
    ownerOpenId: "ou_user1",
    fromBotId: stage === "review" ? "developer" : "qa",
    toBotId: stage === "review" ? "qa" : "developer",
    reportToBotId: "developer",
    objective: "完成开发并通过 QA",
    instruction: "执行当前 QA 阶段",
    round: stage === "review" ? 1 : 2,
    maxRounds: 4,
    workspaceDir: "/workspace",
    qaReview: {
      stage,
      developerBotId: "developer",
      reviewerBotId: "qa",
      originalPrompt: "实现功能",
      sourceWorkspaceDir: "/workspace",
      snapshotWorkspaceDir: "/snapshot",
      revision: "rev-1",
    },
  };
}

test("task/result 事件为新任务创建看板记录", async () => {
  const { root, service, fakeClient } = setup();
  await service.init();
  const payload = resultPayload({ taskId: "task-001" });
  await root.parallel("task/result", payload);
  await service.flushNow();
  assert.equal(fakeClient.calls.creates.length, 1);
  const fields = fakeClient.calls.creates[0];
  assert.equal(fields[DEFAULT_BOARD_FIELDS.taskId], "task-001");
  assert.equal(fields[DEFAULT_BOARD_FIELDS.state], BOARD_STATES.DONE);
  assert.equal(fields[DEFAULT_BOARD_FIELDS.tokens], 1200);
  assert.equal(fields[DEFAULT_BOARD_FIELDS.duration], 30000);
  service.stop();
});

test("配置 reviewBy 的顶层 Developer 结果等待 QA 而不提前完成", async () => {
  const { root, service, fakeClient } = setup();
  await service.init();
  await root.parallel("task/result", resultPayload({
    taskId: "task-review",
    botConfig: { ...createBotConfig("developer"), reviewBy: "qa" },
  }));
  await service.flushNow();
  assert.equal(
    fakeClient.calls.creates[0][DEFAULT_BOARD_FIELDS.state],
    BOARD_STATES.QA,
  );
  service.stop();
});

test("suppressHandoff 时即使配置 reviewBy 也标记已完成而非 QA验收中", async () => {
  // qa-gate 对 suppressHandoff 的任务直接跳过 QA；看板状态必须与其一致，
  // 否则任务会永久卡在“QA验收中”而等不到 qa/result。
  const { root, service, fakeClient } = setup();
  await service.init();
  await root.parallel("task/result", resultPayload({
    taskId: "task-suppress",
    botConfig: { ...createBotConfig("developer"), reviewBy: "qa" },
    suppressHandoff: true,
  }));
  await service.flushNow();
  assert.equal(
    fakeClient.calls.creates[0][DEFAULT_BOARD_FIELDS.state],
    BOARD_STATES.DONE,
  );
  service.stop();
});

test("QA 审查开始显示验收中，Developer 返工开始恢复开发中", async () => {
  const { root, service, fakeClient } = setup({
    bots: [createBotConfig("developer"), createBotConfig("qa")],
  });
  await service.init();
  await root.parallel("task/started", {
    botConfig: createBotConfig("qa"),
    session: createSession("qa"),
    taskId: "task-qa",
    traceId: "trace-review",
    startedAt: Date.now(),
    requestedPrompt: "执行 QA",
    collaboration: qaCollaboration("review"),
  });
  await service.flushNow();
  assert.equal(
    fakeClient.calls.creates[0][DEFAULT_BOARD_FIELDS.state],
    BOARD_STATES.QA,
  );

  await root.parallel("task/started", {
    botConfig: createBotConfig("developer"),
    session: createSession("developer"),
    taskId: "task-qa",
    traceId: "trace-rework",
    startedAt: Date.now(),
    requestedPrompt: "修复 QA 问题",
    collaboration: qaCollaboration("rework"),
  });
  await service.flushNow();
  assert.equal(
    fakeClient.calls.updates.at(-1)?.fields[DEFAULT_BOARD_FIELDS.state],
    BOARD_STATES.DEV,
  );
  service.stop();
});

test("同一任务后续事件更新已有记录而不是重复创建", async () => {
  const { root, service, fakeClient } = setup();
  await service.init();
  await root.parallel("task/result", resultPayload({ taskId: "task-001" }));
  await service.flushNow();
  await root.parallel("task/failed", resultPayload({ taskId: "task-001" }));
  await service.flushNow();
  assert.equal(fakeClient.calls.creates.length, 1);
  assert.equal(fakeClient.calls.updates.length, 1);
  assert.equal(
    fakeClient.calls.updates[0].fields[DEFAULT_BOARD_FIELDS.state],
    BOARD_STATES.FAILED,
  );
  service.stop();
});

test("节流窗口内同一任务只保留最新状态写入一次", async () => {
  const { root, service, fakeClient } = setup();
  await service.init();
  await root.parallel("task/started", {
    botConfig: createBotConfig(),
    session: createSession(),
    taskId: "task-002",
    traceId: "trace-1",
    startedAt: Date.now(),
  });
  await root.parallel("task/tool-calls", {
    ...resultPayload({ taskId: "task-002" }),
    senderOpenId: "ou_user1",
    result: { answer: "", toolCalls: [{ toolUseId: "u1", toolName: "read_file", input: {} }] },
    runId: "run-1",
    cardMessageId: "card-1",
  });
  await root.parallel("task/result", resultPayload({ taskId: "task-002" }));
  await service.flushNow();
  assert.equal(fakeClient.calls.creates.length, 1);
  assert.equal(
    fakeClient.calls.creates[0][DEFAULT_BOARD_FIELDS.state],
    BOARD_STATES.DONE,
  );
  service.stop();
});

test("QA 紧接开发结果时保留稳定标题、产物和累计指标", async () => {
  const { root, service, fakeClient } = setup({
    bots: [createBotConfig("developer"), createBotConfig("qa")],
  });
  await service.init();
  const taskId = "task-aggregate";
  await root.parallel("task/result", resultPayload({
    taskId,
    botConfig: { ...createBotConfig("developer"), reviewBy: "qa" },
    toolCalls: [{
      toolUseId: "tool-pr",
      toolName: "publish_pr",
      input: { url: "https://example.com/pr/42" },
    }],
    traceId: "trace-developer",
  }));
  await root.parallel("task/started", {
    botConfig: createBotConfig("qa"),
    session: createSession("qa"),
    taskId,
    traceId: "trace-qa",
    startedAt: Date.now(),
    requestedPrompt: "执行 QA 审查",
    senderOpenId: "ou_user1",
    collaboration: qaCollaboration("review"),
  });
  await service.flushNow();

  const created = fakeClient.calls.creates[0];
  assert.equal(created[DEFAULT_BOARD_FIELDS.title], "修复登录超时问题");
  assert.equal(created[DEFAULT_BOARD_FIELDS.bot], "qa");
  assert.equal(created[DEFAULT_BOARD_FIELDS.state], BOARD_STATES.QA);
  assert.equal(created[DEFAULT_BOARD_FIELDS.round], 1);
  assert.equal(created[DEFAULT_BOARD_FIELDS.artifact], "https://example.com/pr/42");
  assert.equal(created[DEFAULT_BOARD_FIELDS.tokens], 1200);
  assert.equal(created[DEFAULT_BOARD_FIELDS.duration], 30000);
  assert.equal(created[DEFAULT_BOARD_FIELDS.chatId], "chat-001");

  const qaPayload: QAResultPayload = {
    ...resultPayload({
      taskId,
      botConfig: createBotConfig("qa"),
      session: createSession("qa"),
      requestedPrompt: "执行 QA 审查",
      collaboration: qaCollaboration("review"),
      stats: { totalTokens: 300 },
      durationMs: 5000,
      traceId: "trace-qa",
    }),
    qaResult: {
      verdict: "pass",
      revision: "rev-1",
      tests: [],
      findings: [],
      nextAction: "close",
    },
  };
  await root.parallel("task/result", qaPayload);
  await root.parallel("qa/result", qaPayload);
  await service.flushNow();

  const updated = fakeClient.calls.updates.at(-1)?.fields;
  assert.equal(updated?.[DEFAULT_BOARD_FIELDS.state], BOARD_STATES.DONE);
  assert.equal(updated?.[DEFAULT_BOARD_FIELDS.title], "修复登录超时问题");
  assert.equal(updated?.[DEFAULT_BOARD_FIELDS.tokens], 1500);
  assert.equal(updated?.[DEFAULT_BOARD_FIELDS.duration], 35000);
  service.stop();
});

test("直接产品方案确认后完成，协作方案确认后继续开发", async () => {
  const { root, service, fakeClient, bot } = setup();
  await service.init();
  const baseFlow = {
    token: "flow-1",
    taskId: "task-direct-spec",
    botId: "developer",
    sessionId: "session-1",
    ownerOpenId: "ou_user1",
    workspaceDir: "/workspace",
    request: {
      deliveryMode: "lark-doc" as const,
      title: "登录方案",
      summary: "统一登录",
      documentUrl: "https://example.feishu.cn/docx/Abc123XYZ",
    },
    status: "approved" as const,
  };
  await root.parallel("product-spec/approved", {
    flow: baseFlow,
    bot,
    botConfig: createBotConfig(),
    replyToMessageId: "card-direct",
  });
  await service.flushNow();
  assert.equal(
    fakeClient.calls.creates[0][DEFAULT_BOARD_FIELDS.state],
    BOARD_STATES.DONE,
  );

  await root.parallel("product-spec/approved", {
    flow: {
      ...baseFlow,
      token: "flow-2",
      taskId: "task-collaboration-spec",
      collaboration: {
        taskId: "task-collaboration-spec",
        fromBotId: "leader",
        reportToBotId: "leader",
        round: 1,
        maxRounds: 4,
      },
    },
    bot,
    botConfig: createBotConfig(),
    replyToMessageId: "card-collaboration",
  });
  await service.flushNow();
  assert.equal(
    fakeClient.calls.creates[1][DEFAULT_BOARD_FIELDS.state],
    BOARD_STATES.DEV,
  );
  service.stop();
});

test("取消任务写入失败终态", async () => {
  const { root, service, fakeClient } = setup();
  await service.init();
  await root.parallel("task/cancelled", resultPayload({
    taskId: "task-cancelled",
    traceId: "trace-cancelled",
  }));
  await service.flushNow();
  assert.equal(
    fakeClient.calls.creates[0][DEFAULT_BOARD_FIELDS.state],
    BOARD_STATES.FAILED,
  );
  service.stop();
});

test("同步写失败后重试成功", async () => {
  const { root, service, fakeClient } = setup();
  await service.init();
  fakeClient.failNextCreate(new Error("模拟频控"));
  await root.parallel("task/result", resultPayload({ taskId: "task-003" }));
  await service.flushNow();
  assert.equal(fakeClient.calls.creates.length, 2, "失败后应重试一次成功");
  assert.equal(
    fakeClient.calls.createTokens[0],
    fakeClient.calls.createTokens[1],
    "同一次逻辑创建的重试必须复用 client_token",
  );
  service.stop();
});

test("服务端创建成功但响应丢失时重试不会重复建行", async () => {
  const { root, service, fakeClient } = setup();
  await service.init();
  fakeClient.loseNextCreateResponse(new Error("响应超时"));
  await root.parallel("task/result", resultPayload({ taskId: "task-idempotent" }));
  await service.flushNow();
  assert.equal(fakeClient.calls.creates.length, 2);
  assert.equal(fakeClient.store.size, 1, "相同 client_token 应命中同一条服务端记录");
  assert.equal(fakeClient.calls.createTokens[0], fakeClient.calls.createTokens[1]);
  service.stop();
});

test("首次扫描失败时暂存事件，索引恢复后再创建记录", async () => {
  const { root, service, fakeClient } = setup({ autoMount: false });
  fakeClient.failNextList(new Error("扫描暂时失败"));
  await service.mount(
    {
      appToken: "appToken",
      tableId: "tbl001",
      saveToStorage: false,
    },
    fakeClient.client,
  );
  await root.parallel("task/result", resultPayload({ taskId: "task-pending-scan" }));
  await service.flushNow();
  assert.equal(fakeClient.calls.creates.length, 0, "索引未就绪时不得盲目创建");

  await (service as unknown as { safeScan(): Promise<void> }).safeScan();
  await service.flushNow();
  assert.equal(fakeClient.calls.creates.length, 1);
  service.stop();
});

test("同步写重试耗尽后丢弃且不抛出", async () => {
  // maxRetries=0：第一次失败即丢弃，flush 不应向调用方抛异常。
  const { root, service, fakeClient } = setup({ maxRetries: 0 });
  await service.init();
  fakeClient.failNextCreate(new Error("持续失败"));
  await root.parallel("task/result", resultPayload({ taskId: "task-004" }));
  await service.flushNow();
  assert.equal(fakeClient.calls.creates.length, 1);
  service.stop();
});

test("正向同步优先复用表格空记录而不是追加新行", async () => {
  const { root, service, fakeClient } = setup({ autoMount: false });
  // 飞书建表默认预置空行：seed 两条空记录与一条已有任务记录。
  fakeClient.seedList([
    { recordId: "rec-empty-1", taskId: "", title: "", bot: "", owner: "", state: "", chatId: "" },
    { recordId: "rec-empty-2", taskId: "", title: "", bot: "", owner: "", state: "", chatId: "" },
    { recordId: "rec-existing", taskId: "task-existing", title: "已有任务", bot: "developer", owner: "", state: BOARD_STATES.DONE, chatId: "" },
  ]);
  await service.mount(
    { appToken: "appToken", tableId: "tbl001", saveToStorage: false },
    fakeClient.client,
  );

  await root.parallel("task/result", resultPayload({ taskId: "task-new" }));
  await service.flushNow();

  assert.equal(fakeClient.calls.creates.length, 0, "有空行时不应 create 追加");
  const reused = fakeClient.calls.updates.find(
    (update) => update.recordId === "rec-empty-1",
  );
  assert.ok(reused, "新任务应填入第一条空行");
  assert.equal(reused.fields[DEFAULT_BOARD_FIELDS.taskId], "task-new");
  assert.equal(reused.fields[DEFAULT_BOARD_FIELDS.state], BOARD_STATES.DONE);
  service.stop();
});

test("空行用尽后回退到 create 追加新行", async () => {
  const { root, service, fakeClient } = setup({ autoMount: false });
  fakeClient.seedList([
    { recordId: "rec-empty-1", taskId: "", title: "", bot: "", owner: "", state: "", chatId: "" },
  ]);
  await service.mount(
    { appToken: "appToken", tableId: "tbl001", saveToStorage: false },
    fakeClient.client,
  );

  await root.parallel("task/result", resultPayload({ taskId: "task-a" }));
  await service.flushNow();
  await root.parallel("task/result", resultPayload({ taskId: "task-b" }));
  await service.flushNow();

  // 第一条任务复用了空行，第二条任务空行耗尽后回退到 create 追加。
  assert.equal(fakeClient.calls.updates.length, 1);
  assert.equal(fakeClient.calls.updates[0].recordId, "rec-empty-1");
  assert.equal(fakeClient.calls.creates.length, 1);
  assert.equal(
    fakeClient.calls.creates[0][DEFAULT_BOARD_FIELDS.taskId],
    "task-b",
  );
  service.stop();
});

test("反向拉起检测到新待处理记录并启动任务", async () => {
  const { service, fakeClient, tasks, sends } = setup();
  await service.init();
  fakeClient.seedList([
    {
      recordId: "rec-new",
      taskId: "",
      title: "写一个单元测试",
      bot: "developer",
      owner: "ou_user1",
      state: BOARD_STATES.TODO,
      chatId: "oc_group1",
    },
  ]);
  await service.pullOnce();
  assert.equal(tasks.started.length, 1);
  const input = tasks.started[0];
  assert.equal(input.requestedPrompt, "写一个单元测试");
  assert.equal(input.taskId, "BR-rec-new");
  assert.equal(input.botConfig.id, "developer");
  // 任务ID已回写记录，且后续事件同步能命中同一记录。
  assert.equal(
    fakeClient.calls.updates.some(
      (update) =>
        update.recordId === "rec-new" &&
        update.fields[DEFAULT_BOARD_FIELDS.taskId] === "BR-rec-new",
    ),
    true,
  );
  assert.equal(sends.length, 1);
  service.stop();
});

test("反向拉起记录复用已有任务ID", async () => {
  const { root, service, fakeClient, tasks } = setup();
  await service.init();
  fakeClient.seedList([
    {
      recordId: "rec-known",
      taskId: "BR-rec-known",
      title: "已有任务ID",
      bot: "developer",
      owner: "ou_user1",
      state: BOARD_STATES.TODO,
      chatId: "oc_group1",
    },
  ]);
  await service.pullOnce();
  assert.equal(tasks.started.length, 1);
  assert.equal(tasks.started[0].taskId, "BR-rec-known");
  // 已有任务ID时不应再次回写。
  assert.equal(
    fakeClient.calls.updates.filter((update) => update.recordId === "rec-known").length,
    0,
  );
  // 预填任务ID的记录也必须建立索引，后续事件同步应更新该记录而不是重复建行。
  assert.equal(service.recordIndex.get("BR-rec-known"), "rec-known");
  await root.parallel("task/result", resultPayload({ taskId: "BR-rec-known" }));
  await service.flushNow();
  assert.equal(fakeClient.calls.creates.length, 0);
  assert.equal(
    fakeClient.calls.updates.filter((update) => update.recordId === "rec-known").length,
    1,
  );
  service.stop();
});

test("反向拉起缺少群聊ID时跳过并允许下轮重试", async () => {
  const { service, fakeClient, tasks } = setup();
  await service.init();
  fakeClient.seedList([
    {
      recordId: "rec-nogroup",
      taskId: "",
      title: "没有群聊",
      bot: "developer",
      owner: "ou_user1",
      state: BOARD_STATES.TODO,
      chatId: "",
    },
  ]);
  await service.pullOnce();
  assert.equal(tasks.started.length, 0);
  // triggered 被回滚：下一轮补上群聊ID后仍能触发。
  fakeClient.seedList([
    {
      recordId: "rec-nogroup",
      taskId: "",
      title: "没有群聊",
      bot: "developer",
      owner: "ou_user1",
      state: BOARD_STATES.TODO,
      chatId: "oc_group1",
    },
  ]);
  await service.pullOnce();
  assert.equal(tasks.started.length, 1);
  service.stop();
});

test("反向拉起负责人未注册时跳过", async () => {
  const { service, fakeClient, tasks } = setup();
  await service.init();
  fakeClient.seedList([
    {
      recordId: "rec-badbot",
      taskId: "",
      title: "不存在的Bot",
      bot: "no-such-bot",
      owner: "ou_user1",
      state: BOARD_STATES.TODO,
      chatId: "oc_group1",
    },
  ]);
  await service.pullOnce();
  assert.equal(tasks.started.length, 0);
  service.stop();
});

test("启动扫描后会拉起停机期间遗留的待处理记录", async () => {
  const { service, fakeClient, tasks } = setup();
  const pendingRecord: BoardRecord = {
    recordId: "rec-offline",
    taskId: "",
    title: "停机期间新增的任务",
    bot: "developer",
    owner: "ou_user1",
    state: BOARD_STATES.TODO,
    chatId: "oc_group1",
  };
  fakeClient.seedList([pendingRecord]);
  await service.init();
  fakeClient.seedList([pendingRecord]);
  await service.pullOnce();
  assert.equal(tasks.started.length, 1);
  assert.ok(fakeClient.calls.lists >= 1);
  service.stop();
});

test("任务服务拒绝启动时回滚触发标记并在下轮重试", async () => {
  const { service, fakeClient, tasks } = setup({ taskStartSucceeds: false });
  await service.init();
  const pendingRecord: BoardRecord = {
    recordId: "rec-start-failed",
    taskId: "",
    title: "启动失败后重试",
    bot: "developer",
    owner: "ou_user1",
    state: BOARD_STATES.TODO,
    chatId: "oc_group1",
  };
  fakeClient.seedList([pendingRecord]);
  await service.pullOnce();
  fakeClient.seedList([{
    ...pendingRecord,
    taskId: "BR-rec-start-failed",
  }]);
  await service.pullOnce();
  assert.equal(tasks.started.length, 2);
  service.stop();
});

/** OpenAPI 请求组装：直接驱动 createBitableRecordClient() 的 mock Lark 客户端。 */

function createMockLarkClient(handlers: {
  list?: (payload: unknown) => Promise<{ code?: number; msg?: string; data?: unknown }>;
  create?: (payload: unknown) => Promise<{ code?: number; msg?: string; data?: unknown }>;
  update?: (payload: unknown) => Promise<{ code?: number; msg?: string; data?: unknown }>;
}) {
  const calls = {
    lists: [] as unknown[],
    creates: [] as unknown[],
    updates: [] as unknown[],
  };
  const client = {
    bitable: {
      v1: {
        appTableRecord: {
          list: async (payload: unknown) => {
            calls.lists.push(payload);
            return handlers.list?.(payload) ?? { code: 0, data: { items: [], has_more: false } };
          },
          create: async (payload: unknown) => {
            calls.creates.push(payload);
            return handlers.create?.(payload) ?? { code: 0, data: { record: { record_id: "rec-created" } } };
          },
          update: async (payload: unknown) => {
            calls.updates.push(payload);
            return handlers.update?.(payload) ?? { code: 0, data: {} };
          },
        },
      },
    },
  };
  return { client, calls };
}

test("createBitableRecordClient.create 组装 path/data 且单选字段为字符串", async () => {
  const { client, calls } = createMockLarkClient({});
  const recordClient = createBitableRecordClient(
    client as never,
    "app_token_1",
    "tbl001",
    DEFAULT_BOARD_FIELDS,
  );
  const { recordId } = await recordClient.create(
    buildBoardFieldsForTest({
      taskId: "task-1",
      state: BOARD_STATES.DEV,
    }),
    "00000000-0000-4000-8000-000000000001",
  );
  assert.equal(recordId, "rec-created");
  const payload = calls.creates[0] as {
    path?: { app_token?: string; table_id?: string };
    params?: { client_token?: string };
    data?: { fields?: Record<string, unknown> };
  };
  assert.equal(payload.path?.app_token, "app_token_1");
  assert.equal(payload.path?.table_id, "tbl001");
  assert.equal(
    payload.params?.client_token,
    "00000000-0000-4000-8000-000000000001",
  );
  // 单选字段必须传字符串值，否则真实 API 返回 SingleSelectFieldConvFail。
  assert.equal(payload.data?.fields?.[DEFAULT_BOARD_FIELDS.state], BOARD_STATES.DEV);
});

test("createBitableRecordClient.create 未返回 record_id 时抛出", async () => {
  const { client } = createMockLarkClient({
    create: async () => ({ code: 0, data: { record: {} } }),
  });
  const recordClient = createBitableRecordClient(
    client as never,
    "app_token_1",
    "tbl001",
    DEFAULT_BOARD_FIELDS,
  );
  await assert.rejects(
    () => recordClient.create(
      { [DEFAULT_BOARD_FIELDS.taskId]: "t" },
      "00000000-0000-4000-8000-000000000002",
    ),
    /未返回 record_id/,
  );
});

test("createBitableRecordClient 对并发读写保持至少 100ms 请求间隔", async () => {
  const starts: number[] = [];
  const { client } = createMockLarkClient({
    create: async () => {
      starts.push(Date.now());
      return {
        code: 0,
        data: { record: { record_id: `rec-${starts.length}` } },
      };
    },
  });
  const recordClient = createBitableRecordClient(
    client as never,
    "app_token_1",
    "tbl001",
    DEFAULT_BOARD_FIELDS,
  );
  await Promise.all([
    recordClient.create({}, "00000000-0000-4000-8000-000000000011"),
    recordClient.create({}, "00000000-0000-4000-8000-000000000012"),
    recordClient.create({}, "00000000-0000-4000-8000-000000000013"),
  ]);
  assert.equal(starts.length, 3);
  assert.ok(starts[1] - starts[0] >= 95, "前两次请求间隔应接近或超过 100ms");
  assert.ok(starts[2] - starts[1] >= 95, "后两次请求间隔应接近或超过 100ms");
});

test("createBitableRecordClient.update 组装含 record_id 的 path", async () => {
  const { client, calls } = createMockLarkClient({});
  const recordClient = createBitableRecordClient(
    client as never,
    "app_token_1",
    "tbl001",
    DEFAULT_BOARD_FIELDS,
  );
  await recordClient.update("rec-42", { [DEFAULT_BOARD_FIELDS.state]: BOARD_STATES.DONE });
  const payload = calls.updates[0] as {
    path?: { app_token?: string; table_id?: string; record_id?: string };
  };
  assert.equal(payload.path?.record_id, "rec-42");
  assert.equal(payload.path?.app_token, "app_token_1");
});

test("createBitableRecordClient.list 按 page_token 分页拉全量", async () => {
  const { client, calls } = createMockLarkClient({
    list: async (payload) => {
      const params = (payload as { params?: { page_token?: string } }).params ?? {};
      if (!params.page_token) {
        return {
          code: 0,
          data: {
            items: [{ record_id: "rec-1", fields: {} }],
            has_more: true,
            page_token: "next-token",
          },
        };
      }
      return { code: 0, data: { items: [{ record_id: "rec-2", fields: {} }], has_more: false } };
    },
  });
  const recordClient = createBitableRecordClient(
    client as never,
    "app_token_1",
    "tbl001",
    DEFAULT_BOARD_FIELDS,
  );
  const records = await recordClient.list();
  assert.equal(records.length, 2);
  assert.equal(calls.lists.length, 2);
  const second = calls.lists[1] as { params?: { page_token?: string } };
  assert.equal(second.params?.page_token, "next-token");
});
test("createBitableRecordClient.list 兼容 next_page_token 与字符串成功码", async () => {
  const { client, calls } = createMockLarkClient({
    list: (async (payload: unknown) => {
      const params = (payload as { params?: { page_token?: string } }).params ?? {};
      if (!params.page_token) {
        return {
          code: "0",
          data: {
            items: [{ record_id: "rec-1", fields: {} }],
            has_more: true,
            next_page_token: "next-token",
          },
        };
      }
      return { code: "0", data: { items: [{ record_id: "rec-2", fields: {} }], has_more: false } };
    }) as never,
  });
  const recordClient = createBitableRecordClient(
    client as never,
    "app_token_1",
    "tbl001",
    DEFAULT_BOARD_FIELDS,
  );
  assert.equal((await recordClient.list()).length, 2);
  assert.equal((calls.lists[1] as { params?: { page_token?: string } }).params?.page_token, "next-token");
});

test("createBitableRecordClient 把非零 code 当作错误抛出", async () => {
  const { client } = createMockLarkClient({
    create: async () => ({ code: 1254062, msg: "单选字段错误" }),
  });
  const recordClient = createBitableRecordClient(
    client as never,
    "app_token_1",
    "tbl001",
    DEFAULT_BOARD_FIELDS,
  );
  await assert.rejects(
    () => recordClient.create(
      { [DEFAULT_BOARD_FIELDS.taskId]: "t" },
      "00000000-0000-4000-8000-000000000003",
    ),
    /单选字段错误/,
  );
});

/** 组装测试用的最小字段对象；单选值必须是字符串。 */
function buildBoardFieldsForTest(input: {
  taskId: string;
  state: BoardState;
}): Record<string, string | number | string[]> {
  return {
    [DEFAULT_BOARD_FIELDS.taskId]: input.taskId,
    [DEFAULT_BOARD_FIELDS.state]: input.state,
  };
}

test("loadBoardStorage / saveBoardStorage 本地持久化读写与原子更新", () => {
  const testPath = `data/test-board-${Date.now()}.json`;
  try {
    assert.equal(loadBoardStorage(testPath), null);

    const data = {
      appToken: "bascnTestStorage",
      tableId: "tblTestStorage",
      url: "https://feishu.cn/base/bascnTestStorage",
      name: "本地持久化测试看板",
      botId: "developer",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    saveBoardStorage(data, testPath);

    const loaded = loadBoardStorage(testPath);
    assert.deepEqual(loaded, data);
  } finally {
    try {
      rmSync(testPath, { force: true });
    } catch {
      // 忽略清理异常
    }
  }
});

test("BitableBoardService mount 动态切换与 getStatus 状态指标", async () => {
  const root = new Context();
  const fakeConfig = new FakeConfigService(root, [createBotConfig("developer")]);
  const fakeLark = new FakeLarkService(root);
  fakeLark.runtimes.set("developer", {
    config: createBotConfig("developer"),
    bot: createFakeBot().bot,
  });
  new FakeSessionsService(root);
  new FakeTasksService(root, true);

  const service = new BitableBoardService(root, {
    sync: true,
    pull: false,
  });

  assert.equal(service.isMounted(), false);
  const unmountedStatus = service.getStatus();
  assert.equal(unmountedStatus.mounted, false);

  const fakeClient = createFakeClient();
  await service.mount(
    {
      appToken: "bascnMount1",
      tableId: "tblMount1",
      name: "热挂载看板1",
      saveToStorage: false,
    },
    fakeClient.client,
  );

  assert.equal(service.isMounted(), true);
  const status1 = service.getStatus();
  assert.equal(status1.mounted, true);
  assert.equal(status1.appToken, "bascnMount1");
  assert.equal(status1.tableId, "tblMount1");
  assert.equal(status1.name, "热挂载看板1");

  // 再次热挂载切换
  const fakeClient2 = createFakeClient();
  await service.mount(
    {
      appToken: "bascnMount2",
      tableId: "tblMount2",
      name: "热挂载看板2",
      saveToStorage: false,
    },
    fakeClient2.client,
  );

  const status2 = service.getStatus();
  assert.equal(status2.appToken, "bascnMount2");
  assert.equal(status2.tableId, "tblMount2");
  assert.equal(status2.name, "热挂载看板2");

  service.stop();
});

test("候选看板扫描失败时保留当前已挂载看板", async () => {
  const { service, fakeClient } = setup();
  await service.init();
  const oldStorage = service.getStorage();
  const candidate = createFakeClient();
  candidate.failNextList(new Error("候选表扫描失败"));

  await assert.rejects(
    service.mount(
      { appToken: "newApp", tableId: "newTable", name: "新看板", saveToStorage: false },
      candidate.client,
    ),
    /候选表扫描失败/,
  );
  assert.deepEqual(service.getStorage(), oldStorage);
  assert.equal(service.isMounted(), true);
  assert.equal(fakeClient.calls.lists >= 1, true);
  service.stop();
});

test("重挂载时清理旧任务的 pending、snapshot 与统计去重状态", async () => {
  const { service, fakeClient } = setup();
  await service.init();
  service.enqueueSnapshot({
    taskId: "old-task",
    title: "旧任务",
    bot: "developer",
    owner: "ou_user",
    state: BOARD_STATES.DEV,
  }, "old-run");
  const internal = service as unknown as {
    pending: Map<string, unknown>;
    snapshots: Map<string, unknown>;
    countedRuns: Map<string, unknown>;
  };
  assert.equal(internal.pending.size, 1);
  assert.equal(internal.snapshots.size, 1);
  assert.equal(internal.countedRuns.size, 1);

  const next = createFakeClient();
  await service.mount(
    { appToken: "newApp", tableId: "newTable", name: "新看板", saveToStorage: false },
    next.client,
  );
  assert.equal(internal.pending.size, 0);
  assert.equal(internal.snapshots.size, 0);
  assert.equal(internal.countedRuns.size, 0);
  assert.equal(service.recordIndex.has("old-task"), false);
  service.stop();
  void fakeClient;
});

test("本地持久化失败时热挂载不切换当前看板", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "threadpilot-board-storage-"));
  try {
    const { service } = setup({ storagePath: tempDir });
    await service.init();
    const oldStorage = service.getStorage();
    const candidate = createFakeClient();
    await assert.rejects(
      service.mount(
        {
          appToken: "newApp",
          tableId: "newTable",
          name: "新看板",
          saveToStorage: true,
        },
        candidate.client,
      ),
      /保存本地看板配置失败/,
    );
    assert.deepEqual(service.getStorage(), oldStorage);
    assert.equal(service.isMounted(), true);
    service.stop();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
test("首次扫描失败时挂载为 degraded，并保留待冲刷快照等待恢复", async () => {
  const { root, service, fakeClient } = setup({ autoMount: false });
  fakeClient.failNextList(new Error("网络暂时不可用"));
  await service.mount(
    { appToken: "appToken", tableId: "tbl001", saveToStorage: false },
    fakeClient.client,
  );
  assert.equal(service.isMounted(), true);
  assert.equal(service.getStatus().degraded, true);
  await root.parallel("task/result", resultPayload({ taskId: "degraded-task" }));
  assert.equal(service.getStatus().pendingSyncCount, 1);
  service.stop();
});

test("热挂载期间到达的新事件转移到候选看板，不被切换清空", async () => {
  const { root, service, fakeClient } = setup();
  await service.init();

  const candidate = createFakeClient();
  let listStarted = false;
  let releaseList!: () => void;
  const listGate = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  candidate.client.list = async () => {
    listStarted = true;
    await listGate;
    return [];
  };

  const mountPromise = service.mount(
    { appToken: "nextApp", tableId: "nextTable", saveToStorage: false },
    candidate.client,
  );
  while (!listStarted) await new Promise((resolve) => setTimeout(resolve, 0));

  await root.parallel("task/result", resultPayload({ taskId: "during-mount" }));
  releaseList();
  await mountPromise;
  await service.flushNow();

  assert.equal(candidate.calls.creates.length, 1);
  assert.equal(
    candidate.calls.creates[0]?.[DEFAULT_BOARD_FIELDS.taskId],
    "during-mount",
  );
  assert.equal(fakeClient.calls.creates.length, 0);
  service.stop();
});

test("热切换后丢弃旧看板仍在途的扫描结果与错误", async () => {
  const { service, fakeClient } = setup();
  await service.init();

  const staleScans: Array<{
    resolve(records: BoardRecord[]): void;
    reject(error: unknown): void;
  }> = [];
  fakeClient.client.list = () => new Promise<BoardRecord[]>((resolve, reject) => {
    staleScans.push({ resolve, reject });
  });
  const internal = service as unknown as { safeScan(): Promise<void> };
  const staleRecordScan = internal.safeScan();
  const staleErrorScan = internal.safeScan();
  while (staleScans.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));

  const candidate = createFakeClient();
  candidate.seedList([{
    recordId: "rec-new",
    taskId: "task-new",
    title: "新看板任务",
    bot: "developer",
    owner: "ou_user",
    state: BOARD_STATES.DEV,
    chatId: "oc-new",
  }]);
  await service.mount(
    { appToken: "newApp", tableId: "newTable", saveToStorage: false },
    candidate.client,
  );

  staleScans[0].resolve([{
    recordId: "rec-old",
    taskId: "task-old",
    title: "旧看板任务",
    bot: "developer",
    owner: "ou_user",
    state: BOARD_STATES.DEV,
    chatId: "oc-old",
  }]);
  staleScans[1].reject(new Error("旧看板扫描超时"));
  await Promise.all([staleRecordScan, staleErrorScan]);

  assert.equal(service.recordIndex.get("task-new"), "rec-new");
  assert.equal(service.recordIndex.has("task-old"), false, "旧扫描结果不得污染新索引");
  assert.equal(service.getStatus().degraded, false, "旧扫描错误不得改写新看板状态");
  service.stop();
});

test("热切换迁移任务快照时保留该任务的统计去重键", async () => {
  const { root, service } = setup();
  await service.init();

  const candidate = createFakeClient();
  let listStarted = false;
  let releaseList!: () => void;
  const listGate = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  candidate.client.list = async () => {
    listStarted = true;
    await listGate;
    return [];
  };
  const mountPromise = service.mount(
    { appToken: "nextApp", tableId: "nextTable", saveToStorage: false },
    candidate.client,
  );
  while (!listStarted) await new Promise((resolve) => setTimeout(resolve, 0));

  const pairedPayload = resultPayload({
    taskId: "task-cross-mount",
    traceId: "trace-cross-mount",
    durationMs: 5_000,
    stats: { totalTokens: 10 },
  });
  await root.parallel("task/result", pairedPayload);
  releaseList();
  await mountPromise;
  await root.parallel("task/failed", pairedPayload);

  const snapshot = (service as unknown as {
    snapshots: Map<string, { tokens?: number; durationMs?: number }>;
  }).snapshots.get("task-cross-mount");
  assert.equal(snapshot?.tokens, 10, "同一运行的配对事件跨切换时 Token 只能累计一次");
  assert.equal(snapshot?.durationMs, 5_000, "同一运行的配对事件跨切换时耗时只能累计一次");
  service.stop();
});

test("看板表失效时标记 degraded、暂停轮询并向配置的群聊发送一次提醒", async () => {
  const { service, fakeClient, sends } = setup({ fallbackChatId: "oc-alert" });
  await service.init();
  fakeClient.failNextList(new Error("1254001 app not found"));

  await assert.rejects(service.pullOnce(), /1254001/);
  assert.equal(service.getStatus().degraded, true);
  assert.equal(sends.length, 1);
  assert.match(sends[0], /任务看板.*失效/);

  // 失效后 scanReady=false：轮询暂停，不再请求失效 API。
  const listsBefore = fakeClient.calls.lists;
  await service.pullOnce();
  assert.equal(fakeClient.calls.lists, listsBefore, "失效阶段不得继续请求表格");
  assert.equal(sends.length, 1, "暂停期间不重复提醒");

  // 扫描恢复后重新进入正常轮询；新的降级阶段会再次提醒。
  await (service as unknown as { safeScan(): Promise<void> }).safeScan();
  fakeClient.failNextList(new Error("1254003 table not found"));
  await assert.rejects(service.pullOnce(), /1254003/);
  assert.equal(sends.length, 2, "新的降级阶段会再次提醒");
  service.stop();
});

test("冷启动从持久化配置恢复 botId/fallbackChatId 并沿用时间", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "threadpilot-board-recovery-"));
  const storagePath = join(tempDir, "board.json");
  const now = new Date().toISOString();
  saveBoardStorage({
    appToken: "savedApp",
    tableId: "savedTable",
    url: "https://feishu.cn/base/savedApp",
    name: "恢复看板",
    botId: "qa",
    fallbackChatId: "oc-recovered",
    createdAt: now,
    updatedAt: now,
  }, storagePath);

  const root = new Context();
  new FakeConfigService(root, [createBotConfig("developer"), createBotConfig("qa")]);
  const lark = new FakeLarkService(root);
  lark.runtimes.set("developer", { config: createBotConfig("developer"), bot: createFakeBot().bot });
  lark.runtimes.set("qa", { config: createBotConfig("qa"), bot: createFakeBot().bot });
  new FakeSessionsService(root);
  new FakeTasksService(root, true);

  try {
    await applyBitableBoard(root, { storagePath, pull: false });
    const service = root.bitableBoard as BitableBoardService;
    assert.equal(service.getStorage()?.botId, "qa");
    assert.equal(service.getStorage()?.appToken, "savedApp");
    // fallbackChatId 恢复后反向拉起能命中初始化群。
    assert.equal(service.getStorage()?.fallbackChatId, "oc-recovered");
    // 冷启动必须沿用缓存时间，保证 /board link 重启前后一致。
    assert.equal(service.getStorage()?.createdAt, now);
    assert.equal(service.getStorage()?.updatedAt, now);
    service.stop();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("静态配置 appToken 与 tableId 半配置时不读取缓存", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "threadpilot-board-partial-"));
  const storagePath = join(tempDir, "board.json");
  saveBoardStorage({
    appToken: "cachedApp",
    tableId: "cachedTable",
    url: "https://feishu.cn/base/cachedApp",
    name: "缓存看板",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, storagePath);

  const root = new Context();
  new FakeConfigService(root, [createBotConfig("developer")]);
  const lark = new FakeLarkService(root);
  lark.runtimes.set("developer", { config: createBotConfig("developer"), bot: createFakeBot().bot });
  new FakeSessionsService(root);
  new FakeTasksService(root, true);

  try {
    // 只显式配置 appToken、缺 tableId：视为配置错误，不读缓存、不自动挂载。
    await applyBitableBoard(root, { storagePath, appToken: "explicitApp", pull: false });
    const service = root.bitableBoard as BitableBoardService;
    assert.equal(service.isMounted(), false, "半配置时不得静默用缓存挂载");
    assert.equal(service.getStorage(), null);
    service.stop();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("全量扫描合并表格快照时不重复累计 Token/耗时", async () => {
  const { root, service, fakeClient } = setup();
  await service.init();
  // 任务完成：token 与耗时已写入表格，内存 snapshots 也保留同一累计值。
  await root.parallel("task/result", resultPayload({
    taskId: "task-token-once",
    durationMs: 30000,
    stats: { totalTokens: 1200 },
  }));
  await service.flushNow();
  assert.equal(fakeClient.calls.creates.length, 1);
  assert.equal(fakeClient.calls.creates[0][DEFAULT_BOARD_FIELDS.tokens], 1200);

  // 触发全量扫描（degraded 恢复路径）：合并后 Token/耗时不得翻倍。
  await (service as unknown as { safeScan(): Promise<void> }).safeScan();
  const restored = (service as unknown as { snapshots: Map<string, { tokens?: number; durationMs?: number }> }).snapshots.get("task-token-once");
  assert.equal(restored?.tokens, 1200, "扫描合并不得把 Token 累计翻倍");
  assert.equal(restored?.durationMs, 30000, "扫描合并不得把耗时累计翻倍");

  // 再次扫描（模拟多次重扫）仍保持原值。
  await (service as unknown as { safeScan(): Promise<void> }).safeScan();
  const again = (service as unknown as { snapshots: Map<string, { tokens?: number; durationMs?: number }> }).snapshots.get("task-token-once");
  assert.equal(again?.tokens, 1200);
  assert.equal(again?.durationMs, 30000);
  service.stop();
});

test("表格失效时冲刷保留 pending，扫描恢复后统一写入", async () => {
  const { root, service, fakeClient } = setup({ maxRetries: 0 });
  await service.init();
  await root.parallel("task/result", resultPayload({ taskId: "task-survive" }));
  // 首次创建即遇到表格失效：快照必须保留回 pending，不能丢弃。
  fakeClient.failNextCreate(new Error("1254001 app not found"));
  await service.flushNow();
  assert.equal(service.getStatus().degraded, true);
  assert.equal(
    (service as unknown as { pending: Map<string, unknown> }).pending.size,
    1,
    "失效时必须把快照保留回 pending",
  );

  // 扫描恢复后统一冲刷，快照最终落表。
  await (service as unknown as { safeScan(): Promise<void> }).safeScan();
  await service.flushNow();
  assert.equal(
    fakeClient.calls.creates.some((fields) => fields[DEFAULT_BOARD_FIELDS.taskId] === "task-survive"),
    true,
    "恢复后应补写失效期间保留的快照",
  );
  service.stop();
});

test("表格失效时冲刷批次立即终止，剩余快照全部保留", async () => {
  const { root, service, fakeClient } = setup({ maxRetries: 0 });
  await service.init();
  await root.parallel("task/result", resultPayload({ taskId: "task-batch-1" }));
  await root.parallel("task/result", resultPayload({ taskId: "task-batch-2" }));
  await root.parallel("task/result", resultPayload({ taskId: "task-batch-3" }));
  // 首条记录即遇表失效：整批必须终止，不再对已知失效的表逐条重试。
  fakeClient.failNextCreate(new Error("1254001 app not found"));
  await service.flushNow();
  assert.equal(fakeClient.calls.creates.length, 1, "批次应在首条表失效后立即终止");
  assert.equal(
    (service as unknown as { pending: Map<string, unknown> }).pending.size,
    3,
    "本批全部快照都应保留回 pending 等待恢复",
  );

  // 恢复后统一补写全部三条。
  await (service as unknown as { safeScan(): Promise<void> }).safeScan();
  await service.flushNow();
  const taskIds = fakeClient.calls.creates.map((fields) => fields[DEFAULT_BOARD_FIELDS.taskId]);
  for (const id of ["task-batch-1", "task-batch-2", "task-batch-3"]) {
    assert.ok(taskIds.includes(id), `恢复后应补写 ${id}`);
  }
  service.stop();
});

test("候选挂载失败不污染旧看板的回退群", async () => {
  const { service, fakeClient } = setup();
  await service.mount({
    appToken: "oldApp",
    tableId: "oldTable",
    name: "旧看板",
    fallbackChatId: "old-chat",
    saveToStorage: false,
  }, fakeClient.client);

  // 候选表扫描失败（保留旧看板）时传入新群：不得改写运行中看板的回退群。
  const candidate = createFakeClient();
  candidate.failNextList(new Error("候选扫描失败"));
  await assert.rejects(
    service.mount({
      appToken: "newApp",
      tableId: "newTable",
      name: "新看板",
      fallbackChatId: "new-chat",
      saveToStorage: false,
    }, candidate.client),
    /候选扫描失败/,
  );

  assert.equal(service.isMounted(), true, "旧看板应继续运行");
  assert.equal(service.getStorage()?.fallbackChatId, "old-chat", "storage 回退群不得被污染");
  assert.equal(
    (service as unknown as { currentConfig: { fallbackChatId?: string } }).currentConfig.fallbackChatId,
    "old-chat",
    "运行态回退群不得被污染，避免反向任务跑错群",
  );
  service.stop();
});

test("pull 遇到临时错误后 degraded 状态在成功轮询时恢复", async () => {
  const { service, fakeClient } = setup();
  await service.init();
  // 非「表失效」错误（网络超时）：只置 degraded，不暂停轮询。
  fakeClient.failNextList(new Error("request timeout"));
  await assert.rejects(service.pullOnce(), /request timeout/);
  assert.equal(service.getStatus().degraded, true);

  // 下一次轮询成功：degraded 必须恢复。
  await service.pullOnce();
  assert.equal(service.getStatus().degraded, false, "轮询成功应恢复 degraded");
  service.stop();
});

test("/board init 绑定初始化群作为 fallbackChatId 并回填到记录", async () => {
  const { service, fakeClient } = setup({ fallbackChatId: "oc-group-1" });
  await service.init();
  // 记录未填群聊ID：应使用 fallbackChatId 启动，并回填群聊ID到记录。
  fakeClient.seedList([{
    recordId: "rec-nochat",
    taskId: "",
    title: "零配置任务",
    bot: "developer",
    owner: "ou_user1",
    state: BOARD_STATES.TODO,
    chatId: "",
  }]);
  await service.pullOnce();
  const backfill = fakeClient.calls.updates.find((update) => update.recordId === "rec-nochat");
  assert.ok(backfill, "反向拉起应回写任务ID");
  assert.equal(backfill.fields[DEFAULT_BOARD_FIELDS.chatId], "oc-group-1", "应把回退群聊回填到记录");
  service.stop();
});

test("mount 时传入 fallbackChatId 会写入持久化存储", async () => {
  const { service, fakeClient } = setup();
  await service.mount({
    appToken: "bascnChat",
    tableId: "tblChat",
    name: "带群聊看板",
    fallbackChatId: "oc-init-group",
    saveToStorage: false,
  }, fakeClient.client);
  assert.equal(service.getStorage()?.fallbackChatId, "oc-init-group");
  service.stop();
});
