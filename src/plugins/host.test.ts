/**
 * host 集成测试：用真实服务插件 + 假平台/假执行引擎组装一个最小 Agent OS，
 * 验证事件路由、命令派发、任务生命周期、停止与协作交接的完整链路。
 * 这里是“一切皆为插件”装配方式的端到端验证：替换 lark/cli 实现即可测试。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context, Service } from "cordis";
import type { BotConfig } from "../core/bot-registry.js";
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
import * as cardsPlugin from "./cards.js";
import * as collaborationPlugin from "./collaboration.js";
import * as commandsPlugin from "./commands.js";
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
    root.plugin(cardsPlugin),
    root.plugin(commandsPlugin),
    root.plugin(statusCommand),
    root.plugin(teamCommand),
    root.plugin(collaborationPlugin),
    root.plugin(tasksPlugin),
    root.plugin(routerPlugin),
  ]);
  // mount fiber 不等待深层 inject 级联，必须等全部插件 ACTIVE 再发事件。
  await waitForAllActive(root);

  lark.runtimes.set("testbot", {
    config: baseBotConfig,
    bot: fakeBot.bot,
    identity: { openId: "bot_open", name: "TestBot" },
  });

  return { root, cli, lark, bot: fakeBot.bot, calls: fakeBot.calls };
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
