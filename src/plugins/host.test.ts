/**
 * host 集成测试：用真实服务插件 + 假平台/假执行引擎组装一个最小 Agent OS，
 * 验证事件路由、命令派发、任务生命周期、停止与协作交接的完整链路。
 * 这里是“一切皆为插件”装配方式的端到端验证：替换 lark/cli 实现即可测试。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context, Service } from "cordis";
import type { BotConfig } from "../core/bot-registry.js";
import { MAX_RUNS } from "../core/orchestration.js";
import type { TeamCardOptions } from "../im/card.js";
import type {
  Bot,
  BotConnectionState,
  BotIdentity,
  IncomingMessage,
} from "../im/lark.js";
import type {
  CliAdapter,
  CliRunResult,
  CliSessionSummary,
} from "../cli/types.js";
import type { RunCliOptions } from "../cli/runner.js";
import * as applicationToolsPlugin from "./application-tools.js";
import * as cardsPlugin from "./cards.js";
import * as clarificationPlugin from "./clarification.js";
import * as collaborationPlugin from "./collaboration.js";
import * as commandsPlugin from "./commands.js";
import * as orchestrationPlugin from "./orchestration.js";
import * as orchestrateCommand from "./commands/orchestrate.js";
import * as panelCommand from "./commands/panel.js";
import * as statusCommand from "./commands/status.js";
import * as teamCommand from "./commands/team.js";
import * as routerPlugin from "./router.js";
import * as sessionsPlugin from "./sessions.js";
import * as tasksPlugin from "./tasks.js";
import * as teamPlugin from "./team.js";
import { waitForAllActive } from "./loader.js";
import type { BotRuntime } from "./types.js";

const tempDirs: string[] = [];
test.after(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const baseBotConfig: BotConfig = {
  id: "testbot",
  appId: "cli_test",
  appSecret: "secret",
  defaultCliId: "codex",
  accessMode: "headless",
  role: "测试角色",
  skills: [],
  systemPrompt: "测试角色",
  workspaceDir: process.cwd(),
  collaborationMaxRounds: 2,
};

/** 假配置服务：只提供测试传入的 bot，避免依赖真实 config/bots.json。 */
class FakeConfigService extends Service {
  readonly bots: BotConfig[];
  readonly defaultWorkspaces: Record<string, string>;
  readonly teamLeaderId: string;

