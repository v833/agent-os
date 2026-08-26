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
import type { StartTaskInput, TaskResultPayload } from "./types.js";
import {
  BoardService,
  createBitableRecordClient,
  type BitableRecordClient,
} from "./bitable-board.js";

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

  constructor(ctx: Context) {
    super(ctx, "tasks");
  }

  startTask(input: StartTaskInput): void {
    this.started.push(input);
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
} = {}) {
  const root = new Context();
  const bots = options.bots ?? [createBotConfig("developer")];
  const config = new FakeConfigService(root, bots);
  const lark = new FakeLarkService(root);
  const sessions = new FakeSessionsService(root);
  const tasks = new FakeTasksService(root);
  const fakeBot = createFakeBot();
  for (const botConfig of bots) {
    lark.runtimes.set(botConfig.id, { config: botConfig, bot: fakeBot.bot });
  }
  const fakeClient = createFakeClient();
  const client = options.client ?? fakeClient.client;
  const service = new BoardService(
    root,
    client,
    {
      appToken: "appToken",
      tableId: "tbl001",
      sync: options.sync ?? true,
      pull: options.pull ?? false,
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      ...(options.fallbackChatId ? { fallbackChatId: options.fallbackChatId } : {}),
    },
    DEFAULT_BOARD_FIELDS,
  );
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
  const { root, service, fakeClient } = setup();
  fakeClient.failNextList(new Error("扫描暂时失败"));
  await service.init();
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

test("scan 后历史待处理记录不自动触发", async () => {
  const { service, fakeClient, tasks } = setup();
  await service.init();
  // scan 已把历史记录标记为 seen，轮询不应触发。
  await service.pullOnce();
  assert.equal(tasks.started.length, 0);
  assert.ok(fakeClient.calls.lists >= 1);
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