  constructor(ctx: Context, bots: BotConfig[]) {
    super(ctx, "config");
    this.bots = bots;
    this.defaultWorkspaces = Object.fromEntries(
      bots.map((bot) => [bot.id, bot.workspaceDir]),
    );
    this.teamLeaderId = bots[0]?.id ?? "";
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

/** 假执行引擎：捕获调用参数，由测试控制何时完成或取消。 */
class FakeCliService extends Service {
  captured: RunCliOptions | undefined;
  readonly captures: RunCliOptions[] = [];
  compactOptions: unknown;
  private resolver: ((result: CliRunResult) => void) | undefined;
  private compactResolver:
    | ((result: { sessionId: string; compacted: boolean }) => void)
    | undefined;

  constructor(ctx: Context) {
    super(ctx, "cli");
  }

  register(): void {}

  get(
    _id: string,
    accessMode: "headless" | "acp" = "headless",
  ): CliAdapter {
    return accessMode === "acp"
      ? { ...fakeAdapter, accessMode: "acp", displayName: "FakeACP" }
      : fakeAdapter;
  }

  list(): CliAdapter[] {
    return [fakeAdapter];
  }

  run(options: RunCliOptions): Promise<CliRunResult> {
    this.captured = options;
    this.captures.push(options);
    return new Promise((resolve) => {
      this.resolver = resolve;
      // 任务被停止时按成功路径收尾，让编排走 cancelMode 分支。
      options.signal?.addEventListener(
        "abort",
        () => resolve({ answer: "", sessionId: "sess-1" }),
        { once: true },
      );
    });
  }

  finish(result: CliRunResult): void {
    this.resolver?.(result);
  }

  compact(options: unknown): Promise<{ sessionId: string; compacted: boolean }> {
    this.compactOptions = options;
    return new Promise((resolve) => {
      this.compactResolver = resolve;
    });
  }

  finishCompact(): void {
    this.compactResolver?.({ sessionId: "sess-1", compacted: true });
  }

  listNativeSessions(): Promise<CliSessionSummary[]> {
    return Promise.resolve([
      { id: "sess-1", title: "历史会话", updatedAt: new Date().toISOString() },
    ]);
  }
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

  connectionState(id: string): string | undefined {
    return this.runtimes.get(id)?.bot.getConnectionState?.();
  }
}

/** 记录 bot 出站调用的假平台句柄。 */
function createFakeBot(
  connectionState: BotConnectionState = "connected",
) {
  const calls = {
    replies: [] as string[],
    cards: [] as Record<string, unknown>[],
    mentions: [] as string[],
    updates: [] as Record<string, unknown>[],
  };
  const bot = {
    client: {},
    getConnectionState: () => connectionState,
    getIdentity: async () =>
      ({ openId: "bot_open", name: "TestBot" }) as BotIdentity,
    reply: async (_id: string, text: string) => {
      calls.replies.push(text);
      return `msg-${calls.replies.length}`;
    },
    replyCard: async (_id: string, card: Record<string, unknown>) => {
      calls.cards.push(card);
      return `card-${calls.cards.length}`;
    },
    replyMention: async (_id: string, _target: BotIdentity, text: string) => {
      calls.mentions.push(text);
      return `mention-${calls.mentions.length}`;
    },
    sendResultNotification: async (options: {
      replyToMessageId: string;
      target: BotIdentity;
      text: string;
      replyInThread: boolean;
    }) => {
      await bot.replyMention(
        options.replyToMessageId,
        options.target,
        options.text,
        options.replyInThread,
      );
    },
    updateCard: async (_id: string, card: Record<string, unknown>) => {
      calls.updates.push(card);
    },
    downloadResource: async () => join(process.cwd(), "data", "downloads", "x"),
  } as unknown as Bot;
  return { bot, calls };
}

function incomingMessage(overrides: Partial<IncomingMessage>): IncomingMessage {
  const text = overrides.text ?? "";
  return {
    messageId: "m1",
    chatId: "chat1",
    chatType: "p2p",
    messageType: "text",
    text,
    rawContent: JSON.stringify({ text }),
    rootId: "",
    threadId: "",
    senderType: "user",
    senderOpenId: "ou_user",
    mentions: [],
    ...overrides,
  };
}

/** 从运行中卡片里取出 abort 按钮携带的 sessionId/runId。 */
function abortValueOf(card: Record<string, unknown>): Record<string, unknown> {
  const elements = (card.body as { elements?: unknown[] } | undefined)
    ?.elements ?? [];
  for (const element of elements) {
    const behaviors = (element as { behaviors?: { value?: unknown }[] })
      ?.behaviors ?? [];
    for (const behavior of behaviors) {
      const value = behavior.value;
      if (
        typeof value === "object" &&
        value !== null &&
        (value as { action?: string }).action === "abort_task"
      ) {
        return value as Record<string, unknown>;
      }
    }
  }
  throw new Error("卡片里找不到 abort 按钮");
}

function clarificationValueOf(card: Record<string, unknown>): Record<string, unknown> {
  const elements = (card.body as { elements?: unknown[] } | undefined)
    ?.elements ?? [];
  for (const element of elements) {
    const formElements =
      (element as { tag?: string; elements?: unknown[] }).tag === "form"
        ? (element as { elements?: unknown[] }).elements ?? []
        : [];
    for (const formElement of formElements) {
      const behaviors = (formElement as { behaviors?: { value?: unknown }[] })
        .behaviors ?? [];
      for (const behavior of behaviors) {
        const value = behavior.value;
        if (
          typeof value === "object" &&
          value !== null &&
          (value as { action?: string }).action === "submit_clarification"
        ) {
          return value as Record<string, unknown>;
        }
      }
    }
  }
  throw new Error("卡片里找不到澄清提交按钮");
}

function cardSummaryContains(
  card: Record<string, unknown>,
  text: string,
): boolean {
  return JSON.stringify(card).includes(text);
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor 超时，条件未满足");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Host {
  root: Context;
  cli: FakeCliService;
  lark: FakeLarkService;
  bot: ReturnType<typeof createFakeBot>["bot"];
  calls: ReturnType<typeof createFakeBot>["calls"];
  clarificationsPath: string;
}

/** 组装一个最小 Agent OS 宿主：真实服务插件 + 假 cli/lark/config。 */
async function createHost(
  bots: BotConfig[] = [baseBotConfig],
  connectionState: BotConnectionState = "connected",
): Promise<Host> {
  const root = new Context();
  const fakeBot = createFakeBot(connectionState);
  let cli!: FakeCliService;
  let lark!: FakeLarkService;
  const sessionsDir = await mkdtemp(join(tmpdir(), "agent-os-host-"));
  const clarificationsPath = join(sessionsDir, "clarifications.json");
  tempDirs.push(sessionsDir);

  const configPlugin = {
    name: "config",
    apply(ctx: Context, config: { bots: BotConfig[] }) {
      new FakeConfigService(ctx, config.bots);
    },
  };
  const cliPlugin = {
    name: "cli",
    apply(ctx: Context) {
      cli = new FakeCliService(ctx);
    },
  };
  const larkPlugin = {
    name: "lark",
    apply(ctx: Context) {
      lark = new FakeLarkService(ctx);
    },
  };

  await Promise.all([
    root.plugin(configPlugin, { bots }),
    root.plugin(teamPlugin),
    root.plugin(cliPlugin),
    root.plugin(larkPlugin),
    root.plugin(sessionsPlugin, { storePath: join(sessionsDir, "s.json") }),
    root.plugin(applicationToolsPlugin),
    root.plugin(cardsPlugin),
    root.plugin(commandsPlugin),
    root.plugin(statusCommand),
    root.plugin(teamCommand),
    root.plugin(collaborationPlugin),
    root.plugin(orchestrationPlugin),
    root.plugin(orchestrateCommand),
    root.plugin(panelCommand),
    root.plugin(tasksPlugin),
    root.plugin(clarificationPlugin, { storePath: clarificationsPath }),
    root.plugin(routerPlugin),
  ]);
  // mount fiber 不等待深层 inject 级联，必须等全部插件 ACTIVE 再发事件。
  await waitForAllActive(root);

  lark.runtimes.set("testbot", {
    config: baseBotConfig,
    bot: fakeBot.bot,
    identity: { openId: "bot_open", name: "TestBot" },
  });

  return {
    root,
    cli,
    lark,
    bot: fakeBot.bot,
    calls: fakeBot.calls,
    clarificationsPath,
  };
}

test("bot/message 把 /status 派发给命令插件", async () => {
  const host = await createHost();
  const message = incomingMessage({ text: "/status" });
  await host.root.parallel("bot/message", message, host.bot, baseBotConfig);
  assert.ok(
    host.calls.replies[0]?.includes("执行引擎：FakeCodex"),
    "应该回复会话状态",
  );
});

test("bot/message 把 /team 经 ctx.cards 服务出口生成团队卡片", async () => {
  const host = await createHost();
  // 钉住服务出口：验证命令插件走 ctx.cards.team，而不是直接调用渲染实现。
  let teamCalls = 0;
  let teamOptions: TeamCardOptions | undefined;
  const originalTeam = host.root.cards.team.bind(host.root.cards);
  host.root.cards.team = ((options: TeamCardOptions) => {
    teamCalls += 1;
    teamOptions = options;
    return originalTeam(options);
  }) as typeof host.root.cards.team;

  const message = incomingMessage({ text: "/team" });
  await host.root.parallel("bot/message", message, host.bot, baseBotConfig);

  assert.equal(teamCalls, 1, "/team 必须经过 ctx.cards.team 服务出口");
  assert.ok(
    teamOptions?.members.some((member) => member.id === "testbot"),
    "服务出口收到团队成员数据",
  );
  assert.equal(host.calls.cards.length, 1, "应该回复一张团队卡片");
  const card = JSON.stringify(host.calls.cards[0]);
  assert.ok(card.includes("Agent 团队"), "卡片标题包含团队名");
  assert.ok(card.includes("TestBot"), "使用实时 bot 显示名");
  assert.ok(card.includes("已连接"), "已建立连接的成员标记在线");
  assert.ok(card.includes("FakeCodex"), "展示默认执行引擎");
});

test("task/prompt-context：团队外 bot 降级返回 undefined 而不是抛错", async () => {
  const host = await createHost();

  // 团队内的成员应拿到团队上下文，作为 tasks 的提示词 provider。
  const known = host.root.bail("task/prompt-context", baseBotConfig);
  assert.ok(
    known?.includes("你所在的 Agent 团队"),
    "团队成员应返回团队上下文",
  );

  // 不在团队名册中的 bot 必须返回 undefined，不能让 contextFor 的异常打断任务启动。
  const unknown = host.root.bail("task/prompt-context", {
    ...baseBotConfig,
    id: "ghost",
  });
  assert.equal(unknown, undefined);
});

test("/team 按成员 accessMode 查找 ACP 执行引擎", async () => {
  const host = await createHost([
    baseBotConfig,
    { ...baseBotConfig, id: "acpbot", accessMode: "acp" },
  ]);
  await host.root.parallel(
    "bot/message",
    incomingMessage({ text: "/team" }),
    host.bot,
    baseBotConfig,
  );

  assert.ok(
    JSON.stringify(host.calls.cards[0]).includes("FakeACP"),
    "/team 应按成员 accessMode 展示 ACP 引擎",
  );
});

test("/team 仅把真实 connected 长连接标为在线", async () => {
  const host = await createHost([baseBotConfig], "reconnecting");
  await host.root.parallel(
    "bot/message",
    incomingMessage({ text: "/team" }),
    host.bot,
    baseBotConfig,
  );

  assert.ok(
    JSON.stringify(host.calls.cards[0]).includes("未连接"),
    "重连中的 bot 不能显示为已连接",
  );
});

test("普通任务走完卡片、执行与结果通知的生命周期", async () => {
  const host = await createHost();
  const message = incomingMessage({ text: "写一个 hello world" });
  await host.root.parallel("bot/message", message, host.bot, baseBotConfig);
  await waitFor(() => host.cli.captured !== undefined);
  assert.ok(
    host.cli.captured?.prompt.includes("你所在的 Agent 团队"),
    "team 插件应通过 prompt-context provider 注入团队上下文",
  );

  // 任务卡片已发出，且携带可停止的按钮。
  assert.ok(
    host.calls.cards.some((card) => cardSummaryContains(card, "执行中")),
  );

  host.cli.finish({ answer: "完成！", sessionId: "sess-1" });
  await waitFor(() =>
    host.calls.mentions.some((text) => text.includes("任务已完成")),
  );
  assert.ok(
    host.calls.updates.some((card) => cardSummaryContains(card, "已完成")),
  );
});

test("澄清工具调用进入等待卡片，用户回答后续接原 CLI 会话", async () => {
  const host = await createHost();
  const message = incomingMessage({
    text: "实现优先级功能",
    senderOpenId: "ou_owner",
  });
  await host.root.parallel("bot/message", message, host.bot, baseBotConfig);
  await waitFor(() => host.cli.captured !== undefined);

  host.cli.finish({
    answer: "等待用户确认。",
    sessionId: "sess-clarification",
    toolCalls: [
      {
        toolUseId: "tool-1",
        toolName: "request_clarification",
        input: {
          title: "确认优先级范围",
          intro: "请选择实现方式。",
          questions: [
            {
              id: "priority_scope",
              prompt: "优先级需要支持几档？",
              options: [
                { id: "three", label: "高、中、低三档" },
                { id: "custom", label: "允许自定义" },
              ],
              recommendedOptionId: "three",
            },
          ],
        },
      },
    ],
  });

  await waitFor(() =>
    host.calls.updates.some((card) => cardSummaryContains(card, "等待回答")),
  );
  assert.equal(host.calls.mentions.length, 0, "等待澄清时不能发送任务完成通知");
  const persisted = JSON.parse(
    await readFile(host.clarificationsPath, "utf8"),
  ) as Array<Record<string, unknown>>;
  assert.equal(persisted.length, 1, "待澄清状态必须持久化");
  assert.equal(typeof persisted[0]?.runId, "string");
  assert.equal(persisted[0]?.cliSessionId, "sess-clarification");

  const waitingCard = host.calls.updates.find((card) =>
    cardSummaryContains(card, "等待回答"),
  )!;
  const response = await host.root.serial(
    "bot/card-action",
    {
      operatorOpenId: "ou_owner",
      messageId: "card-1",
      value: clarificationValueOf(waitingCard),
      formValue: { priority_scope: "three" },
    },
    host.bot,
    baseBotConfig,
  );
  assert.equal(response?.toast?.content, "回答已提交，正在继续执行。");
  await waitFor(() => host.cli.captures.length === 2);
  assert.equal(
    host.cli.captures[1]?.sessionId,
    "sess-clarification",
    "回答必须恢复原始 CLI 会话",
  );
  assert.match(host.cli.captures[1]?.prompt ?? "", /高、中、低三档/);

  host.cli.finish({ answer: "已按三档实现。", sessionId: "sess-clarification" });
  await waitFor(() =>
    host.calls.mentions.some((text) => text.includes("任务已完成")),
  );
  assert.deepEqual(
    JSON.parse(await readFile(host.clarificationsPath, "utf8")),
    [],
    "回答后必须删除待澄清记录",
  );
});

test("卡片停止按钮只能由任务发起人触发，并写入取消终态", async () => {
  const host = await createHost();
  const message = incomingMessage({
    text: "写一个 hello",
    senderOpenId: "ou_owner",
  });
  await host.root.parallel("bot/message", message, host.bot, baseBotConfig);
  await waitFor(() => host.cli.captured !== undefined);
  const runningCard = host.calls.cards.find((card) =>
    cardSummaryContains(card, "执行中"),
  );
  const value = abortValueOf(runningCard!);

  // 非发起人点击被拒绝。
  const forbidden = await host.root.serial(
    "bot/card-action",
    { operatorOpenId: "ou_other", messageId: "m1", value },
    host.bot,
    baseBotConfig,
  );
  assert.equal(forbidden?.toast?.content, "只有任务发起人可以停止它。");

  // 发起人点击后停止，并写入灰色取消卡片。
  const stopped = await host.root.serial(
    "bot/card-action",
    { operatorOpenId: "ou_owner", messageId: "m1", value },
    host.bot,
    baseBotConfig,
  );
  assert.equal(stopped?.toast?.content, "已发送停止指令。");
  await waitFor(() =>
    host.calls.updates.some((card) => cardSummaryContains(card, "已取消")),
  );
});

test("任务完成后 task/result 事件驱动 reviewBy 协作交接", async () => {
  const reviewConfig: BotConfig = {
    ...baseBotConfig,
    reviewBy: "reviewer",
  };
  const host = await createHost([reviewConfig]);
  host.lark.runtimes.set("reviewer", {
    config: reviewConfig,
    bot: host.bot,
    identity: { openId: "reviewer_open", name: "Reviewer" },
  });

  const message = incomingMessage({ text: "写一个模块" });
  await host.root.parallel("bot/message", message, host.bot, reviewConfig);
  await waitFor(() => host.cli.captured !== undefined);
  host.cli.finish({ answer: "完成", sessionId: "sess-1" });

  // 协作插件监听 task/result，发出审查卡片与真实 @ 提及。
  await waitFor(() =>
    host.calls.cards.some((card) =>
      cardSummaryContains(card, "代码审查已发起"),
    ),
  );
  assert.ok(
    host.calls.mentions.some((text) => text.includes("新的代码审查任务")),
  );
});

test("/orchestrate 拆解任务、并行派发、收集结果并 /panel 展示", async () => {
  const developerConfig: BotConfig = { ...baseBotConfig, id: "developer" };
  const productConfig: BotConfig = { ...baseBotConfig, id: "product" };
  const host = await createHost([baseBotConfig, developerConfig, productConfig]);
  host.lark.runtimes.set("developer", {
    config: developerConfig,
    bot: host.bot,
    identity: { openId: "developer_open", name: "Developer" },
  });
  host.lark.runtimes.set("product", {
    config: productConfig,
    bot: host.bot,
    identity: { openId: "product_open", name: "Product" },
  });

  // 用户给编排 bot 一个大任务，命令插件启动后台拆解。
  await host.root.parallel(
    "bot/message",
    incomingMessage({
      text: "/orchestrate 检查 TASK.md 的 A、B、C 三个模块",
    }),
    host.bot,
    baseBotConfig,
  );
  await waitFor(() => host.cli.captured !== undefined);
  assert.ok(
    host.cli.captured?.prompt.includes("可派发的成员"),
    "拆解提示词必须列出可派发的成员",
  );

  // 编排 bot 的 CLI 返回结构化子任务清单。
  host.cli.finish({
    answer: JSON.stringify({
      tasks: [
        { id: "t1", prompt: "分析模块 A", bot: "developer" },
        { id: "t2", prompt: "审查模块 B", bot: "product" },
      ],
    }),
  });

  // 每个子任务都以 @ 提及派发，并携带可识别的交接单任务编号。
  await waitFor(() => host.calls.mentions.length >= 2);
  const mention = host.calls.mentions.find((text) =>
    text.includes("编排 run-001"),
  )!;
  const dispatchId = mention.match(/任务编号：([a-f0-9]{12})/)?.[1];
  assert.ok(dispatchId, "@ 派发必须携带协作交接单任务编号");
  assert.ok(
    host.calls.replies.some((text) => text.includes("已创建 run-001")),
    "编排完成后回复汇总",
  );

  // 子任务完成：task/result 事件（携带交接单）驱动编排状态为 done。
  await host.root.parallel("task/result", {
    bot: host.bot,
    botConfig: developerConfig,
    session: {
      id: "s1",
      botId: "developer",
      threadId: "thread1",
      chatId: "chat1",
      cliId: "codex",
      workspaceDir: process.cwd(),
      status: "idle",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    requestedPrompt: "分析模块 A",
    answer: "A 模块分析完成",
    replyToMessageId: "m1",
    hasThread: false,
    collaboration: {
      dispatchId: dispatchId!,
      taskId: "run-001#t1",
      fromBotId: "testbot",
      toBotId: "developer",
      round: 1,
      maxRounds: 1,
      workspaceDir: process.cwd(),
      prompt: "分析模块 A",
    },
  });

  // /panel 展示 run 进度：已完成子任务打勾、未完成保持等待。
  await host.root.parallel(
    "bot/message",
    incomingMessage({ text: "/panel" }),
    host.bot,
    baseBotConfig,
  );
  const panel = JSON.stringify(host.calls.cards[host.calls.cards.length - 1]);
  assert.ok(panel.includes("run-001"), "面板包含编排运行号");
  assert.ok(panel.includes("✅ 完成"), "已完成子任务显示完成标记");
  assert.ok(panel.includes("⏳ 等待"), "未完成子任务保持等待");
});

test("编排子任务失败经 task/failed 事件标记为失败", async () => {
  const developerConfig: BotConfig = { ...baseBotConfig, id: "developer" };
  const host = await createHost([baseBotConfig, developerConfig]);
  host.lark.runtimes.set("developer", {
    config: developerConfig,
    bot: host.bot,
    identity: { openId: "developer_open", name: "Developer" },
  });

  await host.root.parallel(
    "bot/message",
    incomingMessage({ text: "/orchestrate 检查模块 A" }),
    host.bot,
    baseBotConfig,
  );
  await waitFor(() => host.cli.captured !== undefined);
  host.cli.finish({
    answer: JSON.stringify({
      tasks: [{ id: "t1", prompt: "分析模块 A", bot: "developer" }],
    }),
  });
  await waitFor(() => host.calls.mentions.length >= 1);
  const mention = host.calls.mentions.find((text) =>
    text.includes("编排 run-001"),
  )!;
  const dispatchId = mention.match(/任务编号：([a-f0-9]{12})/)?.[1];
  assert.ok(dispatchId);

  // 子任务执行失败：task/failed 事件携带交接单，驱动子任务状态为失败。
  await host.root.parallel("task/failed", {
    bot: host.bot,
    botConfig: developerConfig,
    session: {
      id: "s1",
      botId: "developer",
      threadId: "thread1",
      chatId: "chat1",
      cliId: "codex",
      workspaceDir: process.cwd(),
      status: "idle",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    requestedPrompt: "分析模块 A",
    answer: "",
    replyToMessageId: "m1",
    hasThread: false,
    collaboration: {
      dispatchId: dispatchId!,
      taskId: "run-001#t1",
      fromBotId: "testbot",
      toBotId: "developer",
      round: 1,
      maxRounds: 1,
      workspaceDir: process.cwd(),
      prompt: "分析模块 A",
    },
  });

  await host.root.parallel(
    "bot/message",
    incomingMessage({ text: "/panel" }),
    host.bot,
    baseBotConfig,
  );
  const panel = JSON.stringify(host.calls.cards[host.calls.cards.length - 1]);
  assert.ok(panel.includes("❌ 失败"), "失败子任务在面板显示失败标记");
  assert.ok(!panel.includes("✅ 完成"), "失败子任务不显示完成标记");
});

test("/orchestrate 拆解把多个子任务分配给同一 bot 时整轮拒绝", async () => {
  const developerConfig: BotConfig = { ...baseBotConfig, id: "developer" };
  const host = await createHost([baseBotConfig, developerConfig]);
  host.lark.runtimes.set("developer", {
    config: developerConfig,
    bot: host.bot,
    identity: { openId: "developer_open", name: "Developer" },
  });

  await host.root.parallel(
    "bot/message",
    incomingMessage({ text: "/orchestrate 检查模块 A 和模块 B" }),
    host.bot,
    baseBotConfig,
  );
  await waitFor(() => host.cli.captured !== undefined);

  // 拆解结果把两个子任务都分给同一个 bot：必须整轮拒绝，避免 router busy 检查
  // 消费交接单后丢弃第二个子任务。
  host.cli.finish({
    answer: JSON.stringify({
      tasks: [
        { id: "t1", prompt: "分析模块 A", bot: "developer" },
        { id: "t2", prompt: "分析模块 B", bot: "developer" },
      ],
    }),
  });

  await waitFor(() =>
    host.calls.replies.some((text) =>
      text.includes("同一成员被分配了多个子任务"),
    ),
  );
  assert.equal(host.calls.mentions.length, 0, "拒绝后不能有任何 @ 派发");
  assert.equal(
    host.root.orchestration.list().length,
    0,
    "拒绝后不能创建 run",
  );
});

test("编排 runs 表有界：超过 MAX_RUNS 个完成的 run 后淘汰最旧", async () => {
  const developerConfig: BotConfig = { ...baseBotConfig, id: "developer" };
  const host = await createHost([baseBotConfig, developerConfig]);
  host.lark.runtimes.set("developer", {
    config: developerConfig,
    bot: host.bot,
    identity: { openId: "developer_open", name: "Developer" },
  });

  // 连续创建并完成 MAX_RUNS + 2 个 run（每个 run 一个子任务），每次拆解派发给同一 bot。
  for (let i = 0; i < MAX_RUNS + 2; i++) {
    const runNum = String(i + 1).padStart(3, "0");
    await host.root.parallel(
      "bot/message",
      incomingMessage({ text: `/orchestrate 子任务 ${i}` }),
      host.bot,
      baseBotConfig,
    );
    await waitFor(() => host.cli.captures.length === i + 1);
    host.cli.finish({
      answer: JSON.stringify({
        tasks: [{ id: "t1", prompt: `分析 ${i}`, bot: "developer" }],
      }),
    });
    await waitFor(() =>
      host.calls.replies.some((text) => text.includes(`已创建 run-${runNum}`)),
    );

    // 子任务完成：task/result 事件驱动该 run 进入全终态，触发淘汰清理。
    await host.root.parallel("task/result", {
      bot: host.bot,
      botConfig: developerConfig,
      session: {
        id: "s1",
        botId: "developer",
        threadId: "thread1",
        chatId: "chat1",
        cliId: "codex",
        workspaceDir: process.cwd(),
        status: "idle",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      requestedPrompt: `分析 ${i}`,
      answer: "ok",
      replyToMessageId: "m1",
      hasThread: false,
      collaboration: {
        dispatchId: `d${i}`,
        taskId: `run-${runNum}#t1`,
        fromBotId: "testbot",
        toBotId: "developer",
        round: 1,
        maxRounds: 1,
        workspaceDir: process.cwd(),
        prompt: `分析 ${i}`,
      },
    });
  }

  const runs = host.root.orchestration.list();
  assert.ok(runs.length <= MAX_RUNS, "runs 表不能超过 MAX_RUNS 条");
  const ids = runs.map((run) => run.runId);
  assert.ok(!ids.includes("run-001"), "最旧的 run 已被淘汰");
  assert.ok(ids.includes("run-022"), "最新的 run 保留");
});
