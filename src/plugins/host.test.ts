/**
 * host 集成测试：用真实服务插件 + 假平台/假执行引擎组装一个最小 ThreadPilot，
 * 验证事件路由、命令派发、任务生命周期、停止与协作交接的完整链路。
 * 这里是“一切皆为插件”装配方式的端到端验证：替换 lark/cli 实现即可测试。
 */
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Context, Service } from "cordis";
import type { BotConfig } from "../core/bot-registry.js";
import { createInteractionPolicy } from "../core/interaction-policy.js";
import { MAX_RUNS } from "../core/orchestration.js";
import { MAX_PROCESSED_TURNS } from "./collaboration.js";
import type { CollaborationMessage } from "../core/collaboration.js";
import type { Session } from "../core/session-manager.js";
import type { TeamCardOptions } from "../im/card.js";
import type {
  Bot,
  BotConnectionState,
  BotIdentity,
  IncomingMessage,
} from "../im/lark.js";
import type {
  CliAdapter,
  CliEvent,
  CliRunResult,
  CliSessionSummary,
} from "../cli/types.js";
import { CliRunError, type RunCliOptions } from "../cli/runner.js";
import * as applicationToolsPlugin from "./application-tools.js";
import * as cardsPlugin from "./cards.js";
import * as clarificationPlugin from "./clarification.js";
import * as collaborationPlugin from "./collaboration.js";
import * as dispatchTaskPlugin from "./dispatch-task.js";
import * as commandsPlugin from "./commands.js";
import * as docCommand from "./commands/doc.js";
import * as orchestrationPlugin from "./orchestration.js";
import * as orchestrationActions from "./orchestration/actions.js";
import * as orchestrationLivePanel from "./orchestration/live-panel.js";
import * as productSpecPlugin from "./product-spec.js";
import * as productCommentsPlugin from "./product-comments.js";
import * as promptsPlugin from "./prompts.js";
import * as qaGatePlugin from "./qa-gate.js";
import * as orchestrateCommand from "./commands/orchestrate.js";
import * as panelCommand from "./commands/panel.js";
import * as statusCommand from "./commands/status.js";
import * as teamCommand from "./commands/team.js";
import * as routerPlugin from "./router.js";
import * as sessionsPlugin from "./sessions.js";
import * as tasksPlugin from "./tasks.js";
import * as teamPlugin from "./team.js";
import * as workspacesPlugin from "./workspaces.js";
import { waitForAllActive } from "./loader.js";
import { retryToken } from "../core/orchestration.js";
import type {
  BotRuntime,
  TaskResultPayload,
  TaskToolCallsPayload,
} from "./types.js";

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
  readonly defaultProductDeliveryMode = "lark-doc" as const;

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
  isSessionUnavailable: (message) => message.includes("session expired"),
};

/** 假执行引擎：捕获调用参数，由测试控制何时完成或取消。 */
class FakeCliService extends Service {
  captured: RunCliOptions | undefined;
  readonly captures: RunCliOptions[] = [];
  compactOptions: unknown;
  private resolver: ((result: CliRunResult) => void) | undefined;
  private nextError: unknown;
  private nextEvents: CliEvent[] = [];
  /** 全部挂起的 run 的解析器：并行测试中同一 bot 多个任务同时挂起时批量完成。 */
  private readonly resolvers: Array<(result: CliRunResult) => void> = [];
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
    if (this.nextError !== undefined) {
      const error = this.nextError;
      this.nextError = undefined;
      for (const event of this.nextEvents.splice(0)) options.onEvent?.(event);
      return Promise.reject(error);
    }
    return new Promise((resolve) => {
      this.resolver = resolve;
      this.resolvers.push(resolve);
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

  failNext(error: unknown, events: CliEvent[] = []): void {
    this.nextError = error;
    this.nextEvents = events;
  }

  /** 一次性完成全部挂起的 run（同一 bot 并行多任务时使用），让任务收尾清理定时器。 */
  finishAll(result: CliRunResult): void {
    for (const resolve of this.resolvers.splice(0)) resolve(result);
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
  failOptions: {
    replyCard?: boolean;
    emptyReplyCard?: boolean;
    updateCard?: boolean;
    failUpdateCardAt?: number;
    sendMention?: boolean;
    emptyReplyMention?: boolean;
    emptySendMention?: boolean;
  } = {},
) {
  const calls = {
    replies: [] as string[],
    cards: [] as Record<string, unknown>[],
    mentions: [] as string[],
    sentToChat: [] as { chatId: string; target: BotIdentity; text: string }[],
    updates: [] as Record<string, unknown>[],
    downloads: [] as {
      messageId: string;
      key: string;
      type: "image" | "file";
      fileName?: string;
    }[],
    documentCommentReplies: [] as string[],
    documentCommentReactions: [] as { active: boolean }[],
  };
  let updateCardAttempts = 0;
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
      if (failOptions.replyCard) throw new Error("模拟：首次挂卡片失败");
      calls.cards.push(card);
      if (failOptions.emptyReplyCard) return undefined;
      return `card-${calls.cards.length}`;
    },
    replyMention: async (_id: string, _target: BotIdentity, text: string) => {
      calls.mentions.push(text);
      if (failOptions.emptyReplyMention) return undefined;
      return `mention-${calls.mentions.length}`;
    },
    sendMentionToChat: async (
      chatId: string,
      target: BotIdentity,
      text: string,
    ) => {
      if (failOptions.sendMention) throw new Error("模拟：@ 派发消息失败");
      calls.sentToChat.push({ chatId, target, text });
      if (failOptions.emptySendMention) return undefined;
      return `chat-msg-${calls.sentToChat.length}`;
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
      updateCardAttempts += 1;
      if (
        failOptions.updateCard ||
        failOptions.failUpdateCardAt === updateCardAttempts
      ) {
        throw new Error("模拟：更新卡片失败");
      }
      calls.updates.push(card);
    },
    downloadResource: async (
      messageId: string,
      key: string,
      type: "image" | "file",
      _saveDir: string,
      fileName?: string,
    ) => {
      calls.downloads.push({ messageId, key, type, fileName });
      return join(process.cwd(), "data", "downloads", "x");
    },
    replyToDocumentComment: async (_comment: unknown, text: string) => {
      calls.documentCommentReplies.push(text);
    },
    setDocumentCommentWorking: async (_comment: unknown, active: boolean) => {
      calls.documentCommentReactions.push({ active });
    },
  } as unknown as Bot;
  return { bot, calls };
}

function incomingMessage(overrides: Partial<IncomingMessage>): IncomingMessage {
  const text = overrides.text ?? "";
  return {
    messageId: "m1",
    chatId: "chat1",
    // 集成测试默认覆盖群聊/团队模式；私聊行为由用例显式传入 chatType=p2p。
    chatType: "group",
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

function clarificationValueOf(
  card: Record<string, unknown>,
  optionId?: string,
): Record<string, unknown> {
  const elements = (card.body as { elements?: unknown[] } | undefined)
    ?.elements ?? [];
  for (const element of elements) {
    const behaviors = (element as { behaviors?: { value?: unknown }[] })
      .behaviors ?? [];
    for (const behavior of behaviors) {
      const value = behavior.value as
        | { action?: string; optionId?: string }
        | undefined;
      if (
        value?.action === "answer_clarification" &&
        (!optionId || value.optionId === optionId)
      ) {
        return value as Record<string, unknown>;
      }
    }
  }
  throw new Error("卡片里找不到澄清回答按钮");
}

/** 从产品方案待确认卡里取出一次性确认 token。 */
function productSpecValueOf(
  card: Record<string, unknown>,
  filter?: (value: Record<string, unknown>) => boolean,
): Record<string, unknown> {
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
        (value as { action?: string }).action === "approve_product_spec"
      ) {
        const record = value as Record<string, unknown>;
        if (!filter || filter(record)) return record;
      }
    }
  }
  throw new Error("卡片里找不到产品方案确认按钮");
}

/** 从编排面板卡片里取出「重试」按钮携带的 runId/subTaskId/retryToken。 */
function retrySubtaskValueOf(
  card: Record<string, unknown>,
): Record<string, unknown> {
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
        (value as { action?: string }).action === "retry_subtask"
      ) {
        return value as Record<string, unknown>;
      }
    }
  }
  throw new Error("卡片里找不到重试按钮");
}

function cardSummaryContains(
  card: Record<string, unknown>,
  text: string,
): boolean {
  return JSON.stringify(card).includes(text);
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10_000,
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

/** 组装一个最小 ThreadPilot 宿主：真实服务插件 + 假 cli/lark/config。 */
async function createHost(
  bots: BotConfig[] = [baseBotConfig],
  connectionState: BotConnectionState = "connected",
  orchestrationConfig: Record<string, unknown> = {},
  livePanel = false,
  actions = false,
  botFailOptions: {
    replyCard?: boolean;
    emptyReplyCard?: boolean;
    updateCard?: boolean;
    failUpdateCardAt?: number;
    sendMention?: boolean;
    emptyReplyMention?: boolean;
    emptySendMention?: boolean;
  } = {},
): Promise<Host> {
  const root = new Context();
  const fakeBot = createFakeBot(connectionState, botFailOptions);
  let cli!: FakeCliService;
  let lark!: FakeLarkService;
  const sessionsDir = await mkdtemp(join(tmpdir(), "threadpilot-host-"));
  tempDirs.push(sessionsDir);
  // 编排安全边界要求不同 bot 使用不同工作目录；测试宿主为每个成员创建隔离目录，
  // 需要验证冲突的用例可在挂载后显式构造同路径配置。
  const configuredBots = await Promise.all(
    bots.map(async (config) => {
      const workspaceDir = join(sessionsDir, `workspace-${config.id}`);
      await mkdir(workspaceDir, { recursive: true });
      return { ...config, workspaceDir };
    }),
  );

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
    root.plugin(configPlugin, { bots: configuredBots }),
    root.plugin(promptsPlugin),
    root.plugin(teamPlugin),
    root.plugin(cliPlugin),
    root.plugin(larkPlugin),
    root.plugin(sessionsPlugin, { storePath: join(sessionsDir, "s.json") }),
    root.plugin(applicationToolsPlugin),
    root.plugin(cardsPlugin),
    root.plugin(commandsPlugin),
    root.plugin(docCommand),
    root.plugin(statusCommand),
    root.plugin(teamCommand),
    root.plugin(collaborationPlugin),
    root.plugin(workspacesPlugin),
    root.plugin(qaGatePlugin),
    root.plugin(orchestrationPlugin, orchestrationConfig),
    // live-panel 是可选的：不传即回退为“仅汇总文本”，保持现有 /orchestrate 行为。
    ...(livePanel ? [root.plugin(orchestrationLivePanel)] : []),
    // actions 是可选的：装配后面板渲染重试按钮并认领 retry_subtask 卡片动作。
    ...(actions ? [root.plugin(orchestrationActions)] : []),
    root.plugin(orchestrateCommand),
    root.plugin(panelCommand),
    root.plugin(tasksPlugin),
    root.plugin(clarificationPlugin),
    root.plugin(routerPlugin),
  ]);
  // mount fiber 不等待深层 inject 级联，必须等全部插件 ACTIVE 再发事件。
  await waitForAllActive(root);

  lark.runtimes.set("testbot", {
    config: configuredBots.find((bot) => bot.id === "testbot") ?? baseBotConfig,
    bot: fakeBot.bot,
    identity: { openId: "bot_open", name: "TestBot" },
  });

  return {
    root,
    cli,
    lark,
    bot: fakeBot.bot,
    calls: fakeBot.calls,
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

test("bot/message 群消息按 @ 目标收敛：未提及本 bot 不启动任务", async () => {
  const host = await createHost();
  // 群里一条消息 @ 了另一个机器人（testbot 的 identity.openId=bot_open）：
  // 同一条事件会被推送进所有 bot 应用，非目标 bot 必须忽略。
  const mentionedOther = incomingMessage({
    text: "把任务交给 PM",
    mentions: [{ key: "@_user_1", name: "PM", openId: "ou_other_bot" }],
  });
  await host.root.parallel(
    "bot/message",
    mentionedOther,
    host.bot,
    baseBotConfig,
  );
  assert.equal(
    host.cli.captures.length,
    0,
    "mention 目标不是本 bot 时不得启动 CLI",
  );

  // 同一条消息在“本 bot 应用”视角下 mention 命中了本 bot 的 open_id，必须响应。
  const mentionedMe = incomingMessage({
    text: "把任务交给 TestBot",
    mentions: [{ key: "@_user_1", name: "TestBot", openId: "bot_open" }],
  });
  await host.root.parallel(
    "bot/message",
    mentionedMe,
    host.bot,
    baseBotConfig,
  );
  await waitFor(() => host.cli.captured !== undefined);
  assert.ok(
    host.cli.captures.length >= 1,
    "mention 命中本 bot 时应启动任务",
  );
  // 收尾挂起的执行，避免测试悬挂。
  host.cli.finish({ answer: "ok", sessionId: "sess-1" });
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

test("task/prompt-compose：团队外 bot 降级不注入团队上下文而不是抛错", async () => {
  const host = await createHost();

  // 团队内的成员应拿到团队上下文片段，作为 tasks 的提示词来源。
  const known = await host.root.prompts.composeTaskPrompt(
    baseBotConfig,
    "执行任务",
    { interaction: createInteractionPolicy("team") },
  );
  assert.ok(known.includes("你所在的 Agent 团队"), "团队成员应注入团队上下文");

  // 用户私聊指挥单个成员时不应注入团队上下文，成员直接按指令干活。
  const direct = await host.root.prompts.composeTaskPrompt(
    baseBotConfig,
    "执行任务",
    { interaction: createInteractionPolicy("direct") },
  );
  assert.doesNotMatch(direct, /你所在的 Agent 团队/, "私聊应跳过团队上下文");

  // 不在团队名册中的 bot 必须安静降级，不能让 contextFor 的异常打断任务启动。
  const unknown = await host.root.prompts.composeTaskPrompt(
    { ...baseBotConfig, id: "ghost" },
    "执行任务",
    { interaction: createInteractionPolicy("team") },
  );
  assert.doesNotMatch(unknown, /你所在的 Agent 团队/, "团队外 bot 应跳过团队上下文");
});

test("CLI 超时仅在显式配置时启用，并支持按引擎覆盖", () => {
  assert.equal(tasksPlugin.cliExecutionTimeoutMs("codex", {}), undefined);
  assert.equal(
    tasksPlugin.cliExecutionTimeoutMs("codex", {
      CLI_TIMEOUT_MS: "6000",
      CODEX_TIMEOUT_MS: "9000",
    }),
    9_000,
  );
  assert.equal(
    tasksPlugin.cliExecutionTimeoutMs("custom-engine", {
      CUSTOM_ENGINE_TIMEOUT_MS: "12000",
    }),
    12_000,
  );
  assert.throws(
    () => tasksPlugin.cliExecutionTimeoutMs("codex", { CLI_TIMEOUT_MS: "0" }),
    /必须是正整数毫秒值/,
  );
});

test("私聊成员不注入团队上下文，直接按指令干活", async () => {
  const host = await createHost();
  await host.root.parallel(
    "bot/message",
    incomingMessage({ text: "帮我重构 src/core 目录", chatType: "p2p" }),
    host.bot,
    baseBotConfig,
  );
  await waitFor(() => host.cli.captured !== undefined);
  assert.ok(
    host.cli.captured,
    "私聊任务应正常启动",
  );
  const prompt = host.cli.captured!.prompt;
  assert.ok(
    !prompt.includes("你所在的 Agent 团队"),
    "私聊任务不应注入团队上下文",
  );
  assert.ok(
    prompt.includes("你是用户的直接执行助手"),
    "私聊任务应把团队型角色切换为直接执行者",
  );
  assert.doesNotMatch(prompt, /除非用户明确要求协作/);
  assert.match(prompt, /如需协作，请让用户在群聊或话题中发起任务/);

  // 完成任务让 tasks 收尾清理定时器，避免测试进程挂住。
  host.cli.finish({ answer: "重构完成", sessionId: "sess-1" });
  await waitFor(() =>
    host.calls.mentions.some((text) => text.includes("任务已完成")),
  );
});

test("私聊普通任务忽略 bot 业务提示词和产品文档流程", async () => {
  const productConfig: BotConfig = {
    ...baseBotConfig,
    skills: ["grill-me", "lark-doc"],
    role: "产品经理",
    systemPrompt: "必须先写产品方案并提交审批。",
  };
  const host = await createHost([productConfig]);
  await host.root.plugin(productSpecPlugin);
  await waitForAllActive(host.root);
  const runtimeConfig = host.root.config.bot("testbot")!;

  await host.root.parallel(
    "bot/message",
    incomingMessage({
      text: "帮我直接整理这段需求",
      chatType: "p2p",
      senderOpenId: "ou_direct",
    }),
    host.bot,
    runtimeConfig,
  );
  await waitFor(() => host.cli.captured !== undefined);
  const prompt = host.cli.captured!.prompt;
  assert.ok(prompt.includes("你是用户的直接执行助手"));
  assert.ok(!prompt.includes("产品经理"));
  assert.ok(!prompt.includes("必须先写产品方案并提交审批"));
  assert.ok(!prompt.includes("产品方案交付规则"));
  assert.ok(!prompt.includes("lark-cli 身份规则"));
  assert.ok(!prompt.includes("<project-skill"));
  assert.match(prompt, /未通过 \/doc 显式请求时，不要创建、编辑或上传飞书云文档/);

  host.cli.finish({ answer: "已整理", sessionId: "sess-direct-plain" });
  await waitFor(() => host.calls.mentions.some((text) => text.includes("任务已完成")));
  assert.equal(host.cli.captures.length, 1, "私聊普通任务不应触发产品方案纠正轮");
  assert.equal(
    host.calls.cards.some((card) => cardSummaryContains(card, "产品文档")),
    false,
    "私聊普通任务不应生成产品方案卡片",
  );
});

test("/doc 缺少任务参数时回复用法并把新会话置为 idle", async () => {
  const host = await createHost();
  const botConfig = host.root.config.bot("testbot")!;
  const message = incomingMessage({ text: "/doc" });

  await host.root.parallel("bot/message", message, host.bot, botConfig);

  assert.equal(host.cli.captures.length, 0);
  assert.ok(host.calls.replies.some((text) => text.includes("用法：/doc <任务>")));
  const resolved = await host.root.sessions.manager.resolve(
    message,
    botConfig.defaultCliId,
    botConfig.id,
    botConfig.workspaceDir,
    botConfig.accessMode,
  );
  assert.equal(resolved.isNew, false);
  assert.equal(resolved.session.status, "idle");
});

test("私聊 /doc 显式开启文档交付，但不触发团队或产品审批", async () => {
  const productConfig: BotConfig = {
    ...baseBotConfig,
    skills: ["grill-me", "lark-doc"],
    role: "产品经理",
    systemPrompt: "必须先写产品方案并提交审批。",
  };
  const host = await createHost([productConfig]);
  await host.root.plugin(productSpecPlugin);
  await waitForAllActive(host.root);
  const runtimeConfig = host.root.config.bot("testbot")!;
  let resultPayload: TaskResultPayload | undefined;
  host.root.on("task/result", (payload) => {
    resultPayload = payload;
  });

  await host.root.parallel(
    "bot/message",
    incomingMessage({
      text: "/doc 汇总本周发布说明",
      chatType: "p2p",
      messageType: "post",
      rawContent: JSON.stringify({
        content: [[
          { tag: "text", text: "/doc 汇总本周发布说明" },
          { tag: "img", image_key: "img_doc_release" },
        ]],
      }),
      senderOpenId: "ou_doc",
    }),
    host.bot,
    runtimeConfig,
  );
  await waitFor(() => host.cli.captured !== undefined);
  const prompt = host.cli.captured!.prompt;
  assert.ok(prompt.includes("用户通过 /doc 显式请求文档交付"));
  assert.ok(prompt.includes("<project-skill name=\"lark-doc\""));
  assert.ok(!prompt.includes("产品方案交付规则"));
  assert.ok(!prompt.includes("必须先写产品方案并提交审批"));
  assert.deepEqual(host.calls.downloads, [{
    messageId: "m1",
    key: "img_doc_release",
    type: "image",
    fileName: undefined,
  }]);

  host.cli.finish({
    answer: "已生成文档：https://example.feishu.cn/docx/DirectDoc123",
    sessionId: "sess-direct-doc",
  });
  await waitFor(() => host.calls.mentions.some((text) => text.includes("任务已完成")));
  assert.equal(resultPayload?.interaction?.documentRequested, true);
});

test("私聊 /doc 澄清恢复后仍保留文档交付语义", async () => {
  const productConfig: BotConfig = {
    ...baseBotConfig,
    skills: ["grill-me", "lark-doc"],
    role: "产品经理",
    systemPrompt: "必须先写产品方案并提交审批。",
  };
  const host = await createHost([productConfig]);
  await host.root.plugin(productSpecPlugin);
  await waitForAllActive(host.root);

  await host.root.parallel(
    "bot/message",
    incomingMessage({
      text: "/doc 形成一份发布说明",
      chatType: "p2p",
      senderOpenId: "ou_doc_clarify",
    }),
    host.bot,
    productConfig,
  );
  await waitFor(() => host.cli.captured !== undefined);
  host.cli.finish({
    answer: "需要确认格式。",
    sessionId: "sess-direct-doc-clarify",
    toolCalls: [{
      toolUseId: "tool-doc-clarify",
      toolName: "request_clarification",
      input: {
        title: "确认发布说明格式",
        questions: [{
          id: "format",
          prompt: "采用哪种格式？",
          options: [
            { id: "brief", label: "简版" },
            { id: "full", label: "完整版" },
          ],
        }],
      },
    }],
  });
  await waitFor(() =>
    host.calls.updates.some((card) => cardSummaryContains(card, "确认发布说明格式")),
  );
  const waitingCard = host.calls.updates.find((card) =>
    cardSummaryContains(card, "采用哪种格式"),
  )!;
  const response = await host.root.serial(
    "bot/card-action",
    {
      operatorOpenId: "ou_doc_clarify",
      messageId: "card-1",
      value: clarificationValueOf(waitingCard, "full"),
    },
    host.bot,
    productConfig,
  );
  assert.equal(response?.toast?.content, "答案已收到。");
  await waitFor(() => host.cli.captures.length === 2);
  assert.match(host.cli.captures[1]?.prompt ?? "", /<project-skill name="lark-doc"/);
  assert.match(host.cli.captures[1]?.prompt ?? "", /用户通过 \/doc 显式请求文档交付/);
  assert.doesNotMatch(host.cli.captures[1]?.prompt ?? "", /产品方案交付规则/);
  host.cli.finish({
    answer: "已生成文档：https://example.feishu.cn/docx/ClarifiedDoc123",
    sessionId: "sess-direct-doc-clarify",
  });
  await waitFor(() =>
    host.calls.mentions.some((text) => text.includes("任务已完成")),
  );
});

test("/doc 澄清后直接发送文字会使旧卡失效并保留文档策略", async () => {
  const productConfig: BotConfig = {
    ...baseBotConfig,
    skills: ["lark-doc"],
  };
  const host = await createHost([productConfig]);
  const runtimeConfig = host.root.config.bot("testbot")!;
  const original = incomingMessage({
    messageId: "m-doc-root",
    text: "/doc 形成一份发布说明",
    chatType: "p2p",
    senderOpenId: "ou_doc_text",
  });

  await host.root.parallel("bot/message", original, host.bot, runtimeConfig);
  await waitFor(() => host.cli.captures.length === 1);
  host.cli.finish({
    answer: "需要确认发布范围。",
    sessionId: "sess-doc-text",
    toolCalls: [{
      toolUseId: "tool-doc-text",
      toolName: "request_clarification",
      input: {
        title: "确认发布范围",
        questions: [{
          id: "scope",
          prompt: "包含哪些版本？",
          options: [
            { id: "current", label: "仅当前版本" },
            { id: "all", label: "全部版本" },
          ],
        }],
      },
    }],
  });
  await waitFor(() =>
    host.calls.updates.some((card) => cardSummaryContains(card, "确认发布范围")),
  );
  const oldCard = host.calls.updates.find((card) =>
    cardSummaryContains(card, "包含哪些版本"),
  )!;

  await host.root.parallel(
    "bot/message",
    incomingMessage({
      messageId: "m-doc-follow-up",
      rootId: "m-doc-root",
      text: "只需要当前版本，并附上升级步骤",
      chatType: "p2p",
      senderOpenId: "ou_doc_text",
    }),
    host.bot,
    runtimeConfig,
  );
  await waitFor(() => host.cli.captures.length === 2);
  assert.equal(host.cli.captures[1]?.sessionId, "sess-doc-text");
  assert.match(host.cli.captures[1]?.prompt ?? "", /只需要当前版本，并附上升级步骤/);
  assert.match(host.cli.captures[1]?.prompt ?? "", /<project-skill name="lark-doc"/);
  assert.match(host.cli.captures[1]?.prompt ?? "", /用户通过 \/doc 显式请求文档交付/);
  assert.ok(host.calls.updates.some((card) => cardSummaryContains(card, "已更新")));

  const expired = await host.root.serial(
    "bot/card-action",
    {
      operatorOpenId: "ou_doc_text",
      messageId: "card-1",
      value: clarificationValueOf(oldCard, "current"),
    },
    host.bot,
    runtimeConfig,
  );
  assert.equal(expired?.toast?.content, "这组澄清问题已经失效。");
  host.cli.finish({
    answer: "已生成文档：https://example.feishu.cn/docx/DocText123",
    sessionId: "sess-doc-text",
  });
  await waitFor(() =>
    host.calls.mentions.some((text) => text.includes("任务已完成")),
  );
});

test("首轮 /doc 准备期间收到第二条 /doc 时只启动一轮", async (t) => {
  const host = await createHost();
  const botConfig = host.root.config.bot("testbot")!;
  const manager = host.root.sessions.manager;
  const originalTransition = manager.transition.bind(manager);
  let activeTransitionAttempts = 0;
  let notifyActiveTransition!: () => void;
  let releaseActiveTransition!: () => void;
  const activeTransitionReached = new Promise<void>((resolve) => {
    notifyActiveTransition = resolve;
  });
  const activeTransitionGate = new Promise<void>((resolve) => {
    releaseActiveTransition = resolve;
  });
  t.after(() => {
    releaseActiveTransition();
    manager.transition = originalTransition;
  });
  // 卡住新会话的 active 认领，验证 creating 状态下第二条 /doc 仍会被拒绝。
  manager.transition = (async (sessionId, nextStatus) => {
    if (nextStatus === "active") {
      activeTransitionAttempts += 1;
      notifyActiveTransition();
      await activeTransitionGate;
    }
    return originalTransition(sessionId, nextStatus);
  }) as typeof manager.transition;

  const firstDelivery = host.root.parallel(
    "bot/message",
    incomingMessage({
      messageId: "m-doc-creating",
      text: "/doc 生成第一份说明",
    }),
    host.bot,
    botConfig,
  );
  await activeTransitionReached;

  await host.root.parallel(
    "bot/message",
    incomingMessage({
      messageId: "m-doc-during-creating",
      rootId: "m-doc-creating",
      text: "/doc 生成第二份说明",
    }),
    host.bot,
    botConfig,
  );

  assert.equal(host.cli.captures.length, 0);
  assert.equal(activeTransitionAttempts, 1);
  assert.ok(
    host.calls.replies.some((text) =>
      text.includes("当前会话正在准备，请稍后再使用 /doc")),
  );
  releaseActiveTransition();
  await firstDelivery;
  await waitFor(() => host.cli.captures.length === 1);
  assert.match(host.cli.captures[0]?.prompt ?? "", /生成第一份说明/);
  assert.doesNotMatch(host.cli.captures[0]?.prompt ?? "", /生成第二份说明/);
  host.cli.finish({ answer: "文档已生成。", sessionId: "sess-doc-creating" });
  await waitFor(() =>
    host.calls.mentions.some((text) => text.includes("任务已完成")),
  );
});

test("idle 会话准备任务时第二条消息被拒绝且只启动一轮", async (t) => {
  const host = await createHost();
  const botConfig = host.root.config.bot("testbot")!;
  const manager = host.root.sessions.manager;
  const rootMessage = incomingMessage({
    messageId: "m-idle-race-root",
    text: "建立空闲会话",
  });
  const resolved = await manager.resolve(
    rootMessage,
    botConfig.defaultCliId,
    botConfig.id,
    botConfig.workspaceDir,
    botConfig.accessMode,
  );
  await manager.transition(resolved.session.id, "idle");

  const originalSetRetryPrompt = manager.setRetryPrompt.bind(manager);
  let firstAttempt = true;
  let notifyPreparing!: () => void;
  let releasePreparing!: () => void;
  const preparingReached = new Promise<void>((resolve) => {
    notifyPreparing = resolve;
  });
  const preparingGate = new Promise<void>((resolve) => {
    releasePreparing = resolve;
  });
  t.after(() => {
    releasePreparing();
    manager.setRetryPrompt = originalSetRetryPrompt;
  });
  manager.setRetryPrompt = (async (sessionId, retryPrompt) => {
    if (firstAttempt) {
      firstAttempt = false;
      notifyPreparing();
      await preparingGate;
    }
    return originalSetRetryPrompt(sessionId, retryPrompt);
  }) as typeof manager.setRetryPrompt;

  const firstDelivery = host.root.parallel(
    "bot/message",
    incomingMessage({
      messageId: "m-idle-race-first",
      rootId: rootMessage.messageId,
      text: "执行第一条任务",
    }),
    host.bot,
    botConfig,
  );
  await preparingReached;

  await host.root.parallel(
    "bot/message",
    incomingMessage({
      messageId: "m-idle-race-second",
      rootId: rootMessage.messageId,
      text: "执行第二条任务",
    }),
    host.bot,
    botConfig,
  );
  await waitFor(() =>
    host.calls.replies.some((text) => text.includes("当前会话还在执行")) ||
    host.cli.captures.length > 0,
  );

  assert.equal(manager.get(resolved.session.id)?.status, "active");
  assert.equal(host.cli.captures.length, 0);
  assert.ok(
    host.calls.replies.some((text) => text.includes("当前会话还在执行")),
  );

  releasePreparing();
  await firstDelivery;
  await waitFor(() => host.cli.captures.length === 1);
  assert.match(host.cli.captures[0]?.prompt ?? "", /执行第一条任务/);
  assert.doesNotMatch(host.cli.captures[0]?.prompt ?? "", /执行第二条任务/);
  host.cli.finish({ answer: "第一条任务完成。", sessionId: "sess-idle-race" });
  await waitFor(() =>
    host.calls.mentions.some((text) => text.includes("任务已完成")),
  );
});

test("私聊结果即使配置 reviewBy 也不触发 QA bot 交接", async () => {
  const reviewerConfig: BotConfig = { ...baseBotConfig, id: "reviewer" };
  const developerConfig: BotConfig = {
    ...baseBotConfig,
    reviewBy: "reviewer",
  };
  const host = await createHost([developerConfig, reviewerConfig]);
  host.lark.runtimes.set("reviewer", {
    config: reviewerConfig,
    bot: host.bot,
    identity: { openId: "reviewer_open", name: "reviewer" },
  });

  await host.root.parallel(
    "bot/message",
    incomingMessage({ text: "私聊直接完成", chatType: "p2p" }),
    host.bot,
    developerConfig,
  );
  await waitFor(() => host.cli.captured !== undefined);
  host.cli.finish({ answer: "已完成", sessionId: "sess-direct-review" });
  await waitFor(() => host.calls.mentions.some((text) => text.includes("任务已完成")));
  assert.equal(
    host.calls.cards.some((card) => cardSummaryContains(card, "QA 审查")),
    false,
  );
  assert.equal(
    host.calls.mentions.some((text) => text.includes("新的协作任务")),
    false,
  );
});

test("私聊 /orchestrate 不启动团队编排", async () => {
  const host = await createHost();
  await host.root.parallel(
    "bot/message",
    incomingMessage({ text: "/orchestrate 拆分任务", chatType: "p2p" }),
    host.bot,
    baseBotConfig,
  );
  assert.ok(host.calls.replies.some((text) => text.includes("不会与其他 bot 互动")));
  assert.equal(host.cli.captures.length, 0);
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

test("任务卡片响应缺少 message_id 时 startTask 返回失败并回收会话", async () => {
  const host = await createHost(
    [baseBotConfig],
    "connected",
    {},
    false,
    false,
    { emptyReplyCard: true },
  );
  const botConfig = host.root.config.bot("testbot")!;
  const resolved = await host.root.sessions.manager.resolve(
    incomingMessage({ text: "执行看板任务" }),
    botConfig.defaultCliId,
    botConfig.id,
    botConfig.workspaceDir,
    botConfig.accessMode,
  );

  const started = await host.root.tasks.startTask({
    bot: host.bot,
    botConfig,
    session: resolved.session,
    hasThread: false,
    replyToMessageId: "message-without-card-id",
    senderOpenId: "ou_owner",
    taskId: "board-start-failed",
    requestedPrompt: "执行看板任务",
    isCompacting: false,
    resources: [],
  });

  assert.equal(started, false);
  assert.equal(host.cli.captures.length, 0);
  assert.equal(host.root.sessions.manager.get(resolved.session.id)?.status, "idle");
});

test("任务准备失败时释放运行实例并把会话恢复为 idle", async () => {
  const host = await createHost();
  const botConfig = host.root.config.bot("testbot")!;
  const manager = host.root.sessions.manager;
  const resolved = await manager.resolve(
    incomingMessage({ text: "准备阶段失败" }),
    botConfig.defaultCliId,
    botConfig.id,
    botConfig.workspaceDir,
    botConfig.accessMode,
  );
  manager.setRetryPrompt = async () => {
    throw new Error("模拟：保存重试指令失败");
  };

  const started = await host.root.tasks.startTask({
    bot: host.bot,
    botConfig,
    session: resolved.session,
    hasThread: false,
    replyToMessageId: "message-preparation-failed",
    senderOpenId: "ou_owner",
    taskId: "preparation-failed",
    requestedPrompt: "准备阶段失败",
    isCompacting: false,
    resources: [],
  });

  assert.equal(started, false);
  assert.equal(host.root.tasks.activeRunCount, 0);
  assert.equal(manager.get(resolved.session.id)?.status, "idle");
  assert.equal(host.calls.cards.length, 0);
  assert.equal(host.cli.captures.length, 0);
});

test("普通消息启动失败时向用户返回明确提示", async () => {
  const host = await createHost(
    [baseBotConfig],
    "connected",
    {},
    false,
    false,
    { emptyReplyCard: true },
  );

  await host.root.parallel(
    "bot/message",
    incomingMessage({ text: "执行但无法创建任务卡片" }),
    host.bot,
    baseBotConfig,
  );

  assert.ok(
    host.calls.replies.some((text) => text.includes("任务未能启动，请稍后重试")),
  );
});

test("普通任务走完卡片、执行与结果通知的生命周期", async () => {
  const host = await createHost();
  let startedTraceId: string | undefined;
  let resultPayload: TaskResultPayload | undefined;
  host.root.on("task/started", (payload) => {
    startedTraceId = payload.traceId;
  });
  host.root.on("task/result", (payload) => {
    resultPayload = payload;
  });
  // 群聊消息保留团队上下文（interaction.mode=team）。
  const message = incomingMessage({
    text: "写一个 hello world",
    chatType: "group",
  });
  await host.root.parallel("bot/message", message, host.bot, baseBotConfig);
  await waitFor(() => host.cli.captured !== undefined);
  assert.ok(
    host.cli.captured?.prompt.includes("你所在的 Agent 团队"),
    "team 插件应通过 task/prompt-compose 注入团队上下文",
  );
  assert.ok(startedTraceId, "CLI 启动前应广播 task/started");

  // 任务卡片已发出，且携带可停止的按钮。
  assert.ok(
    host.calls.cards.some((card) => cardSummaryContains(card, "执行中")),
  );

  host.cli.captured?.onEvent?.({
    type: "tool_start",
    toolUseId: "tool-failed",
    toolName: "shell",
    label: "运行命令",
  });
  host.cli.captured?.onEvent?.({
    type: "tool_end",
    toolUseId: "tool-failed",
    failed: true,
  });
  host.cli.captured?.onEvent?.({
    type: "tool_end",
    toolUseId: "tool-failed",
    failed: true,
  });
  host.cli.captured?.onEvent?.({
    type: "result",
    answer: "",
    stats: { totalTokens: 42 },
  });
  host.cli.finish({ answer: "完成！", sessionId: "sess-1" });
  await waitFor(() =>
    host.calls.mentions.some((text) => text.includes("任务已完成")),
  );
  assert.ok(
    host.calls.updates.some((card) => cardSummaryContains(card, "已完成")),
  );
  assert.equal(resultPayload?.traceId, startedTraceId);
  assert.equal(resultPayload?.stats?.totalTokens, 42);
  assert.equal(resultPayload?.toolMetrics?.shell.failures, 1);
});

test("task/started 可选监听器异常不阻断任务执行", async () => {
  const host = await createHost();
  host.root.on("task/started", () => {
    throw new Error("模拟观测监听器失败");
  });

  await host.root.parallel(
    "bot/message",
    incomingMessage({ text: "继续执行主任务" }),
    host.bot,
    baseBotConfig,
  );
  await waitFor(() => host.cli.captured !== undefined);

  host.cli.finish({ answer: "执行完成", sessionId: "sess-started-error" });
  await waitFor(() =>
    host.calls.mentions.some((text) => text.includes("任务已完成")),
  );
  assert.ok(
    host.calls.updates.some((card) => cardSummaryContains(card, "已完成")),
  );
});

test("任务失败时保留失败前已观察到的 Token 与工具失败指标", async () => {
  const host = await createHost();
  let failedPayload: TaskResultPayload | undefined;
  host.root.on("task/failed", (payload) => {
    failedPayload = payload;
  });
  host.cli.failNext(new Error("模拟 CLI 失败"), [
    {
      type: "tool_start",
      toolUseId: "tool-1",
      toolName: "shell",
      label: "运行命令",
    },
    { type: "tool_end", toolUseId: "tool-1", failed: true },
    { type: "result", answer: "", stats: { totalTokens: 30, inputTokens: 30 } },
  ]);

  await host.root.parallel(
    "bot/message",
    incomingMessage({ text: "执行失败任务" }),
    host.bot,
    baseBotConfig,
  );
  await waitFor(() => failedPayload !== undefined);

  assert.equal(failedPayload?.stats?.totalTokens, 30);
  assert.equal(failedPayload?.toolMetrics?.shell.invocations, 1);
  assert.equal(failedPayload?.toolMetrics?.shell.failures, 1);
  assert.ok(failedPayload?.traceId);
});

test("澄清工具逐题收集答案并续接原 CLI 会话", async () => {
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
            {
              id: "entry",
              prompt: "从哪里进入？",
              options: [
                { id: "list", label: "用户列表" },
                { id: "menu", label: "操作菜单" },
              ],
              recommendedOptionId: "list",
            },
          ],
        },
      },
    ],
  });

  await waitFor(() =>
    host.calls.updates.some((card) => cardSummaryContains(card, "确认优先级范围")),
  );
  assert.equal(host.calls.mentions.length, 0, "等待澄清时不能发送任务完成通知");

  const waitingCard = host.calls.updates.find((card) =>
    cardSummaryContains(card, "优先级需要支持几档"),
  )!;
  const first = await host.root.serial(
    "bot/card-action",
    {
      operatorOpenId: "ou_owner",
      messageId: "card-1",
      value: clarificationValueOf(waitingCard, "three"),
    },
    host.bot,
    baseBotConfig,
  );
  assert.equal(first?.toast?.content, "已记录，继续下一题。");
  assert.match(JSON.stringify(first?.card?.data), /从哪里进入/);
  assert.match(JSON.stringify(first?.card?.data), /已确认 1 项/);

  const response = await host.root.serial(
    "bot/card-action",
    {
      operatorOpenId: "ou_owner",
      messageId: "card-1",
      value: clarificationValueOf(first?.card?.data ?? {}, "list"),
    },
    host.bot,
    baseBotConfig,
  );
  assert.equal(response?.toast?.content, "答案已收到。");
  assert.match(JSON.stringify(response?.card?.data), /正在整理/);
  await waitFor(() => host.cli.captures.length === 2);
  assert.equal(
    host.cli.captures[1]?.sessionId,
    "sess-clarification",
    "回答必须恢复原始 CLI 会话",
  );
  assert.match(host.cli.captures[1]?.prompt ?? "", /高、中、低三档/);
  assert.match(host.cli.captures[1]?.prompt ?? "", /用户列表/);

  host.cli.finish({ answer: "已按三档实现。", sessionId: "sess-clarification" });
  await waitFor(() =>
    host.calls.mentions.some((text) => text.includes("任务已完成")),
  );
});

test("产品经理直接生成真实 Spec 与 Tickets 后可由发起人确认", async () => {
  const productConfig: BotConfig = {
    ...baseBotConfig,
    skills: ["grill-me", "to-spec", "to-tickets"],
  };
  const host = await createHost([productConfig]);
  await host.root.plugin(productSpecPlugin);
  await waitForAllActive(host.root);
  const taskResults: Array<{ answer: string; suppressHandoff?: boolean }> = [];
  host.root.on("task/result", (payload) => {
    taskResults.push(payload);
  });
  const runtimeConfig = host.root.config.bot("testbot")!;
  const featureDir = join(runtimeConfig.workspaceDir, ".scratch", "user-detail");
  const ticketsDir = join(featureDir, "issues");
  await mkdir(ticketsDir, { recursive: true });
  await writeFile(join(featureDir, "spec.md"), "# 用户详情页\n", "utf8");
  await writeFile(
    join(ticketsDir, "01-detail-view.md"),
    "# 详情基础展示\n",
    "utf8",
  );

  await host.root.parallel(
    "bot/message",
    incomingMessage({ text: "增加用户详情页", senderOpenId: "ou_owner" }),
    host.bot,
    runtimeConfig,
  );
  await waitFor(() => host.cli.captures.length === 1);
  host.cli.finish({
    answer: "产品文档已生成。",
    sessionId: "sess-product-spec",
    toolCalls: [
      {
        toolUseId: "tool-product-spec",
        toolName: "request_spec_approval",
        input: {
          title: "用户详情页",
          summary: "增加只读详情页，并覆盖权限与空状态。",
          deliveryMode: "local",
          specPath: ".scratch/user-detail/spec.md",
          ticketsPath: ".scratch/user-detail/issues",
        },
      },
    ],
  });

  await waitFor(() =>
    host.calls.updates.some((card) =>
      cardSummaryContains(card, "产品文档已生成"),
    ),
  );
  assert.ok(
    host.calls.mentions.some((text) => text.includes("产品方案已生成")),
  );
  await waitFor(() => taskResults.length === 1);
  assert.equal(taskResults[0]?.answer, "产品文档已生成。");
  assert.equal(taskResults[0]?.suppressHandoff, true);
  const readyCard = host.calls.updates.find((card) =>
    cardSummaryContains(card, "产品文档已生成"),
  )!;
  assert.match(JSON.stringify(readyCard), /\.scratch\/user-detail\/spec\.md/);
  const value = productSpecValueOf(readyCard);
  assert.equal(
    (await host.root.serial(
      "bot/card-action",
      {
        operatorOpenId: "ou_other",
        messageId: "card-1",
        value,
      },
      host.bot,
      runtimeConfig,
    ))?.toast?.content,
    "只有任务发起人可以确认。",
  );
  await writeFile(join(featureDir, "spec.md"), "# 用户详情页 v2\n", "utf8");
  const changed = await host.root.serial(
    "bot/card-action",
    { operatorOpenId: "ou_owner", messageId: "card-1", value },
    host.bot,
    runtimeConfig,
  );
  assert.equal(changed?.toast?.content, "产品文档已发生变化，请重新提交方案。");
  await writeFile(join(featureDir, "spec.md"), "# 用户详情页\n", "utf8");
  const approved = await host.root.serial(
    "bot/card-action",
    { operatorOpenId: "ou_owner", messageId: "card-1", value },
    host.bot,
    runtimeConfig,
  );
  assert.equal(approved?.toast?.content, "产品方案已确认。");
  assert.equal(approved?.card?.data && (approved.card.data as any).header.template, "green");
  const replay = await host.root.serial(
    "bot/card-action",
    { operatorOpenId: "ou_owner", messageId: "card-1", value },
    host.bot,
    runtimeConfig,
  );
  assert.equal(replay?.toast?.content, "产品方案已经确认。");
});

test("产品经理提交飞书云文档时无需本地产物即可确认", async () => {
  const productConfig: BotConfig = {
    ...baseBotConfig,
    skills: ["grill-me", "lark-doc"],
  };
  const host = await createHost([productConfig]);
  await host.root.plugin(productSpecPlugin);
  await waitForAllActive(host.root);
  const runtimeConfig = host.root.config.bot("testbot")!;

  await host.root.parallel(
    "bot/message",
    incomingMessage({ text: "增加用户详情页", senderOpenId: "ou_owner" }),
    host.bot,
    runtimeConfig,
  );
  await waitFor(() => host.cli.captures.length === 1);
  host.cli.finish({
    answer: "飞书产品文档已生成。",
    sessionId: "sess-lark-product-spec",
    toolCalls: [{
      toolUseId: "tool-lark-product-spec",
      toolName: "request_spec_approval",
      input: {
        title: "用户详情页",
        summary: "增加只读详情页，并覆盖权限与空状态。",
        deliveryMode: "lark-doc",
        documentUrl: "https://example.feishu.cn/docx/AbCdEf123",
      },
    }],
  });

  await waitFor(() =>
    host.calls.updates.some((card) =>
      cardSummaryContains(card, "产品文档已生成"),
    ),
  );
  const readyCard = host.calls.updates.find((card) =>
    cardSummaryContains(card, "产品文档已生成"),
  )!;
  const serialized = JSON.stringify(readyCard);
  assert.match(serialized, /飞书云文档待确认/);
  assert.match(serialized, /https:\/\/example\.feishu\.cn\/docx\/AbCdEf123/);
  assert.doesNotMatch(serialized, /spec\.md/);

  const approved = await host.root.serial(
    "bot/card-action",
    {
      operatorOpenId: "ou_owner",
      messageId: "card-1",
      value: productSpecValueOf(readyCard),
    },
    host.bot,
    runtimeConfig,
  );
  assert.equal(approved?.toast?.content, "产品方案已确认。");
});

test("协作产品方案继承真人 owner，确认后自动交回 Team Leader", async () => {
  const leaderInput: BotConfig = { ...baseBotConfig, id: "leader" };
  const productInput: BotConfig = {
    ...baseBotConfig,
    id: "product",
    skills: ["grill-me", "lark-doc"],
  };
  const host = await createHost([leaderInput, productInput]);
  const leader = host.root.config.bot("leader")!;
  const product = host.root.config.bot("product")!;
  for (const config of [leader, product]) {
    host.lark.runtimes.set(config.id, {
      config,
      bot: host.bot,
      identity: { openId: `${config.id}_open`, name: config.id },
    });
  }
  const storeDir = await mkdtemp(join(tmpdir(), "threadpilot-team-product-"));
  tempDirs.push(storeDir);
  await host.root.plugin(productSpecPlugin, {
    storePath: join(storeDir, "flows.json"),
  });
  await host.root.plugin(dispatchTaskPlugin);
  await waitForAllActive(host.root);

  const collaboration: CollaborationMessage = {
    dispatchId: "product-turn-1",
    taskId: "team-product-task",
    ownerOpenId: "ou_owner",
    ownerUnionId: "on_owner",
    fromBotId: "leader",
    toBotId: "product",
    reportToBotId: "leader",
    objective: "形成用户分组产品方案",
    instruction: "澄清需求并提交待确认方案。",
    expectedOutput: "一份可验收的产品方案。",
    round: 1,
    maxRounds: 4,
    workspaceDir: product.workspaceDir,
  };
  const result = {
    answer: "飞书产品文档已生成。",
    sessionId: "sess-team-product",
    toolCalls: [{
      toolUseId: "tool-team-product",
      toolName: "request_spec_approval",
      input: {
        title: "用户分组管理",
        summary: "支持创建分组并维护分组成员。",
        deliveryMode: "lark-doc" as const,
        documentUrl: "https://example.feishu.cn/docx/TeamProduct123",
      },
    }],
  };
  const outcome = await host.root.serial("task/tool-calls", {
    bot: host.bot,
    botConfig: product,
    session: { ...fakeSession(), botId: product.id, workspaceDir: product.workspaceDir },
    requestedPrompt: collaboration.instruction,
    answer: result.answer,
    replyToMessageId: "product-message",
    hasThread: true,
    collaboration,
    taskId: collaboration.taskId,
    result,
    runId: "run-team-product",
    // 入站消息来自 leader bot；产品 Flow 必须忽略它，继承 collaboration 中的真人 owner。
    senderOpenId: "leader_open",
    senderUnionId: "leader_union",
    cardMessageId: "card-team-product",
  });
  assert.ok(outcome);
  await outcome.afterCardPublished?.();
  const value = productSpecValueOf(outcome.card);
  assert.equal(
    (await host.root.serial(
      "bot/card-action",
      {
        operatorOpenId: "leader_open",
        operatorUnionId: "leader_union",
        messageId: "card-team-product",
        value,
      },
      host.bot,
      product,
    ))?.toast?.content,
    "只有任务发起人可以确认。",
  );
  const approved = await host.root.serial(
    "bot/card-action",
    {
      operatorOpenId: "ou_owner",
      operatorUnionId: "on_owner",
      messageId: "card-team-product",
      value,
    },
    host.bot,
    product,
  );
  assert.equal(approved?.toast?.content, "产品方案已确认。");
  const dispatchId = host.calls.mentions
    .at(-1)
    ?.match(/任务编号：([a-f0-9]{12})/)?.[1];
  assert.ok(dispatchId);
  const returned = host.root.collaboration.consume(dispatchId, "leader");
  assert.equal(returned?.ownerOpenId, "ou_owner");
  assert.equal(returned?.ownerUnionId, "on_owner");
  assert.equal(returned?.reportToBotId, "leader");
  assert.equal(returned?.round, 2);
  assert.match(returned?.instruction ?? "", /TeamProduct123/);
  assert.match(returned?.instruction ?? "", /dispatch_task/);

  const mentionsBeforeTerminalApproval = host.calls.mentions.length;
  await dispatchTaskPlugin.handleApprovedProductSpec(host.root, {
    flow: {
      token: "terminal-product-flow",
      taskId: "terminal-product-task",
      botId: product.id,
      sessionId: "terminal-product-session",
      ownerOpenId: "ou_owner",
      ownerUnionId: "on_owner",
      collaboration: {
        taskId: "terminal-product-task",
        fromBotId: "leader",
        reportToBotId: "leader",
        round: 4,
        maxRounds: 4,
      },
      workspaceDir: product.workspaceDir,
      request: {
        title: "末轮产品方案",
        summary: "已经在最后一轮确认。",
        deliveryMode: "lark-doc",
        documentUrl: "https://example.feishu.cn/docx/TerminalProduct123",
      },
      status: "approved",
    },
    bot: host.bot,
    botConfig: product,
    replyToMessageId: "terminal-product-card",
  });
  assert.equal(
    host.calls.mentions.length,
    mentionsBeforeTerminalApproval + 1,
    "最后一轮确认应只通知真人收口，不能继续派发 bot",
  );
  assert.match(host.calls.mentions.at(-1) ?? "", /产品方案“末轮产品方案”已确认/);
  assert.doesNotMatch(host.calls.mentions.at(-1) ?? "", /协作结果已经返回/);
});

test("直接产品任务确认后按用户选择交给 Team Leader 或仅记录", async () => {
  const leaderInput: BotConfig = {
    ...baseBotConfig,
    id: "leader",
    skills: ["grill-me", "lark-doc"],
  };
  const productInput: BotConfig = {
    ...baseBotConfig,
    id: "product",
    skills: ["grill-me", "lark-doc"],
  };
  const host = await createHost([leaderInput, productInput]);
  const leader = host.root.config.bot("leader")!;
  const product = host.root.config.bot("product")!;
  for (const config of [leader, product]) {
    host.lark.runtimes.set(config.id, {
      config,
      bot: host.bot,
      identity: { openId: `${config.id}_open`, name: config.id },
    });
  }
  const storeDir = await mkdtemp(join(tmpdir(), "threadpilot-direct-product-"));
  tempDirs.push(storeDir);
  await host.root.plugin(productSpecPlugin, {
    storePath: join(storeDir, "flows.json"),
  });
  await host.root.plugin(dispatchTaskPlugin);
  await waitForAllActive(host.root);

  /** 直接产品任务：用户直接在产品 bot 发起，不经过协作交接单。 */
  const directResult = {
    answer: "飞书产品文档已生成。",
    sessionId: "sess-direct-product",
    toolCalls: [{
      toolUseId: "tool-direct-product",
      toolName: "request_spec_approval",
      input: {
        title: "用户分组管理",
        summary: "支持创建分组并维护分组成员。",
        deliveryMode: "lark-doc" as const,
        documentUrl: "https://example.feishu.cn/docx/DirectProduct123",
      },
    }],
  };
  const outcome = await host.root.serial("task/tool-calls", {
    bot: host.bot,
    botConfig: product,
    session: {
      ...fakeSession(),
      botId: product.id,
      workspaceDir: product.workspaceDir,
    },
    requestedPrompt: "形成用户分组产品方案",
    answer: directResult.answer,
    replyToMessageId: "product-message",
    hasThread: true,
    taskId: "direct-product-task",
    result: directResult,
    runId: "run-direct-product",
    senderOpenId: "ou_owner",
    senderUnionId: "on_owner",
    cardMessageId: "card-direct-product",
  });
  assert.ok(outcome);
  await outcome.afterCardPublished?.();
  // 直接任务卡片必须同时提供“确认产品方案”和“确认并交给 Leader”两个按钮。
  const plainValue = productSpecValueOf(
    outcome.card,
    (value) => value.handoffToLeader !== true,
  );
  const handoffValue = productSpecValueOf(
    outcome.card,
    (value) => value.handoffToLeader === true,
  );
  assert.ok(plainValue && handoffValue);

  // 场景一：普通确认只记录已就绪，不派发协作单。
  const mentionsBeforePlain = host.calls.mentions.length;
  const plainApproved = await host.root.serial(
    "bot/card-action",
    {
      operatorOpenId: "ou_owner",
      operatorUnionId: "on_owner",
      messageId: "card-direct-product",
      value: plainValue,
    },
    host.bot,
    product,
  );
  assert.equal(plainApproved?.toast?.content, "产品方案已确认。");
  assert.equal(
    host.calls.mentions.length,
    mentionsBeforePlain,
    "普通确认不能派发协作单",
  );

  // 场景二：用户选择“确认并交给 Leader”时，方案作为团队任务派发给 Team Leader。
  const outcome2 = await host.root.serial("task/tool-calls", {
    bot: host.bot,
    botConfig: product,
    session: {
      ...fakeSession(),
      id: "s2",
      botId: product.id,
      workspaceDir: product.workspaceDir,
    },
    requestedPrompt: "形成第二个产品方案",
    answer: "第二个产品文档已生成。",
    replyToMessageId: "product-message-2",
    hasThread: true,
    taskId: "direct-product-task-2",
    result: {
      answer: "第二个产品文档已生成。",
      sessionId: "sess-direct-product-2",
      toolCalls: [{
        toolUseId: "tool-direct-product-2",
        toolName: "request_spec_approval",
        input: {
          title: "订单导出",
          summary: "支持按条件导出订单明细。",
          deliveryMode: "lark-doc" as const,
          documentUrl: "https://example.feishu.cn/docx/DirectProduct456",
        },
      }],
    },
    runId: "run-direct-product-2",
    senderOpenId: "ou_owner",
    senderUnionId: "on_owner",
    cardMessageId: "card-direct-product-2",
  });
  assert.ok(outcome2);
  await outcome2.afterCardPublished?.();
  const handoff = await host.root.serial(
    "bot/card-action",
    {
      operatorOpenId: "ou_owner",
      operatorUnionId: "on_owner",
      messageId: "card-direct-product-2",
      value: productSpecValueOf(
        outcome2.card,
        (value) => value.handoffToLeader === true,
      ),
    },
    host.bot,
    product,
  );
  assert.equal(handoff?.toast?.content, "产品方案已确认。");
  const dispatchId = host.calls.mentions
    .at(-1)
    ?.match(/任务编号：([a-f0-9]{12})/)?.[1];
  assert.ok(dispatchId, "交给 Leader 应产生协作派发通知");
  const handedOff = host.root.collaboration.consume(dispatchId, "leader");
  assert.equal(handedOff?.ownerOpenId, "ou_owner");
  assert.equal(handedOff?.ownerUnionId, "on_owner");
  assert.equal(handedOff?.reportToBotId, "leader");
  assert.equal(handedOff?.round, 1);
  assert.match(handedOff?.instruction ?? "", /DirectProduct456/);
  assert.match(handedOff?.instruction ?? "", /dispatch_task/);

  // 场景三：产品 bot 本身就是 Team Leader 时，交给 Leader 只提示真人，不派发。
  const outcome3 = await host.root.serial("task/tool-calls", {
    bot: host.bot,
    botConfig: leader,
    session: {
      ...fakeSession(),
      id: "s3",
      botId: leader.id,
      workspaceDir: leader.workspaceDir,
    },
    requestedPrompt: "Leader 直接产出产品方案",
    answer: "Leader 产品文档已生成。",
    replyToMessageId: "leader-message",
    hasThread: true,
    taskId: "direct-leader-product-task",
    result: {
      answer: "Leader 产品文档已生成。",
      sessionId: "sess-leader-product",
      toolCalls: [{
        toolUseId: "tool-leader-product",
        toolName: "request_spec_approval",
        input: {
          title: "权限矩阵",
          summary: "梳理各角色可访问的模块。",
          deliveryMode: "lark-doc" as const,
          documentUrl: "https://example.feishu.cn/docx/LeaderProduct789",
        },
      }],
    },
    runId: "run-leader-product",
    senderOpenId: "ou_owner",
    senderUnionId: "on_owner",
    cardMessageId: "card-leader-product",
  });
  assert.ok(outcome3);
  await outcome3.afterCardPublished?.();
  const mentionsBeforeSelf = host.calls.mentions.length;
  const leaderApproved = await host.root.serial(
    "bot/card-action",
    {
      operatorOpenId: "ou_owner",
      operatorUnionId: "on_owner",
      messageId: "card-leader-product",
      value: productSpecValueOf(
        outcome3.card,
        (value) => value.handoffToLeader === true,
      ),
    },
    host.bot,
    leader,
  );
  assert.equal(leaderApproved?.toast?.content, "产品方案已确认。");
  assert.match(
    host.calls.mentions.at(-1) ?? "",
    /已是 Team Leader/,
    "Leader 自己产出方案时确认并交给 Leader 应提示真人直接组织",
  );
  assert.equal(host.calls.mentions.length, mentionsBeforeSelf + 1);
});

test("产品方案没有工具调用时沿用同一 CLI 会话纠正并生成确认卡", async () => {
  const productConfig: BotConfig = {
    ...baseBotConfig,
    skills: ["grill-me", "lark-doc"],
  };
  const host = await createHost([productConfig]);
  await host.root.plugin(productSpecPlugin);
  await waitForAllActive(host.root);
  const runtimeConfig = host.root.config.bot("testbot")!;
  let resultPayload: TaskResultPayload | undefined;
  host.root.on("task/result", (payload) => {
    resultPayload = payload;
  });

  await host.root.parallel(
    "bot/message",
    incomingMessage({ text: "创建用户详情方案", senderOpenId: "ou_owner" }),
    host.bot,
    runtimeConfig,
  );
  await waitFor(() => host.cli.captures.length === 1);
  host.cli.finish({
    answer: "方案已经写好。",
    sessionId: "sess-product-correction",
    stats: { totalTokens: 100, inputTokens: 80, outputTokens: 20 },
  });
  await waitFor(() => host.cli.captures.length === 2);
  assert.equal(host.cli.captures[1]?.sessionId, "sess-product-correction");
  assert.match(host.cli.captures[1]?.prompt ?? "", /request_spec_approval/);

  host.cli.finish({
    answer: "已提交待确认方案。",
    sessionId: "sess-product-correction",
    stats: { totalTokens: 50, inputTokens: 40, outputTokens: 10 },
    toolCalls: [{
      toolUseId: "tool-correction-spec",
      toolName: "request_spec_approval",
      input: {
        title: "用户详情页",
        summary: "增加只读详情页。",
        deliveryMode: "lark-doc",
        documentUrl: "https://example.feishu.cn/docx/Correction123",
      },
    }],
  });
  await waitFor(() => host.calls.updates.some((card) =>
    cardSummaryContains(card, "产品文档已生成"),
  ));
  assert.ok(host.root.productSpec.flows.findPendingByDocument(
    "testbot",
    "Correction123",
  ));
  assert.ok(host.calls.mentions.some((text) => text.includes("产品方案已生成")));
  assert.equal(resultPayload?.stats?.totalTokens, 150);
  assert.equal(resultPayload?.stats?.inputTokens, 120);
  assert.equal(resultPayload?.stats?.outputTokens, 30);
});

test("产品方案只有其他工具调用时仍强制补交 request_spec_approval", async () => {
  const productConfig: BotConfig = {
    ...baseBotConfig,
    skills: ["grill-me", "lark-doc"],
  };
  const host = await createHost([productConfig]);
  await host.root.plugin(productSpecPlugin);
  await waitForAllActive(host.root);
  const runtimeConfig = host.root.config.bot("testbot")!;

  await host.root.parallel(
    "bot/message",
    incomingMessage({ text: "创建用户详情方案", senderOpenId: "ou_owner" }),
    host.bot,
    runtimeConfig,
  );
  await waitFor(() => host.cli.captures.length === 1);
  host.cli.finish({
    answer: "已调用别的工具。",
    sessionId: "sess-product-other-tool",
    toolCalls: [{
      toolUseId: "tool-other",
      toolName: "request_clarification",
      input: {},
    }],
  });
  await waitFor(() => host.cli.captures.length === 2);
  assert.equal(host.cli.captures[1]?.sessionId, "sess-product-other-tool");
  host.cli.finish({
    answer: "已补交方案。",
    sessionId: "sess-product-other-tool",
    toolCalls: [{
      toolUseId: "tool-other-correction",
      toolName: "request_spec_approval",
      input: {
        title: "用户详情页",
        summary: "增加只读详情页。",
        deliveryMode: "lark-doc",
        documentUrl: "https://example.feishu.cn/docx/OtherTool123",
      },
    }],
  });
  await waitFor(() => host.calls.updates.some((card) =>
    cardSummaryContains(card, "产品文档已生成"),
  ));
});

test("产品方案纠正轮仍未提交时进入失败收尾且不发送成功通知", async () => {
  const productConfig: BotConfig = {
    ...baseBotConfig,
    skills: ["grill-me", "lark-doc"],
  };
  const host = await createHost([productConfig]);
  await host.root.plugin(productSpecPlugin);
  await waitForAllActive(host.root);
  const runtimeConfig = host.root.config.bot("testbot")!;

  await host.root.parallel(
    "bot/message",
    incomingMessage({ text: "创建用户详情方案", senderOpenId: "ou_owner" }),
    host.bot,
    runtimeConfig,
  );
  await waitFor(() => host.cli.captures.length === 1);
  host.cli.finish({ answer: "方案已经写好。", sessionId: "sess-product-fail" });
  await waitFor(() => host.cli.captures.length === 2);
  host.cli.finish({ answer: "仍然只返回文字。", sessionId: "sess-product-fail" });

  await waitFor(() => host.calls.updates.some((card) =>
    cardSummaryContains(card, "执行没有完成"),
  ));
  assert.equal(
    host.calls.mentions.filter((text) => text.includes("任务已完成")).length,
    0,
  );
  assert.equal(
    host.calls.updates.filter((card) => cardSummaryContains(card, "产品文档已生成"))
      .length,
    0,
  );
});

test("普通开发 bot 不触发产品方案提交纠正", async () => {
  const host = await createHost([baseBotConfig]);
  await host.root.plugin(productSpecPlugin);
  await waitForAllActive(host.root);
  const runtimeConfig = host.root.config.bot("testbot")!;

  await host.root.parallel(
    "bot/message",
    incomingMessage({ text: "实现一个普通模块" }),
    host.bot,
    runtimeConfig,
  );
  await waitFor(() => host.cli.captures.length === 1);
  host.cli.finish({ answer: "模块已完成。", sessionId: "sess-developer" });
  await waitFor(() => host.calls.updates.some((card) =>
    cardSummaryContains(card, "模块已完成"),
  ));
  assert.equal(host.cli.captures.length, 1);
});

test("云文档 @产品经理评论恢复原 CLI 会话并回复同一条评论", async () => {
  const productConfig: BotConfig = {
    ...baseBotConfig,
    skills: ["grill-me", "lark-doc", "lark-drive"],
  };
  const host = await createHost([productConfig]);
  const flowDir = await mkdtemp(join(tmpdir(), "threadpilot-comment-flow-"));
  tempDirs.push(flowDir);
  await host.root.plugin(productSpecPlugin, {
    storePath: join(flowDir, "product-spec-flows.json"),
  });
  await host.root.plugin(productCommentsPlugin);
  await waitForAllActive(host.root);
  const runtimeConfig = host.root.config.bot("testbot")!;
  const backgroundEvents = { started: 0, results: 0, failed: 0 };
  host.root.on("task/started", (payload) => {
    if (payload.origin === "background") backgroundEvents.started += 1;
  });
  host.root.on("task/result", (payload) => {
    if (payload.origin === "background") backgroundEvents.results += 1;
  });
  host.root.on("task/failed", (payload) => {
    if (payload.origin === "background") backgroundEvents.failed += 1;
  });

  await host.root.parallel(
    "bot/message",
    incomingMessage({ text: "创建云文档方案", senderOpenId: "ou_owner" }),
    host.bot,
    runtimeConfig,
  );
  await waitFor(() => host.cli.captures.length === 1);
  host.cli.finish({
    answer: "方案已生成。",
    sessionId: "sess-comment",
    toolCalls: [{
      toolUseId: "tool-comment-spec",
      toolName: "request_spec_approval",
      input: {
        title: "用户详情页",
        summary: "增加只读详情页。",
        deliveryMode: "lark-doc",
        documentUrl: "https://example.feishu.cn/docx/CommentDoc123",
      },
    }],
  });
  await waitFor(() => host.root.productSpec.flows.findPendingByDocument(
    "testbot",
    "CommentDoc123",
  ) !== undefined);
  const commentFlow = host.root.productSpec.flows.findPendingByDocument(
    "testbot",
    "CommentDoc123",
  )!;
  const commentSessionId = commentFlow.sessionId;

  await host.root.parallel(
    "bot/document-comment",
    {
      eventId: "comment-event-1",
      fileToken: "CommentDoc123",
      fileType: "docx",
      commentId: "comment-1",
      replyId: "reply-1",
      senderOpenId: "ou_owner",
      senderUnionId: "on_owner",
      mentionedBot: true,
    },
    host.bot,
    runtimeConfig,
  );
  await waitFor(() => host.cli.captures.length === 2);
  assert.equal(host.cli.captures[1]?.sessionId, "sess-comment");
  assert.match(host.cli.captures[1]?.prompt ?? "", /评论 ID：comment-1/);
  assert.match(host.cli.captures[1]?.prompt ?? "", /你所在的 Agent 团队/);
  assert.equal(host.root.tasks.activeRunCount, 1);
  assert.equal(host.cli.captures[1]?.onEvent !== undefined, true);
  host.cli.captured?.onEvent?.({
    type: "session",
    sessionId: "sess-comment-live",
  });
  await waitFor(() =>
    host.root.sessions.manager.get(commentSessionId)?.cliSessionId ===
    "sess-comment-live",
  );

  await host.root.parallel(
    "bot/document-comment",
    {
      eventId: "comment-event-queued",
      fileToken: "CommentDoc123",
      fileType: "docx",
      commentId: "comment-queued",
      replyId: "reply-queued",
      senderOpenId: "ou_owner",
      senderUnionId: "on_owner",
      mentionedBot: true,
    },
    host.bot,
    runtimeConfig,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(host.cli.captures.length, 2);

  host.cli.finish({
    answer: "已补充用户不存在时的空状态和重试规则。",
    sessionId: "sess-comment",
    stats: { contextWindowTokens: 128 },
  });
  await waitFor(() => host.cli.captures.length === 3);
  host.cli.finish({ answer: "已合并排队评论。", sessionId: "sess-comment" });
  await waitFor(() => host.calls.documentCommentReplies.length === 2);
  assert.match(host.calls.documentCommentReplies[0]!, /空状态和重试规则/);
  assert.match(host.calls.documentCommentReplies[1]!, /合并排队评论/);
  assert.equal(backgroundEvents.started, 2);
  assert.equal(backgroundEvents.results, 2);
  assert.equal(backgroundEvents.failed, 0);
  assert.equal(host.root.tasks.contextWindowFor(commentSessionId), 128);
  assert.equal(host.root.tasks.activeRunCount, 0);
  assert.deepEqual(host.calls.documentCommentReactions, [
    { active: true },
    { active: true },
    { active: false },
    { active: false },
  ]);

  host.cli.failNext(new CliRunError("session expired: private details", "sess-comment"));
  await host.root.parallel(
    "bot/document-comment",
    {
      eventId: "comment-event-2",
      fileToken: "CommentDoc123",
      fileType: "docx",
      commentId: "comment-2",
      replyId: "reply-2",
      senderOpenId: "ou_owner",
      senderUnionId: "on_owner",
      mentionedBot: true,
    },
    host.bot,
    runtimeConfig,
  );
  await waitFor(() => host.calls.documentCommentReplies.length === 3);
  assert.equal(
    host.root.sessions.manager.get(commentSessionId)?.cliSessionId,
    undefined,
  );
  assert.equal(
    host.calls.documentCommentReplies[2],
    "这条评论暂时无法处理，请稍后重试或在原话题联系产品经理。",
  );
  assert.doesNotMatch(host.calls.documentCommentReplies[2]!, /private details/);
  assert.equal(backgroundEvents.started, 3);
  assert.equal(backgroundEvents.results, 2);
  assert.equal(backgroundEvents.failed, 1);
});

test("同一话题提交更新方案后，旧产品确认卡变为失效状态", async () => {
  const productConfig: BotConfig = {
    ...baseBotConfig,
    skills: ["grill-me", "to-spec", "to-tickets"],
  };
  const host = await createHost([productConfig]);
  await host.root.plugin(productSpecPlugin);
  await waitForAllActive(host.root);
  const runtimeConfig = host.root.config.bot("testbot")!;
  const featureDir = join(runtimeConfig.workspaceDir, ".scratch", "approval-revision");
  const ticketsDir = join(featureDir, "issues");
  await mkdir(ticketsDir, { recursive: true });
  await writeFile(join(featureDir, "spec.md"), "# 方案\n", "utf8");
  await writeFile(join(ticketsDir, "01-plan.md"), "# 任务\n", "utf8");

  await host.root.parallel(
    "bot/message",
    incomingMessage({ messageId: "m-approval-root", text: "创建方案", senderOpenId: "ou_owner" }),
    host.bot,
    runtimeConfig,
  );
  await waitFor(() => host.cli.captures.length === 1);
  host.cli.finish({
    answer: "方案已生成。",
    sessionId: "sess-approval-revision",
    toolCalls: [{
      toolUseId: "tool-spec-1",
      toolName: "request_spec_approval",
      input: {
        title: "方案 v1",
        summary: "第一版方案。",
        deliveryMode: "local",
        specPath: ".scratch/approval-revision/spec.md",
        ticketsPath: ".scratch/approval-revision/issues",
      },
    }],
  });
  await waitFor(() =>
    host.calls.updates.some((card) => cardSummaryContains(card, "方案 v1：待确认")),
  );
  const oldCard = host.calls.updates.find((card) =>
    cardSummaryContains(card, "方案 v1：待确认"),
  )!;
  const oldValue = productSpecValueOf(oldCard);

  await host.root.parallel(
    "bot/message",
    incomingMessage({
      messageId: "m-approval-follow-up",
      rootId: "m-approval-root",
      text: "更新方案",
      senderOpenId: "ou_owner",
    }),
    host.bot,
    runtimeConfig,
  );
  await waitFor(() => host.cli.captures.length === 2);
  host.cli.finish({
    answer: "方案已更新。",
    sessionId: "sess-approval-revision",
    toolCalls: [{
      toolUseId: "tool-spec-2",
      toolName: "request_spec_approval",
      input: {
        title: "方案 v2",
        summary: "更新后的方案。",
        deliveryMode: "local",
        specPath: ".scratch/approval-revision/spec.md",
        ticketsPath: ".scratch/approval-revision/issues",
      },
    }],
  });
  await waitFor(() =>
    host.calls.updates.some((card) => cardSummaryContains(card, "方案 v2：待确认")),
  );

  const expired = await host.root.serial(
    "bot/card-action",
    { operatorOpenId: "ou_owner", messageId: "card-1", value: oldValue },
    host.bot,
    runtimeConfig,
  );
  assert.equal(expired?.toast?.content, "这份产品方案已经失效。");
  assert.equal(
    (expired?.card?.data as any)?.header?.template,
    "grey",
  );
});

test("新产品确认卡发布失败时，旧确认卡仍可确认", async () => {
  const productConfig: BotConfig = {
    ...baseBotConfig,
    skills: ["grill-me", "to-spec", "to-tickets"],
  };
  const host = await createHost(
    [productConfig],
    "connected",
    {},
    false,
    false,
    { failUpdateCardAt: 2 },
  );
  await host.root.plugin(productSpecPlugin);
  await waitForAllActive(host.root);
  const runtimeConfig = host.root.config.bot("testbot")!;
  const featureDir = join(runtimeConfig.workspaceDir, ".scratch", "publish-failure");
  const ticketsDir = join(featureDir, "issues");
  await mkdir(ticketsDir, { recursive: true });
  await writeFile(join(featureDir, "spec.md"), "# 方案\n", "utf8");
  await writeFile(join(ticketsDir, "01-plan.md"), "# 任务\n", "utf8");

  await host.root.parallel(
    "bot/message",
    incomingMessage({ messageId: "m-publish-root", text: "创建方案", senderOpenId: "ou_owner" }),
    host.bot,
    runtimeConfig,
  );
  await waitFor(() => host.cli.captures.length === 1);
  host.cli.finish({
    answer: "方案已生成。",
    sessionId: "sess-publish-failure",
    toolCalls: [{
      toolUseId: "tool-publish-1",
      toolName: "request_spec_approval",
      input: {
        title: "方案 v1",
        summary: "第一版方案。",
        deliveryMode: "local",
        specPath: ".scratch/publish-failure/spec.md",
        ticketsPath: ".scratch/publish-failure/issues",
      },
    }],
  });
  await waitFor(() => host.calls.updates.some((card) => cardSummaryContains(card, "方案 v1：待确认")));
  const oldCard = host.calls.updates.find((card) => cardSummaryContains(card, "方案 v1：待确认"))!;
  const oldValue = productSpecValueOf(oldCard);

  await host.root.parallel(
    "bot/message",
    incomingMessage({ messageId: "m-publish-follow-up", rootId: "m-publish-root", text: "更新方案", senderOpenId: "ou_owner" }),
    host.bot,
    runtimeConfig,
  );
  await waitFor(() => host.cli.captures.length === 2);
  host.cli.finish({
    answer: "方案更新失败发布。",
    sessionId: "sess-publish-failure",
    toolCalls: [{
      toolUseId: "tool-publish-2",
      toolName: "request_spec_approval",
      input: {
        title: "方案 v2",
        summary: "更新方案。",
        deliveryMode: "local",
        specPath: ".scratch/publish-failure/spec.md",
        ticketsPath: ".scratch/publish-failure/issues",
      },
    }],
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(host.calls.updates.some((card) => cardSummaryContains(card, "方案 v2：待确认")), false);

  const approved = await host.root.serial(
    "bot/card-action",
    { operatorOpenId: "ou_owner", messageId: "card-1", value: oldValue },
    host.bot,
    runtimeConfig,
  );
  assert.equal(approved?.toast?.content, "产品方案已确认。");
  assert.equal((approved?.card?.data as any)?.header?.template, "green");
});

test("完成澄清后沿用原 CLI 会话提交产品文档", async () => {
  const productConfig: BotConfig = {
    ...baseBotConfig,
    skills: ["grill-me", "to-spec", "to-tickets"],
  };
  const host = await createHost([productConfig]);
  await host.root.plugin(productSpecPlugin);
  await waitForAllActive(host.root);
  const runtimeConfig = host.root.config.bot("testbot")!;
  const featureDir = join(runtimeConfig.workspaceDir, ".scratch", "priority");
  const ticketsDir = join(featureDir, "issues");
  await mkdir(ticketsDir, { recursive: true });
  await writeFile(join(featureDir, "spec.md"), "# 优先级\n", "utf8");
  await writeFile(join(ticketsDir, "01-priority.md"), "# 优先级字段\n", "utf8");

  await host.root.parallel(
    "bot/message",
    incomingMessage({ text: "增加优先级", senderOpenId: "ou_owner" }),
    host.bot,
    runtimeConfig,
  );
  await waitFor(() => host.cli.captures.length === 1);
  host.cli.finish({
    answer: "等待确认。",
    sessionId: "sess-product-clarification",
    toolCalls: [
      {
        toolUseId: "tool-clarification",
        toolName: "request_clarification",
        input: {
          title: "确认优先级",
          questions: [
            {
              id: "levels",
              prompt: "支持几档优先级？",
              options: [
                { id: "three", label: "高、中、低三档" },
                { id: "custom", label: "允许自定义" },
              ],
            },
          ],
        },
      },
    ],
  });
  await waitFor(() =>
    host.calls.updates.some((card) => cardSummaryContains(card, "确认优先级")),
  );
  const waitingCard = host.calls.updates.at(-1)!;
  await host.root.serial(
    "bot/card-action",
    {
      operatorOpenId: "ou_owner",
      messageId: "card-1",
      value: clarificationValueOf(waitingCard, "three"),
    },
    host.bot,
    runtimeConfig,
  );
  await waitFor(() => host.cli.captures.length === 2);
  assert.equal(host.cli.captures[1]?.sessionId, "sess-product-clarification");

  host.cli.finish({
    answer: "产品文档已生成。",
    sessionId: "sess-product-clarification",
    toolCalls: [
      {
        toolUseId: "tool-product-spec",
        toolName: "request_spec_approval",
        input: {
          title: "任务优先级",
          summary: "首期支持高、中、低三档。",
          deliveryMode: "local",
          specPath: ".scratch/priority/spec.md",
          ticketsPath: ".scratch/priority/issues",
        },
      },
    ],
  });
  await waitFor(() =>
    host.calls.updates.some((card) =>
      cardSummaryContains(card, "产品文档已生成"),
    ),
  );
  assert.ok(
    host.calls.mentions.some((text) => text.includes("产品方案已生成")),
  );
});

test("同话题文字补充使旧澄清卡失效并继续同一会话", async () => {
  const host = await createHost();
  const original = incomingMessage({
    messageId: "m-root",
    text: "增加用户详情页",
    senderOpenId: "ou_owner",
  });
  await host.root.parallel("bot/message", original, host.bot, baseBotConfig);
  await waitFor(() => host.cli.captures.length === 1);
  host.cli.finish({
    answer: "等待补充。",
    sessionId: "sess-follow-up",
    toolCalls: [
      {
        toolUseId: "tool-follow-up",
        toolName: "request_clarification",
        input: {
          title: "确认详情字段",
          questions: [
            {
              id: "fields",
              prompt: "展示哪些字段？",
              options: [
                { id: "basic", label: "基础信息" },
                { id: "all", label: "全部信息" },
              ],
              recommendedOptionId: "basic",
            },
          ],
        },
      },
    ],
  });
  await waitFor(() =>
    host.calls.updates.some((card) => cardSummaryContains(card, "确认详情字段")),
  );
  const oldCard = host.calls.updates.at(-1)!;

  await host.root.parallel(
    "bot/message",
    incomingMessage({
      messageId: "m-follow-up",
      rootId: "m-root",
      text: "需要展示注册时间和最近登录时间",
      senderOpenId: "ou_owner",
    }),
    host.bot,
    baseBotConfig,
  );
  await waitFor(() => host.cli.captures.length === 2);
  assert.equal(host.cli.captures[1]?.sessionId, "sess-follow-up");
  assert.match(host.cli.captures[1]?.prompt ?? "", /需要展示注册时间和最近登录时间/);
  assert.ok(host.calls.updates.some((card) => cardSummaryContains(card, "已更新")));

  const expired = await host.root.serial(
    "bot/card-action",
    {
      operatorOpenId: "ou_owner",
      messageId: "card-1",
      value: clarificationValueOf(oldCard, "basic"),
    },
    host.bot,
    baseBotConfig,
  );
  assert.equal(expired?.toast?.content, "这组澄清问题已经失效。");
  host.cli.finish({ answer: "字段已确认。", sessionId: "sess-follow-up" });
  await waitFor(() =>
    host.calls.mentions.some((text) => text.includes("任务已完成")),
  );
});

test("卡片停止按钮只能由任务发起人触发，并写入取消终态", async () => {
  const host = await createHost();
  let cancelledEvents = 0;
  host.root.on("task/cancelled", () => {
    cancelledEvents += 1;
  });
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
  assert.equal(cancelledEvents, 1);
});

test("dispatch_task 只允许 Team Leader 派发，并保留真人发起人与编排者", async () => {
  const leaderInput: BotConfig = { ...baseBotConfig, id: "leader" };
  const productInput: BotConfig = { ...baseBotConfig, id: "product" };
  const host = await createHost([leaderInput, productInput]);
  const leader = host.root.config.bot("leader")!;
  const product = host.root.config.bot("product")!;
  for (const config of [leader, product]) {
    host.lark.runtimes.set(config.id, {
      config,
      bot: host.bot,
      identity: { openId: `${config.id}_open`, name: config.id },
    });
  }
  await host.root.plugin(dispatchTaskPlugin);
  await waitForAllActive(host.root);
  assert.ok(
    host.root.applicationTools.list().some((server) =>
      server.tools.includes("dispatch_task"),
    ),
  );

  const payload = {
    bot: host.bot,
    botConfig: leader,
    session: { ...fakeSession(), botId: leader.id, workspaceDir: leader.workspaceDir },
    requestedPrompt: "组织用户分组需求",
    answer: "已决定先交给产品经理。",
    replyToMessageId: "leader-message",
    hasThread: true,
    taskId: "team-task-1",
    result: {
      answer: "已决定先交给产品经理。",
      toolCalls: [{
        toolUseId: "dispatch-1",
        toolName: "dispatch_task",
        input: {
          targetBotId: "product",
          objective: "形成用户分组产品方案",
          instruction: "澄清范围并提交一份待确认产品方案。",
          expectedOutput: "一份可验收的产品方案。",
        },
      }],
    },
    runId: "run-dispatch-1",
    senderOpenId: "ou_owner",
    senderUnionId: "on_owner",
    cardMessageId: "card-dispatch-1",
  } satisfies TaskToolCallsPayload;
  const outcome = await host.root.serial("task/tool-calls", payload);
  assert.equal(outcome?.completion, "completed");
  assert.equal(outcome?.suppressHandoff, true);
  await outcome?.afterCardPublished?.();
  const dispatchId = host.calls.mentions
    .at(-1)
    ?.match(/任务编号：([a-f0-9]{12})/)?.[1];
  assert.ok(dispatchId);
  const collaboration = host.root.collaboration.consume(dispatchId, "product");
  assert.equal(collaboration?.ownerOpenId, "ou_owner");
  assert.equal(collaboration?.ownerUnionId, "on_owner");
  assert.equal(collaboration?.reportToBotId, "leader");
  assert.equal(collaboration?.objective, "形成用户分组产品方案");

  await assert.rejects(
    host.root.serial("task/tool-calls", {
      ...payload,
      botConfig: product,
      session: { ...payload.session, botId: product.id },
    }),
    /只有 Team Leader/,
  );
  await assert.rejects(
    host.root.serial("task/tool-calls", {
      ...payload,
      result: {
        ...payload.result,
        toolCalls: [{
          toolUseId: "dispatch-self",
          toolName: "dispatch_task",
          input: {
            targetBotId: "leader",
            objective: "错误自派发",
            instruction: "不应执行。",
          },
        }],
      },
    }),
    /不能把团队任务派发给当前 bot/,
  );
  await assert.rejects(
    host.root.serial("task/tool-calls", {
      ...payload,
      collaboration: {
        ...collaboration!,
        round: collaboration!.maxRounds,
      },
    }),
    /已达到轮次上限/,
  );
  await assert.rejects(
    host.root.serial("task/tool-calls", {
      ...payload,
      result: {
        ...payload.result,
        toolCalls: [{
          toolUseId: "dispatch-invalid",
          toolName: "dispatch_task",
          input: {
            targetBotId: "CEO",
            objective: "非法目标",
            instruction: "这次调用不能被静默忽略。",
          },
        }],
      },
    }),
    /dispatch_task 参数非法/,
  );
});

test("私聊 dispatch_task 被忽略，不向其他 bot 投递", async () => {
  const leaderInput: BotConfig = { ...baseBotConfig, id: "leader" };
  const productInput: BotConfig = { ...baseBotConfig, id: "product" };
  const host = await createHost([leaderInput, productInput]);
  const leader = host.root.config.bot("leader")!;
  await host.root.plugin(dispatchTaskPlugin);
  await waitForAllActive(host.root);

  const payload = {
    bot: host.bot,
    botConfig: leader,
    session: { ...fakeSession(), botId: leader.id, workspaceDir: leader.workspaceDir },
    requestedPrompt: "私聊任务",
    answer: "不应派发",
    replyToMessageId: "direct-dispatch-message",
    hasThread: false,
    taskId: "direct-dispatch-task",
    interaction: createInteractionPolicy("direct"),
    result: {
      answer: "不应派发",
      toolCalls: [{
        toolUseId: "dispatch-direct",
        toolName: "dispatch_task",
        input: {
          targetBotId: "product",
          objective: "不应发送",
          instruction: "私聊禁止跨 bot 互动。",
        },
      }],
    },
    runId: "run-direct-dispatch",
    senderOpenId: "ou_direct",
    cardMessageId: "card-direct-dispatch",
  } satisfies TaskToolCallsPayload;

  const outcome = await host.root.serial("task/tool-calls", payload);
  assert.equal(outcome, undefined);
  assert.equal(host.calls.sentToChat.length, 0);
  assert.equal(host.calls.mentions.length, 0);
});

test("私聊即使命中旧交接单也忽略 bot 消息", async () => {
  const leaderInput: BotConfig = { ...baseBotConfig, id: "leader" };
  const productInput: BotConfig = { ...baseBotConfig, id: "product" };
  const host = await createHost([leaderInput, productInput]);
  const leader = host.root.config.bot("leader")!;
  const product = host.root.config.bot("product")!;
  host.lark.runtimes.set("leader", {
    config: leader,
    bot: host.bot,
    identity: { openId: "leader_open", name: "leader" },
  });
  host.lark.runtimes.set("product", {
    config: product,
    bot: host.bot,
    identity: { openId: "product_open", name: "product" },
  });

  await host.root.collaboration.sendDispatch({
    senderConfig: leader,
    senderBot: host.bot,
    replyToMessageId: "dispatch-root",
    targetBotId: "product",
    taskId: "p2p-collaboration",
    ownerOpenId: "ou_owner",
    reportToBotId: "leader",
    objective: "不应在私聊恢复",
    instruction: "私聊禁止跨 bot 互动。",
    expectedOutput: "无",
    round: 1,
    maxRounds: 2,
    workspaceDir: leader.workspaceDir,
  });
  const dispatchId = host.calls.mentions
    .at(-1)
    ?.match(/任务编号：([a-f0-9]{12})/)?.[1];
  assert.ok(dispatchId);

  await host.root.parallel(
    "bot/message",
    incomingMessage({
      chatType: "p2p",
      senderType: "app",
      senderOpenId: "leader_open",
      text: `新的协作任务（任务编号：${dispatchId}）`,
      mentions: [{ key: "@_user_1", name: "product", openId: "product_open" }],
    }),
    host.bot,
    product,
  );
  assert.equal(host.cli.captures.length, 0);
});

test("普通成员结果固定交回 reportToBotId，编排者收口后通知真人", async () => {
  const leaderInput: BotConfig = { ...baseBotConfig, id: "leader" };
  const developerInput: BotConfig = { ...baseBotConfig, id: "developer" };
  const host = await createHost([leaderInput, developerInput]);
  const leader = host.root.config.bot("leader")!;
  const developer = host.root.config.bot("developer")!;
  for (const config of [leader, developer]) {
    host.lark.runtimes.set(config.id, {
      config,
      bot: host.bot,
      identity: { openId: `${config.id}_open`, name: config.id },
    });
  }
  const collaboration: CollaborationMessage = {
    dispatchId: "member-turn-1",
    taskId: "team-task-2",
    ownerOpenId: "ou_owner",
    ownerUnionId: "on_owner",
    fromBotId: "leader",
    toBotId: "developer",
    reportToBotId: "leader",
    objective: "实现用户分组",
    instruction: "完成实现和验证。",
    expectedOutput: "可交付实现。",
    round: 1,
    maxRounds: 4,
    workspaceDir: developer.workspaceDir,
  };
  await host.root.parallel("task/result", {
    bot: host.bot,
    botConfig: developer,
    session: { ...fakeSession(), botId: developer.id, workspaceDir: developer.workspaceDir },
    requestedPrompt: collaboration.instruction,
    answer: "实现与测试均已完成。",
    replyToMessageId: "developer-message",
    hasThread: true,
    collaboration,
  });
  const returnDispatchId = host.calls.mentions
    .at(-1)
    ?.match(/任务编号：([a-f0-9]{12})/)?.[1];
  assert.ok(returnDispatchId);
  const returned = host.root.collaboration.consume(returnDispatchId, "leader");
  assert.equal(returned?.reportToBotId, "leader");
  assert.equal(returned?.round, 2);
  assert.match(returned?.instruction ?? "", /实现与测试均已完成/);

  await host.root.parallel("task/result", {
    bot: host.bot,
    botConfig: leader,
    session: { ...fakeSession(), botId: leader.id, workspaceDir: leader.workspaceDir },
    requestedPrompt: returned!.instruction,
    answer: "团队任务已完成。",
    replyToMessageId: "leader-message",
    hasThread: true,
    collaboration: returned,
  });
  assert.ok(
    host.calls.mentions.some((text) =>
      text.includes("协作任务“实现用户分组”已经完成"),
    ),
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
      cardSummaryContains(card, "协作任务已派发"),
    ),
  );
  assert.ok(
    host.calls.mentions.some((text) => text.includes("新的协作任务")),
  );
});

function qaAnswer(
  revision: string,
  verdict: "pass" | "changes_requested" | "blocked",
): string {
  const action = {
    pass: "close",
    changes_requested: "return_to_developer",
    blocked: "escalate",
  }[verdict];
  return JSON.stringify({
    verdict,
    revision,
    tests: [{ command: "pnpm test", status: "passed", exitCode: 0 }],
    findings: verdict === "pass"
      ? []
      : [{
          id: "QA-001",
          severity: verdict === "changes_requested" ? "P1" : "P2",
          location: "src/module.ts:10",
          reproduction: "运行相关测试",
          expected: "行为符合验收标准",
          actual: "行为不符合或环境缺失",
          recommendation: "修复后重新执行测试",
        }],
    nextAction: action,
  });
}

async function beginQaReview(
  host: Host,
  developer: BotConfig,
): Promise<CollaborationMessage> {
  await host.root.parallel("task/result", {
    bot: host.bot,
    botConfig: developer,
    session: { ...fakeSession(), botId: developer.id },
    requestedPrompt: "实现用户注册功能",
    answer: "开发完成",
    replyToMessageId: "m1",
    hasThread: false,
    taskId: "qa-task-1",
  });
  const dispatchId = host.calls.mentions
    .at(-1)
    ?.match(/任务编号：([a-f0-9]{12})/)?.[1];
  assert.ok(dispatchId, "QA 派发必须携带任务编号");
  const collaboration = host.root.collaboration.consume(dispatchId, "qa");
  assert.ok(collaboration?.qaReview?.revision, "QA 交接单必须携带 revision");
  assert.equal(collaboration.taskId, "qa-task-1", "QA 必须沿用原交付任务 ID");
  assert.notEqual(
    collaboration.workspaceDir,
    collaboration.qaReview.sourceWorkspaceDir,
    "QA 必须在隔离快照中审查，而不是直接使用 Developer 工作区",
  );
  assert.equal(
    collaboration.workspaceDir,
    collaboration.qaReview.snapshotWorkspaceDir,
  );
  await access(collaboration.workspaceDir);
  return collaboration;
}

async function qaGateHost() {
  const leader: BotConfig = { ...baseBotConfig, id: "leader" };
  const developer: BotConfig = {
    ...baseBotConfig,
    id: "developer",
    reviewBy: "qa",
  };
  const qa: BotConfig = { ...baseBotConfig, id: "qa" };
  const host = await createHost([leader, developer, qa]);
  for (const config of [leader, developer, qa]) {
    host.lark.runtimes.set(config.id, {
      config,
      bot: host.bot,
      identity: { openId: `${config.id}_open`, name: config.id },
    });
  }
  return { host, leader, developer, qa };
}

test("QAResult pass 立即结束 reviewBy，不再交回 Developer", async () => {
  const { host, developer, qa } = await qaGateHost();
  const collaboration = await beginQaReview(host, developer);
  const revision = collaboration.qaReview!.revision;

  await host.root.parallel("task/result", {
    bot: host.bot,
    botConfig: qa,
    session: { ...fakeSession(), botId: qa.id },
    requestedPrompt: collaboration.instruction,
    answer: qaAnswer(revision, "pass"),
    replyToMessageId: "qa-message",
    hasThread: true,
    collaboration,
  });

  assert.ok(host.calls.mentions.some((text) => text.includes("QA 审查通过")));
  assert.equal(
    host.calls.mentions.filter((text) => text.includes("协作结果已经返回")).length,
    0,
  );
  await assert.rejects(access(collaboration.workspaceDir), /ENOENT/);
});

test("QAResult changes_requested 只生成给 Developer 的返工交接", async () => {
  const { host, developer, qa } = await qaGateHost();
  const collaboration = await beginQaReview(host, developer);

  await host.root.parallel("task/result", {
    bot: host.bot,
    botConfig: qa,
    session: { ...fakeSession(), botId: qa.id },
    requestedPrompt: collaboration.instruction,
    answer: qaAnswer(collaboration.qaReview!.revision, "changes_requested"),
    replyToMessageId: "qa-message",
    hasThread: true,
    collaboration,
  });

  const dispatchId = host.calls.mentions
    .at(-1)
    ?.match(/任务编号：([a-f0-9]{12})/)?.[1];
  assert.ok(dispatchId);
  const rework = host.root.collaboration.consume(dispatchId, "developer");
  assert.equal(rework?.qaReview?.stage, "rework");
  assert.equal(
    rework?.workspaceDir,
    collaboration.qaReview!.sourceWorkspaceDir,
    "返工必须回到 Developer 源工作区",
  );
  assert.equal(host.root.collaboration.consume(dispatchId, "leader"), undefined);
  await assert.rejects(access(collaboration.workspaceDir), /ENOENT/);
});

test("QAResult blocked 只升级 Team Leader，不回传 Developer", async () => {
  const { host, developer, qa } = await qaGateHost();
  const collaboration = await beginQaReview(host, developer);

  await host.root.parallel("task/result", {
    bot: host.bot,
    botConfig: qa,
    session: { ...fakeSession(), botId: qa.id },
    requestedPrompt: collaboration.instruction,
    answer: qaAnswer(collaboration.qaReview!.revision, "blocked"),
    replyToMessageId: "qa-message",
    hasThread: true,
    collaboration,
  });

  const dispatchId = host.calls.mentions
    .at(-1)
    ?.match(/任务编号：([a-f0-9]{12})/)?.[1];
  assert.ok(dispatchId);
  assert.ok(host.root.collaboration.consume(dispatchId, "leader"));
  assert.equal(host.root.collaboration.consume(dispatchId, "developer"), undefined);
  await assert.rejects(access(collaboration.workspaceDir), /ENOENT/);
});

test("QA 快照被修改时拒绝 pass 并升级 Team Leader", async () => {
  const { host, developer, qa } = await qaGateHost();
  const collaboration = await beginQaReview(host, developer);
  await writeFile(join(collaboration.workspaceDir, "qa-mutated.txt"), "changed", "utf8");

  await host.root.parallel("task/result", {
    bot: host.bot,
    botConfig: qa,
    session: { ...fakeSession(), botId: qa.id },
    requestedPrompt: collaboration.instruction,
    answer: qaAnswer(collaboration.qaReview!.revision, "pass"),
    replyToMessageId: "qa-message",
    hasThread: true,
    collaboration,
  });

  const dispatchId = host.calls.mentions
    .at(-1)
    ?.match(/任务编号：([a-f0-9]{12})/)?.[1];
  assert.ok(dispatchId);
  assert.ok(host.root.collaboration.consume(dispatchId, "leader"));
  assert.equal(host.root.collaboration.consume(dispatchId, "developer"), undefined);
});

test("QA CLI 执行失败时生成 blocked 结论并升级 Team Leader", async () => {
  const { host, developer, qa } = await qaGateHost();
  const collaboration = await beginQaReview(host, developer);

  await host.root.parallel("task/failed", {
    bot: host.bot,
    botConfig: qa,
    session: { ...fakeSession(), botId: qa.id },
    requestedPrompt: collaboration.instruction,
    answer: "",
    replyToMessageId: "qa-message",
    hasThread: true,
    collaboration,
  });

  const dispatchId = host.calls.mentions
    .at(-1)
    ?.match(/任务编号：([a-f0-9]{12})/)?.[1];
  assert.ok(dispatchId);
  assert.ok(host.root.collaboration.consume(dispatchId, "leader"));
  await assert.rejects(access(collaboration.workspaceDir), /ENOENT/);
});

test("Developer 返工后的复审快照创建失败时清理旧快照并升级 Team Leader", async () => {
  const { host, developer } = await qaGateHost();
  const collaboration = await beginQaReview(host, developer);
  const rework: CollaborationMessage = {
    ...collaboration,
    fromBotId: "qa",
    toBotId: developer.id,
    round: 2,
    maxRounds: 4,
    workspaceDir: collaboration.qaReview!.sourceWorkspaceDir,
    qaReview: { ...collaboration.qaReview!, stage: "rework" },
  };
  let emittedVerdict: string | undefined;
  host.root.on("qa/result", (payload) => {
    emittedVerdict = payload.qaResult.verdict;
  });

  const originalSnapshot = host.root.workspaces.snapshot.bind(
    host.root.workspaces,
  );
  host.root.workspaces.snapshot = async () => {
    throw new Error("模拟复审快照失败");
  };
  try {
    await host.root.parallel("task/result", {
      bot: host.bot,
      botConfig: developer,
      session: { ...fakeSession(), botId: developer.id },
      requestedPrompt: rework.instruction,
      answer: "返工完成",
      replyToMessageId: "developer-message",
      hasThread: true,
      collaboration: rework,
    });
  } finally {
    host.root.workspaces.snapshot = originalSnapshot;
  }

  assert.equal(emittedVerdict, "blocked");
  await assert.rejects(access(collaboration.workspaceDir), /ENOENT/);
  const dispatchId = host.calls.mentions
    .at(-1)
    ?.match(/任务编号：([a-f0-9]{12})/)?.[1];
  assert.ok(dispatchId);
  assert.ok(host.root.collaboration.consume(dispatchId, "leader"));
  assert.equal(host.root.collaboration.consume(dispatchId, "qa"), undefined);
  assert.ok(
    !host.calls.replies.some((text) => text.includes("QA Gate 处理失败")),
    "复审快照失败必须由 blocked 结论收口，而不是落入通用错误回复",
  );
});

test("/orchestrate 拆解任务、并行派发、收集结果并 /panel 展示", async () => {
  const orchestratorConfig: BotConfig = {
    ...baseBotConfig,
    proxy: "http://127.0.0.1:10808",
  };
  const developerConfig: BotConfig = { ...baseBotConfig, id: "developer" };
  const productConfig: BotConfig = { ...baseBotConfig, id: "product" };
  const host = await createHost([orchestratorConfig, developerConfig, productConfig]);
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
    orchestratorConfig,
  );
  await waitFor(() => host.cli.captured !== undefined);
  assert.ok(
    host.cli.captured?.prompt.includes("可派发的成员"),
    "拆解提示词必须列出可派发的成员",
  );
  assert.equal(
    host.cli.captured?.env?.HTTPS_PROXY,
    orchestratorConfig.proxy,
    "编排拆解也必须继承发起 Bot 的代理环境",
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

  // 默认 topic 模式：每个子任务在编排所在群发一条新根消息（独立话题）@ 目标 bot。
  await waitFor(() => host.calls.sentToChat.length >= 2);
  const dispatch = host.calls.sentToChat.find((item) =>
    item.text.includes("编排 run-001"),
  )!;
  assert.equal(dispatch.chatId, "chat1", "独立话题派发应发到编排所在群");
  const dispatchId = dispatch.text.match(/任务编号：([a-f0-9]{12})/)?.[1];
  assert.ok(dispatchId, "@ 派发必须携带协作交接单任务编号");
  const subTaskMessage = host.root.collaboration.consume(dispatchId, "developer");
  assert.ok(subTaskMessage, "编排子任务必须使用已登记的真实交接单");
  assert.equal(
    host.calls.mentions.length,
    0,
    "topic 模式不能走 replyMention 派发",
  );
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
    collaboration: subTaskMessage,
  });
  assert.equal(
    host.calls.mentions.length,
    0,
    "编排叶子结果由 orchestration 收集，不能逐项通知真人",
  );

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

test("/orchestrate 拒绝通过目录别名共享同一物理工作区的不同 Bot", async (t) => {
  if (platform() !== "win32") {
    t.skip("junction 别名用例仅在 Windows 验证");
    return;
  }
  const developerConfig: BotConfig = { ...baseBotConfig, id: "developer" };
  const qaConfig: BotConfig = { ...baseBotConfig, id: "qa" };
  const host = await createHost([baseBotConfig, developerConfig, qaConfig]);
  const targetDir = host.root.config.bot("developer")!.workspaceDir;
  const aliasDir = join(dirname(targetDir), "workspace-qa-alias");
  await symlink(targetDir, aliasDir, "junction");
  host.root.config.bot("qa")!.workspaceDir = aliasDir;
  for (const config of [developerConfig, qaConfig]) {
    host.lark.runtimes.set(config.id, {
      config,
      bot: host.bot,
      identity: { openId: `${config.id}_open`, name: config.id },
    });
  }

  await host.root.parallel(
    "bot/message",
    incomingMessage({ text: "/orchestrate 并行开发与测试" }),
    host.bot,
    baseBotConfig,
  );
  await waitFor(() => host.cli.captured !== undefined);
  host.cli.finish({
    answer: JSON.stringify({
      tasks: [
        { id: "dev", prompt: "实现", bot: "developer" },
        { id: "qa", prompt: "测试", bot: "qa" },
      ],
    }),
  });

  await waitFor(() =>
    host.calls.replies.some((text) => text.includes("共享可写工作目录")),
  );
  assert.equal(host.root.orchestration.list().length, 0);
  assert.equal(host.calls.sentToChat.length, 0);
});

test("/panel 只展示当前 chatId 与 botId 的 run，不泄露其他租户内容", async () => {
  const developerConfig: BotConfig = { ...baseBotConfig, id: "developer" };
  const host = await createHost([baseBotConfig, developerConfig]);
  host.lark.runtimes.set("developer", {
    config: developerConfig,
    bot: host.bot,
    identity: { openId: "developer_open", name: "Developer" },
  });

  const start = async (
    config: BotConfig,
    chatId: string,
    messageId: string,
    prompt: string,
    targetBot: string,
  ) => {
    const previousCaptures = host.cli.captures.length;
    await host.root.parallel(
      "bot/message",
      incomingMessage({
        chatId,
        messageId,
        text: `/orchestrate ${prompt}`,
      }),
      host.bot,
      config,
    );
    await waitFor(() => host.cli.captures.length >= previousCaptures + 1);
    host.cli.finish({
      answer: JSON.stringify({
        tasks: [{ id: "t1", prompt, bot: targetBot }],
      }),
    });
    await waitFor(() => host.root.orchestration.list().length >= previousCaptures + 1);
  };

  await start(baseBotConfig, "chat1", "panel-1", "CHAT1-PRIVATE", "testbot");
  await start(baseBotConfig, "chat2", "panel-2", "CHAT2-PRIVATE", "testbot");
  await start(developerConfig, "chat1", "panel-3", "BOT-PRIVATE", "developer");

  await emitSubTaskResult(host, "run-001", "t1", "testbot", "CHAT1-ANSWER");
  await emitSubTaskResult(host, "run-002", "t1", "testbot", "CHAT2-ANSWER");
  await host.root.parallel("task/failed", {
    bot: host.bot,
    botConfig: developerConfig,
    session: fakeSession(),
    requestedPrompt: "BOT-PRIVATE",
    answer: "",
    replyToMessageId: "panel-3",
    hasThread: false,
    collaboration: subTaskCollaboration(host, "run-003", "t1", "developer"),
  });

  await host.root.parallel(
    "bot/message",
    incomingMessage({ chatId: "chat1", messageId: "panel-query", text: "/panel" }),
    host.bot,
    baseBotConfig,
  );
  const panel = JSON.stringify(host.calls.cards[host.calls.cards.length - 1]);
  assert.ok(panel.includes("CHAT1-PRIVATE"), "当前群当前 bot 的 prompt 应展示");
  assert.ok(panel.includes("CHAT1-ANSWER"), "当前群当前 bot 的 answer 应展示");
  assert.ok(!panel.includes("CHAT2-PRIVATE"), "其他群的 prompt 不得泄露");
  assert.ok(!panel.includes("CHAT2-ANSWER"), "其他群的 answer 不得泄露");
  assert.ok(!panel.includes("BOT-PRIVATE"), "同群其他 bot 的 prompt 不得泄露");
  assert.ok(!panel.includes("任务执行失败"), "同群其他 bot 的 error 不得泄露");
});

test("same-topic 模式派发复用当前话题 replyMention（P0 降级）", async () => {
  const developerConfig: BotConfig = { ...baseBotConfig, id: "developer" };
  const host = await createHost(
    [baseBotConfig, developerConfig],
    "connected",
    { dispatchMode: "same-topic" },
  );
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
  assert.ok(
    mention.match(/任务编号：([a-f0-9]{12})/),
    "same-topic 派发仍携带协作交接单任务编号",
  );
  assert.equal(
    host.calls.sentToChat.length,
    0,
    "same-topic 模式不能走独立话题派发",
  );
});

test("协作 processedTurns 超过容量后淘汰最旧键，避免无界增长", async () => {
  const host = await createHost();
  for (let index = 0; index < MAX_PROCESSED_TURNS + 1; index++) {
    host.root.collaboration.markTurnProcessed(`turn-${index}`);
  }
  assert.equal(
    host.root.collaboration.processedTurns.size,
    MAX_PROCESSED_TURNS,
    "去重表必须有界",
  );
  assert.equal(
    host.root.collaboration.isTurnProcessed("turn-0"),
    false,
    "超过容量后应淘汰最旧键",
  );
  assert.equal(
    host.root.collaboration.isTurnProcessed(`turn-${MAX_PROCESSED_TURNS}`),
    true,
    "最新键必须保留",
  );
});

test("topic 模式派发返回空 message_id 时子任务失败且撤销交接单", async () => {
  const developerConfig: BotConfig = { ...baseBotConfig, id: "developer" };
  const host = await createHost(
    [baseBotConfig, developerConfig],
    "connected",
    {},
    false,
    false,
    { emptySendMention: true },
  );
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

  await waitFor(() =>
    host.calls.replies.some((text) => text.includes("已创建 run-001")),
  );
  const sub = host.root.orchestration.list()[0].subTasks[0];
  assert.equal(sub.status, "failed", "空 message_id 不能留下永久 pending");
  assert.equal(sub.currentDispatchId, undefined, "失败后必须清空当前交接单号");
  assert.ok(
    host.calls.replies.some((text) => text.includes("没有返回编排派发 message_id")),
    "汇总应说明飞书没有返回消息 ID",
  );
});

test("same-topic 模式派发返回空 message_id 时子任务失败且撤销交接单", async () => {
  const developerConfig: BotConfig = { ...baseBotConfig, id: "developer" };
  const host = await createHost(
    [baseBotConfig, developerConfig],
    "connected",
    { dispatchMode: "same-topic" },
    false,
    false,
    { emptyReplyMention: true },
  );
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

  await waitFor(() =>
    host.calls.replies.some((text) => text.includes("已创建 run-001")),
  );
  const sub = host.root.orchestration.list()[0].subTasks[0];
  assert.equal(sub.status, "failed", "空 message_id 不能留下永久 pending");
  assert.equal(sub.currentDispatchId, undefined, "失败后必须清空当前交接单号");
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
  await waitFor(() => host.calls.sentToChat.length >= 1);
  const dispatch = host.calls.sentToChat.find((item) =>
    item.text.includes("编排 run-001"),
  )!;
  const dispatchId = dispatch.text.match(/任务编号：([a-f0-9]{12})/)?.[1];
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
    collaboration: subTaskCollaboration(host, "run-001", "t1", "developer"),
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

test("same-topic 模式：拆解把多个子任务分配给同一 bot 时整轮拒绝（降级保留）", async () => {
  const developerConfig: BotConfig = { ...baseBotConfig, id: "developer" };
  const host = await createHost(
    [baseBotConfig, developerConfig],
    "connected",
    { dispatchMode: "same-topic" },
  );
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

  // 拆解结果把两个子任务都分给同一个 bot：same-topic 降级必须整轮拒绝，避免 router
  // busy 检查消费交接单后丢弃第二个子任务。
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
    host.calls.sentToChat.length,
    0,
    "拒绝后不能有任何独立话题派发",
  );
  assert.equal(
    host.root.orchestration.list().length,
    0,
    "拒绝后不能创建 run",
  );
});

test("topic 模式：同一 bot 的多个子任务经真实 bot/message 路由并行进入 active", async () => {
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

  // 拆解结果把两个子任务都分给同一个 bot：topic 模式应放行，不整轮拒绝。
  host.cli.finish({
    answer: JSON.stringify({
      tasks: [
        { id: "t1", prompt: "分析模块 A", bot: "developer" },
        { id: "t2", prompt: "分析模块 B", bot: "developer" },
      ],
    }),
  });
  await waitFor(() => host.calls.sentToChat.length >= 2);
  const run = host.root.orchestration.list()[0];
  assert.equal(run.subTasks.length, 2, "topic 模式必须放行同 bot 多子任务");

  // 两个独立根消息：chatId 相同，文本分别对应不同子任务、携带不同交接单号。
  const [m1, m2] = host.calls.sentToChat;
  assert.equal(m1.chatId, "chat1");
  assert.equal(m2.chatId, "chat1");
  assert.ok(m1.text.includes("编排 run-001·t1") && m1.text.includes("分析模块 A"));
  assert.ok(m2.text.includes("编排 run-001·t2") && m2.text.includes("分析模块 B"));
  const d1 = m1.text.match(/任务编号：([a-f0-9]{12})/)?.[1];
  const d2 = m2.text.match(/任务编号：([a-f0-9]{12})/)?.[1];
  assert.ok(d1 && d2 && d1 !== d2, "两个子任务必须使用不同交接单号");

  // 用两个根消息构造目标 bot（developer）的 bot/message 协作事件，走真实 router 链路。
  // 每条独立根消息对应一个独立会话地址（messageId 充当话题键），模拟飞书独立话题。
  const collaborationMessage = (
    dispatchId: string,
    messageId: string,
    subTaskId: string,
    promptText: string,
  ) =>
    incomingMessage({
      messageId,
      senderType: "bot",
      senderOpenId: "bot_open",
      messageType: "post",
      text: `【编排 run-001·${subTaskId}】${promptText}（任务编号：${dispatchId}）`,
      mentions: [{ key: "@_user_1", name: "Developer", openId: "developer_open" }],
    });

  await host.root.parallel(
    "bot/message",
    collaborationMessage(d1, "m-t1", "t1", "分析模块 A"),
    host.bot,
    developerConfig,
  );
  await host.root.parallel(
    "bot/message",
    collaborationMessage(d2, "m-t2", "t2", "分析模块 B"),
    host.bot,
    developerConfig,
  );

  // 两个独立话题都能进入 active：TasksService 按会话 id 统计运行轮次。
  await waitFor(() => host.root.tasks.activeRunCount >= 2);
  assert.equal(
    host.root.tasks.activeRunCount,
    2,
    "同一 bot 的两个子任务必须并行进入 active",
  );

  // 两个任务分别以各自子任务提示词启动 CLI（captures 含拆解 + t1 + t2 三轮）。
  const prompts = host.cli.captures.map((capture) => capture.prompt ?? "");
  assert.ok(
    prompts.some((p) => p.includes("分析模块 A")),
    "t1 子任务经真实路由启动",
  );
  assert.ok(
    prompts.some((p) => p.includes("分析模块 B")),
    "t2 子任务经真实路由启动",
  );

  // 收尾：完成两个并行任务，让任务收尾清理心跳与卡片节流定时器，避免进程悬挂不退出。
  host.cli.finishAll({ answer: "完成", sessionId: "sess-1" });
  await waitFor(() => host.root.tasks.activeRunCount === 0);
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
      collaboration: subTaskCollaboration(host, `run-${runNum}`, "t1", "developer"),
    });
  }

  const runs = host.root.orchestration.list();
  assert.ok(runs.length <= MAX_RUNS, "runs 表不能超过 MAX_RUNS 条");
  const ids = runs.map((run) => run.runId);
  assert.ok(!ids.includes("run-001"), "最旧的 run 已被淘汰");
  assert.ok(ids.includes("run-022"), "最新的 run 保留");
});

test("pending run 超时后收口为 failed，并撤销未领取交接单", async () => {
  const developerConfig: BotConfig = { ...baseBotConfig, id: "developer" };
  const host = await createHost(
    [baseBotConfig, developerConfig],
    "connected",
    { pendingTimeoutMs: 20 },
  );
  host.lark.runtimes.set("developer", {
    config: developerConfig,
    bot: host.bot,
    identity: { openId: "developer_open", name: "Developer" },
  });

  await host.root.parallel(
    "bot/message",
    incomingMessage({ text: "/orchestrate 等待成员结果" }),
    host.bot,
    baseBotConfig,
  );
  await waitFor(() => host.cli.captured !== undefined);
  host.cli.finish({
    answer: JSON.stringify({
      tasks: [{ id: "t1", prompt: "等待结果", bot: "developer" }],
    }),
  });
  await waitFor(() =>
    host.root.orchestration.list()[0]?.subTasks[0]?.status === "failed",
  );
  const sub = host.root.orchestration.list()[0].subTasks[0];
  assert.match(sub.error ?? "", /等待子任务结果超时/);
  assert.equal(sub.currentDispatchId, undefined, "超时后应清理当前交接单号");
});

/** 构造测试用会话：编排 handleTaskOutcome 只读 collaboration，session 仅为补齐事件类型。 */
function fakeSession(): Session {
  return {
    id: "s1",
    botId: "testbot",
    threadId: "thread1",
    chatId: "chat1",
    cliId: "codex",
    workspaceDir: process.cwd(),
    status: "idle",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 构造子任务协作事件用的交接单：taskId 绑定 run 实例 instanceId（而非展示 runId），
 * dispatchId 取该子任务当前派发尝试（currentDispatchId），保证 handleTaskOutcome 的
 * dispatchId 校验通过；重试后调用仍能匹配最新一次派发。
 */
function subTaskCollaboration(
  host: Host,
  runId: string,
  subTaskId: string,
  toBotId: string,
): CollaborationMessage {
  const run = host.root.orchestration
    .list()
    .find((item) => item.runId === runId);
  assert.ok(run, `找不到 run ${runId}`);
  const sub = run.subTasks.find((item) => item.id === subTaskId);
  assert.ok(sub, `找不到子任务 ${subTaskId}`);
  return {
    dispatchId: sub.currentDispatchId ?? "",
    taskId: `${run.instanceId}#${subTaskId}`,
    ownerOpenId: run.ownerOpenId,
    fromBotId: "testbot",
    toBotId,
    reportToBotId: "testbot",
    objective: `编排 ${runId} · ${subTaskId}`,
    instruction: "分析模块 A",
    round: 1,
    maxRounds: 1,
    workspaceDir: process.cwd(),
    suppressAutomaticHandoff: true,
  };
}

/** 广播一次 task/result，驱动编排子任务进入 done 状态；交接单取自当前派发尝试。 */
async function emitSubTaskResult(
  host: Host,
  runId: string,
  subTaskId: string,
  toBotId: string,
  answer = "完成",
): Promise<void> {
  await host.root.parallel("task/result", {
    bot: host.bot,
    botConfig: { ...baseBotConfig, id: toBotId },
    session: fakeSession(),
    requestedPrompt: "分析模块 A",
    answer,
    replyToMessageId: "m1",
    hasThread: false,
    collaboration: subTaskCollaboration(host, runId, subTaskId, toBotId),
  });
}

/** 构造一个指定状态的编排 run 快照，供直接广播 orchestration/update 事件。 */
function fakeRun(
  runId: string,
  statuses: Array<"pending" | "done" | "failed">,
) {
  return {
    runId,
    instanceId: `instance-${runId}`,
    prompt: `任务 ${runId}`,
    ownerOpenId: "ou_owner",
    chatId: "chat1",
    botId: "testbot",
    startedAt: new Date().toISOString(),
    subTasks: statuses.map((status, index) => ({
      id: `t${index + 1}`,
      prompt: `子任务 ${index + 1}`,
      targetBotId: status === "pending" ? "testbot" : "developer",
      status,
      retryCount: 0,
      attempt: 0,
    })),
  };
}

test("live-panel：/orchestrate 自动挂起实时面板卡片，子任务变化节流刷新、终态定格", async () => {
  const developerConfig: BotConfig = { ...baseBotConfig, id: "developer" };
  const productConfig: BotConfig = { ...baseBotConfig, id: "product" };
  const host = await createHost(
    [baseBotConfig, developerConfig, productConfig],
    "connected",
    {},
    true,
  );
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

  await host.root.parallel(
    "bot/message",
    incomingMessage({ text: "/orchestrate 检查模块 A 和模块 B" }),
    host.bot,
    baseBotConfig,
  );
  await waitFor(() => host.cli.captured !== undefined);
  host.cli.finish({
    answer: JSON.stringify({
      tasks: [
        { id: "t1", prompt: "分析模块 A", bot: "developer" },
        { id: "t2", prompt: "分析模块 B", bot: "product" },
      ],
    }),
  });

  // 创建 run 后广播 update（带锚点），live-panel 自动挂起一张实时面板卡片。
  await waitFor(() => host.calls.cards.length >= 1);
  const panel = JSON.stringify(host.calls.cards[0]);
  assert.ok(panel.includes("run-001"), "面板卡片包含编排运行号");
  assert.ok(panel.includes("⏳ 等待"), "初始快照两个子任务处于等待");

  // 子任务 t1 完成：状态变化广播触发节流刷新（1s 窗口内提交一次 updateCard）。
  await emitSubTaskResult(host, "run-001", "t1", "developer", "A 完成");
  await waitFor(() => host.calls.updates.length >= 1);
  const updated = JSON.stringify(host.calls.updates[0]);
  assert.ok(updated.includes("✅ 完成"), "节流刷新后的卡片标记 t1 完成");
  assert.ok(updated.includes("⏳ 等待"), "t2 未完成仍保持等待");

  // 子任务 t2 完成：run 全终态，live-panel finish 定格（最终卡片展示全部完成）。
  await emitSubTaskResult(host, "run-001", "t2", "product", "B 完成");
  await waitFor(() => host.calls.updates.length >= 2);
  const finalCard = JSON.stringify(
    host.calls.updates[host.calls.updates.length - 1],
  );
  assert.ok(finalCard.includes("✅ 完成"), "终态卡片标记全部完成");
  assert.ok(!finalCard.includes("⏳ 等待"), "终态后不再显示等待");
});

test("live-panel：run 被淘汰后停止更新已淘汰 run 的卡片", async () => {
  const host = await createHost([baseBotConfig], "connected", {}, true);

  // 首次 update 带锚点：自动挂起一张实时面板卡片。
  await host.root.parallel("orchestration/update", {
    run: fakeRun("run-001", ["pending", "pending"]),
    anchor: { bot: host.bot, replyToMessageId: "m1", hasThread: false },
  });
  assert.equal(host.calls.cards.length, 1, "首次 update 应挂起一张面板卡片");

  // 非终态更新（t1 完成）：节流刷新该 run 的卡片。
  await host.root.parallel("orchestration/update", {
    run: fakeRun("run-001", ["done", "pending"]),
  });
  await waitFor(() => host.calls.updates.length >= 1);

  // run 被淘汰：live-panel 清理对应节流引用，后续更新不再触碰该 run。
  await host.root.parallel("orchestration/evicted", { runId: "run-001" });
  await host.root.parallel("orchestration/update", {
    run: fakeRun("run-001", ["done", "done"]),
  });
  // 等一个节流窗口，确认淘汰后没有新的 updateCard 发出。
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(
    host.calls.updates.length,
    1,
    "淘汰后不能再更新已淘汰 run 的卡片",
  );
});

test("live-panel 未装配时 /orchestrate 仍只回复汇总文本（回退现有行为）", async () => {
  // 默认不挂 live-panel：orchestration/update 无消费者，事件空转无害。
  const host = await createHost();
  await host.root.parallel(
    "bot/message",
    incomingMessage({ text: "/orchestrate 检查模块 A" }),
    host.bot,
    baseBotConfig,
  );
  await waitFor(() => host.cli.captured !== undefined);
  host.cli.finish({
    answer: JSON.stringify({
      tasks: [{ id: "t1", prompt: "分析模块 A", bot: "testbot" }],
    }),
  });

  await waitFor(() =>
    host.calls.replies.some((text) => text.includes("已创建 run-001")),
  );
  assert.equal(
    host.calls.cards.length,
    0,
    "没有 live-panel 时不能自动挂面板卡片",
  );
});

/** 走完 /orchestrate → 拆解 → 派发 → task/failed → /panel，返回面板卡片与首个交接单号。 */
async function runFailedSubTaskPanel(
  host: Host,
): Promise<{ panel: Record<string, unknown>; firstDispatchId: string }> {
  const developerConfig: BotConfig = { ...baseBotConfig, id: "developer" };
  await host.root.parallel(
    "bot/message",
    incomingMessage({
      text: "/orchestrate 检查模块 A",
      senderOpenId: "ou_owner",
    }),
    host.bot,
    baseBotConfig,
  );
  await waitFor(() => host.cli.captured !== undefined);
  host.cli.finish({
    answer: JSON.stringify({
      tasks: [{ id: "t1", prompt: "分析模块 A", bot: "developer" }],
    }),
  });
  await waitFor(() => host.calls.sentToChat.length >= 1);
  const firstDispatchId =
    host.calls.sentToChat[0].text.match(/任务编号：([a-f0-9]{12})/)?.[1];
  assert.ok(firstDispatchId, "@ 派发必须携带协作交接单任务编号");

  await host.root.parallel("task/failed", {
    bot: host.bot,
    botConfig: developerConfig,
    session: fakeSession(),
    requestedPrompt: "分析模块 A",
    answer: "",
    replyToMessageId: "m1",
    hasThread: false,
    collaboration: subTaskCollaboration(host, "run-001", "t1", "developer"),
  });
  await host.root.parallel(
    "bot/message",
    incomingMessage({ text: "/panel" }),
    host.bot,
    baseBotConfig,
  );
  return {
    panel: host.calls.cards[host.calls.cards.length - 1],
    firstDispatchId: firstDispatchId!,
  };
}

test("失败子任务经 retry_subtask 重新派发：鉴权、新交接单、状态复位、令牌防重复", async () => {
  const developerConfig: BotConfig = { ...baseBotConfig, id: "developer" };
  const host = await createHost(
    [baseBotConfig, developerConfig],
    "connected",
    { maxRetry: 2 },
    false,
    true,
  );
  host.lark.runtimes.set("developer", {
    config: developerConfig,
    bot: host.bot,
    identity: { openId: "developer_open", name: "Developer" },
  });

  const { panel, firstDispatchId } = await runFailedSubTaskPanel(host);
  // 发起人来自 /orchestrate 消息 senderOpenId；子任务初始 retryCount 为 0。
  const run = host.root.orchestration.list()[0];
  assert.equal(run.ownerOpenId, "ou_owner", "run 记录发起人");
  assert.equal(run.subTasks[0].retryCount, 0, "子任务初始重试次数为 0");
  assert.equal(run.subTasks[0].status, "failed");

  const value = retrySubtaskValueOf(panel);
  assert.equal(value.runId, "run-001");
  assert.equal(value.subTaskId, "t1");
  // 重试令牌绑定 run 实例标识而非展示 runId，跨进程重启后旧令牌无法命中新 run。
  assert.match(
    String(value.retryToken),
    new RegExp(`^${run.instanceId}:t1:`),
  );

  // 非发起人点击被拒绝，且不产生新的派发。
  const forbidden = await host.root.serial(
    "bot/card-action",
    { operatorOpenId: "ou_other", messageId: "m1", value },
    host.bot,
    baseBotConfig,
  );
  assert.equal(forbidden?.toast?.content, "只有编排发起人可以重试子任务。");
  assert.equal(host.calls.sentToChat.length, 1, "非发起人点击不能重新派发");

  // 发起人点击：成功 toast + 新 @ 派发（新交接单号），子任务复位为 pending。
  const ok = await host.root.serial(
    "bot/card-action",
    { operatorOpenId: "ou_owner", messageId: "m1", value },
    host.bot,
    baseBotConfig,
  );
  assert.equal(ok?.toast?.content, "已重新派发，正在等待成员执行。");
  await waitFor(() => host.calls.sentToChat.length >= 2);
  const retriedDispatchId = host.calls.sentToChat[1].text.match(
    /任务编号：([a-f0-9]{12})/,
  )?.[1];
  assert.ok(retriedDispatchId, "重试必须重新派发并生成新的交接单号");
  assert.notEqual(retriedDispatchId, firstDispatchId, "重试不能复用旧交接单");
  assert.equal(host.root.orchestration.list()[0].subTasks[0].status, "pending");
  assert.equal(host.root.orchestration.list()[0].subTasks[0].retryCount, 1);
  assert.equal(
    host.root.orchestration.list()[0].subTasks[0].attempt,
    1,
    "重试后派发尝试计数递增",
  );

  // 同一令牌再次点击：状态已非 failed，不能再派发（防连点）。
  const replay = await host.root.serial(
    "bot/card-action",
    { operatorOpenId: "ou_owner", messageId: "m1", value },
    host.bot,
    baseBotConfig,
  );
  assert.notEqual(replay?.toast?.content, "已重新派发，正在等待成员执行。");
  assert.equal(host.calls.sentToChat.length, 2, "重复点击不能再次派发");

  // 重试后的子任务可正常完成。
  await emitSubTaskResult(host, "run-001", "t1", "developer", "重试后完成");
  await host.root.parallel(
    "bot/message",
    incomingMessage({ text: "/panel" }),
    host.bot,
    baseBotConfig,
  );
  assert.ok(
    JSON.stringify(host.calls.cards[host.calls.cards.length - 1]).includes(
      "✅ 完成",
    ),
    "重试后的子任务完成显示在面板",
  );
});

test("重试派发失败回滚为 failed，重复令牌被拒（duplicate）", async () => {
  const developerConfig: BotConfig = { ...baseBotConfig, id: "developer" };
  const host = await createHost(
    [baseBotConfig, developerConfig],
    "connected",
    { maxRetry: 2 },
    false,
    true,
  );
  host.lark.runtimes.set("developer", {
    config: developerConfig,
    bot: host.bot,
    identity: { openId: "developer_open", name: "Developer" },
  });

  const { panel } = await runFailedSubTaskPanel(host);
  const value = retrySubtaskValueOf(panel);

  // 移除目标 bot 运行时，让 dispatchSubTask 抛“成员未就绪”，走派发失败路径。
  host.lark.runtimes.delete("developer");
  const failed = await host.root.serial(
    "bot/card-action",
    { operatorOpenId: "ou_owner", messageId: "m1", value },
    host.bot,
    baseBotConfig,
  );
  assert.match(failed?.toast?.content ?? "", /重新派发失败/);
  const run = host.root.orchestration.list()[0];
  assert.equal(run.subTasks[0].status, "failed", "派发失败应回滚为 failed");
  assert.equal(run.subTasks[0].retryCount, 1, "一次重试尝试计入次数");
  assert.equal(run.subTasks[0].attempt, 1, "派发失败也计入一次尝试");

  // 同一令牌再次点击：令牌已被消费，拒绝为 duplicate，不产生新派发。
  const dup = await host.root.serial(
    "bot/card-action",
    { operatorOpenId: "ou_owner", messageId: "m1", value },
    host.bot,
    baseBotConfig,
  );
  assert.equal(dup?.toast?.content, "已处理过这次重试，请勿重复点击。");
  assert.equal(host.calls.sentToChat.length, 1, "两次点击都没有成功派发");
});

test("达到重试上限后不再渲染重试按钮且请求被拒（limit）", async () => {
  const developerConfig: BotConfig = { ...baseBotConfig, id: "developer" };
  const host = await createHost(
    [baseBotConfig, developerConfig],
    "connected",
    { maxRetry: 1 },
    false,
    true,
  );
  host.lark.runtimes.set("developer", {
    config: developerConfig,
    bot: host.bot,
    identity: { openId: "developer_open", name: "Developer" },
  });

  const { panel } = await runFailedSubTaskPanel(host);
  const value = retrySubtaskValueOf(panel);

  // 首次重试成功：retryCount -> 1（已达 maxRetry=1）。
  const ok = await host.root.serial(
    "bot/card-action",
    { operatorOpenId: "ou_owner", messageId: "m1", value },
    host.bot,
    baseBotConfig,
  );
  assert.equal(ok?.toast?.content, "已重新派发，正在等待成员执行。");
  await waitFor(() => host.calls.sentToChat.length >= 2);
  const retriedDispatchId = host.calls.sentToChat[1].text.match(
    /任务编号：([a-f0-9]{12})/,
  )?.[1];
  assert.ok(retriedDispatchId);

  // 重试的子任务再次失败：面板不再渲染重试按钮（已达上限）。
  await host.root.parallel("task/failed", {
    bot: host.bot,
    botConfig: developerConfig,
    session: fakeSession(),
    requestedPrompt: "分析模块 A",
    answer: "",
    replyToMessageId: "m1",
    hasThread: false,
    collaboration: subTaskCollaboration(host, "run-001", "t1", "developer"),
  });
  await host.root.parallel(
    "bot/message",
    incomingMessage({ text: "/panel" }),
    host.bot,
    baseBotConfig,
  );
  const finalPanel = host.calls.cards[host.calls.cards.length - 1];
  assert.throws(
    () => retrySubtaskValueOf(finalPanel),
    /找不到重试按钮/,
    "达上限后不能渲染重试按钮",
  );

  // 即便构造格式正确的令牌请求也被拒（limit）。
  const run = host.root.orchestration.list()[0];
  const limit = await host.root.serial(
    "bot/card-action",
    {
      operatorOpenId: "ou_owner",
      messageId: "m1",
      value: {
        action: "retry_subtask",
        runId: "run-001",
        subTaskId: "t1",
        retryToken: retryToken(run.instanceId, "t1", "manual"),
      },
    },
    host.bot,
    baseBotConfig,
  );
  assert.equal(limit?.toast?.content, "该子任务已达到重试次数上限。");
});

test("未装配 orchestration/actions 时面板不渲染重试按钮（下线即无按钮）", async () => {
  const developerConfig: BotConfig = { ...baseBotConfig, id: "developer" };
  // actions=false：重试插件下线，maxRetry 即使配置也不渲染按钮。
  const host = await createHost(
    [baseBotConfig, developerConfig],
    "connected",
    { maxRetry: 2 },
    false,
    false,
  );
  host.lark.runtimes.set("developer", {
    config: developerConfig,
    bot: host.bot,
    identity: { openId: "developer_open", name: "Developer" },
  });

  const { panel } = await runFailedSubTaskPanel(host);
  assert.throws(
    () => retrySubtaskValueOf(panel),
    /找不到重试按钮/,
    "actions 插件下线时面板不能渲染重试按钮",
  );
});

test("同一 dispatch 的终态事件幂等，done/failed 不互相覆盖", async () => {
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
  await waitFor(() => host.calls.sentToChat.length >= 1);

  const first = subTaskCollaboration(host, "run-001", "t1", "developer");
  await host.root.parallel("task/result", {
    bot: host.bot,
    botConfig: developerConfig,
    session: fakeSession(),
    requestedPrompt: "分析模块 A",
    answer: "首个成功结果",
    replyToMessageId: "m1",
    hasThread: false,
    collaboration: first,
  });
  await host.root.parallel("task/failed", {
    bot: host.bot,
    botConfig: developerConfig,
    session: fakeSession(),
    requestedPrompt: "分析模块 A",
    answer: "迟到失败",
    replyToMessageId: "m1",
    hasThread: false,
    collaboration: first,
  });
  const doneSub = host.root.orchestration.list()[0].subTasks[0];
  assert.equal(doneSub.status, "done");
  assert.equal(doneSub.answer, "首个成功结果");
  assert.equal(doneSub.error, undefined);

  // 重新建立一个失败子任务，验证失败终态之后的 result 也被忽略。
  await host.root.parallel(
    "bot/message",
    incomingMessage({ messageId: "m2", text: "/orchestrate 检查模块 B" }),
    host.bot,
    baseBotConfig,
  );
  await waitFor(() => host.cli.captures.length >= 2);
  host.cli.finish({
    answer: JSON.stringify({
      tasks: [{ id: "t1", prompt: "分析模块 B", bot: "developer" }],
    }),
  });
  await waitFor(() => host.calls.sentToChat.length >= 2);
  const second = subTaskCollaboration(host, "run-002", "t1", "developer");
  await host.root.parallel("task/failed", {
    bot: host.bot,
    botConfig: developerConfig,
    session: fakeSession(),
    requestedPrompt: "分析模块 B",
    answer: "失败原因",
    replyToMessageId: "m2",
    hasThread: false,
    collaboration: second,
  });
  await host.root.parallel("task/result", {
    bot: host.bot,
    botConfig: developerConfig,
    session: fakeSession(),
    requestedPrompt: "分析模块 B",
    answer: "迟到成功",
    replyToMessageId: "m2",
    hasThread: false,
    collaboration: second,
  });
  const failedSub = host.root.orchestration
    .list()
    .find((run) => run.runId === "run-002")!.subTasks[0];
  assert.equal(failedSub.status, "failed");
  assert.equal(failedSub.error, "任务执行失败");
});

test("重试后旧 attempt 的迟到结果被忽略（dispatchId 不匹配）", async () => {
  const developerConfig: BotConfig = { ...baseBotConfig, id: "developer" };
  const host = await createHost(
    [baseBotConfig, developerConfig],
    "connected",
    { maxRetry: 2 },
    false,
    true,
  );
  host.lark.runtimes.set("developer", {
    config: developerConfig,
    bot: host.bot,
    identity: { openId: "developer_open", name: "Developer" },
  });

  const { panel, firstDispatchId } = await runFailedSubTaskPanel(host);
  const value = retrySubtaskValueOf(panel);

  // 发起人点击重试：新交接单（attempt 1），子任务复位为 pending。
  const ok = await host.root.serial(
    "bot/card-action",
    { operatorOpenId: "ou_owner", messageId: "m1", value },
    host.bot,
    baseBotConfig,
  );
  assert.equal(ok?.toast?.content, "已重新派发，正在等待成员执行。");
  await waitFor(() => host.calls.sentToChat.length >= 2);
  const sub = host.root.orchestration.list()[0].subTasks[0];
  assert.equal(sub.attempt, 1, "重试后派发尝试递增");
  assert.notEqual(
    sub.currentDispatchId,
    firstDispatchId,
    "重试后 currentDispatchId 必须更新为新交接单",
  );

  // 旧 attempt（第一次派发）的迟到 task/result：dispatchId 不匹配，必须被忽略，
  // 不能把重试中的子任务标记为完成。
  await host.root.parallel("task/result", {
    bot: host.bot,
    botConfig: developerConfig,
    session: fakeSession(),
    requestedPrompt: "分析模块 A",
    answer: "旧结果",
    replyToMessageId: "m1",
    hasThread: false,
    collaboration: {
      ...subTaskCollaboration(host, "run-001", "t1", "developer"),
      dispatchId: firstDispatchId,
    },
  });
  assert.equal(
    host.root.orchestration.list()[0].subTasks[0].status,
    "pending",
    "旧 attempt 迟到结果不能覆盖重试中的状态",
  );

  // 新 attempt 的 result 正常接收：子任务进入 done。
  await emitSubTaskResult(host, "run-001", "t1", "developer", "重试完成");
  assert.equal(
    host.root.orchestration.list()[0].subTasks[0].status,
    "done",
    "当前 attempt 的结果应正常接收",
  );
});

test("子任务 @ 派发发送失败：撤销交接单并清空 currentDispatchId，迟到结果无法命中", async () => {
  const developerConfig: BotConfig = { ...baseBotConfig, id: "developer" };
  const host = await createHost(
    [baseBotConfig, developerConfig],
    "connected",
    {},
    false,
    false,
    { sendMention: true }, // @ 派发消息发送失败
  );
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

  // 派发失败：run 仍创建、子任务标记为 failed，且 currentDispatchId 已清空。
  await waitFor(() =>
    host.calls.replies.some((text) => text.includes("已创建 run-001")),
  );
  const sub = host.root.orchestration.list()[0].subTasks[0];
  assert.equal(sub.status, "failed", "派发失败子任务标记为 failed");
  assert.equal(
    sub.currentDispatchId,
    undefined,
    "发送失败必须清空 currentDispatchId，避免迟到结果命中",
  );
  assert.ok(
    host.calls.replies.some((text) => text.includes("派发失败")),
    "汇总文本应包含派发失败说明",
  );

  // 伪造一个迟到结果：currentDispatchId 已清空，任何交接单号都不匹配，被忽略。
  await host.root.parallel("task/result", {
    bot: host.bot,
    botConfig: developerConfig,
    session: fakeSession(),
    requestedPrompt: "分析模块 A",
    answer: "迟到结果",
    replyToMessageId: "m1",
    hasThread: false,
    collaboration: subTaskCollaboration(host, "run-001", "t1", "developer"),
  });
  assert.equal(
    host.root.orchestration.list()[0].subTasks[0].status,
    "failed",
    "派发失败后迟到结果不能把子任务改为完成",
  );
});

test("跨进程重启后旧 run 的重试令牌不能命中新 run（bad_token，不派发）", async () => {
  const developerConfig: BotConfig = { ...baseBotConfig, id: "developer" };
  // 第一个“进程”：创建 run-001 并让子任务失败，取面板里的旧重试令牌。
  const oldHost = await createHost(
    [baseBotConfig, developerConfig],
    "connected",
    { maxRetry: 2 },
    false,
    true,
  );
  oldHost.lark.runtimes.set("developer", {
    config: developerConfig,
    bot: oldHost.bot,
    identity: { openId: "developer_open", name: "Developer" },
  });
  const { panel: oldPanel } = await runFailedSubTaskPanel(oldHost);
  const oldToken = String(retrySubtaskValueOf(oldPanel).retryToken);

  // 第二个“进程”：新 OrchestrationService，展示编号重新从 run-001 开始。
  const newHost = await createHost(
    [baseBotConfig, developerConfig],
    "connected",
    { maxRetry: 2 },
    false,
    true,
  );
  newHost.lark.runtimes.set("developer", {
    config: developerConfig,
    bot: newHost.bot,
    identity: { openId: "developer_open", name: "Developer" },
  });
  await runFailedSubTaskPanel(newHost);
  const newRun = newHost.root.orchestration.list()[0];
  assert.equal(newRun.runId, "run-001", "新进程展示编号重新从 run-001 开始");
  assert.notEqual(
    newRun.instanceId,
    oldHost.root.orchestration.list()[0].instanceId,
    "跨重启 run 实例标识必须不同",
  );

  // 用旧进程的令牌请求新进程的 run：instanceId 不匹配 → bad_token，且不派发。
  const result = await newHost.root.orchestration.retrySubTask(
    "run-001",
    "t1",
    "ou_owner",
    oldToken,
  );
  assert.equal(result.ok, false, "旧令牌必须被拒绝");
  assert.equal(result.reason, "bad_token", "旧令牌不能命中新 run");
  assert.equal(newHost.calls.sentToChat.length, 1, "旧令牌不能触发新派发");
  assert.equal(
    newHost.root.orchestration.list()[0].subTasks[0].status,
    "failed",
    "旧令牌不能复位子任务状态",
  );
});

test("拆解结果包含重复子任务 ID：不创建 run、不派发任何消息（host 层整轮拒绝）", async () => {
  const host = await createHost();
  await host.root.parallel(
    "bot/message",
    incomingMessage({ text: "/orchestrate 检查模块 A 和模块 B" }),
    host.bot,
    baseBotConfig,
  );
  await waitFor(() => host.cli.captured !== undefined);

  // 拆解返回重复 ID：parseSubTaskSpecs 在 createRun 之前抛错，整轮拒绝。
  host.cli.finish({
    answer: JSON.stringify({
      tasks: [
        { id: "t1", prompt: "分析模块 A", bot: "testbot" },
        { id: "t1", prompt: "分析模块 B", bot: "testbot" },
      ],
    }),
  });

  await waitFor(() =>
    host.calls.replies.some((text) => text.includes("重复子任务 ID")),
  );
  assert.ok(
    host.calls.replies.some((text) => text.includes("拆解失败")),
    "重复 ID 应给出可操作的重新描述提示",
  );
  assert.equal(
    host.root.orchestration.list().length,
    0,
    "重复 ID 不能创建 run",
  );
  assert.equal(host.calls.sentToChat.length, 0, "重复 ID 不能有任何独立话题派发");
  assert.equal(host.calls.mentions.length, 0, "重复 ID 不能有任何 @ 派发");
});

test("live-panel 首次挂卡片失败：/orchestrate 仍发送“已创建 run”汇总（可选面板不阻断）", async () => {
  const developerConfig: BotConfig = { ...baseBotConfig, id: "developer" };
  const host = await createHost(
    [baseBotConfig, developerConfig],
    "connected",
    {},
    true, // 装配 live-panel
    false,
    { replyCard: true }, // 首次 replyCard 抛错
  );
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

  await waitFor(() =>
    host.calls.replies.some((text) => text.includes("已创建 run-001")),
  );
  assert.equal(
    host.calls.cards.length,
    0,
    "首次挂卡失败不能挂起任何面板卡片",
  );
  assert.equal(
    host.root.orchestration.list().length,
    1,
    "run 仍被创建：面板失败不影响编排主链路",
  );
});

test("live-panel 卡片更新失败：子任务仍保持 done 真实状态，不触发额外 task/failed", async () => {
  const developerConfig: BotConfig = { ...baseBotConfig, id: "developer" };
  const productConfig: BotConfig = { ...baseBotConfig, id: "product" };
  const host = await createHost(
    [baseBotConfig, developerConfig, productConfig],
    "connected",
    {},
    true, // 装配 live-panel
    false,
    { updateCard: true }, // updateCard 抛错
  );
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

  await host.root.parallel(
    "bot/message",
    incomingMessage({ text: "/orchestrate 检查模块 A 和模块 B" }),
    host.bot,
    baseBotConfig,
  );
  await waitFor(() => host.cli.captured !== undefined);
  host.cli.finish({
    answer: JSON.stringify({
      tasks: [
        { id: "t1", prompt: "分析模块 A", bot: "developer" },
        { id: "t2", prompt: "分析模块 B", bot: "product" },
      ],
    }),
  });
  await waitFor(() => host.calls.sentToChat.length >= 2);
  await waitFor(() => host.calls.cards.length >= 1); // 首挂成功，面板卡片已挂起

  // t1 完成走中间节流刷新（updateCard 抛错被节流器吞掉），t2 完成走终态 finish
  // （updateCard 抛错被 live-panel 错误边界吞掉）：两个子任务都必须保持 done。
  await emitSubTaskResult(host, "run-001", "t1", "developer", "A 完成");
  await emitSubTaskResult(host, "run-001", "t2", "product", "B 完成");

  const run = host.root.orchestration.list()[0];
  assert.deepEqual(
    run.subTasks.map((sub) => sub.status),
    ["done", "done"],
    "卡片更新失败不能改变子任务真实状态",
  );
  assert.ok(
    run.subTasks.every((sub) => sub.finishedAt !== undefined),
    "子任务完成时间已写入",
  );
  assert.ok(
    run.subTasks.every((sub) => !sub.error),
    "卡片更新失败不能把成功子任务写成失败",
  );
});

test("重试派发经真实 bot/message 路由再次执行，重放同一消息只执行一次", async () => {
  const developerConfig: BotConfig = { ...baseBotConfig, id: "developer" };
  const host = await createHost(
    [baseBotConfig, developerConfig],
    "connected",
    { maxRetry: 2 },
    false,
    true,
  );
  host.lark.runtimes.set("developer", {
    config: developerConfig,
    bot: host.bot,
    identity: { openId: "developer_open", name: "Developer" },
  });

  const { panel } = await runFailedSubTaskPanel(host);
  const value = retrySubtaskValueOf(panel);

  // 点击重试：新交接单派发（sentToChat 第 2 条）。
  const ok = await host.root.serial(
    "bot/card-action",
    { operatorOpenId: "ou_owner", messageId: "m1", value },
    host.bot,
    baseBotConfig,
  );
  assert.equal(ok?.toast?.content, "已重新派发，正在等待成员执行。");
  await waitFor(() => host.calls.sentToChat.length >= 2);
  const retried = host.calls.sentToChat[1];
  const retriedDispatchId = retried.text.match(/任务编号：([a-f0-9]{12})/)?.[1];
  assert.ok(retriedDispatchId, "重试派发必须携带新交接单号");
  const capturesBefore = host.cli.captures.length;

  // 把重试派发消息送入目标 bot 的真实 bot/message 路由：第二次启动任务。
  await host.root.parallel(
    "bot/message",
    incomingMessage({
      messageId: "m-retry",
      senderType: "bot",
      senderOpenId: "bot_open",
      messageType: "post",
      text: retried.text,
      mentions: [{ key: "@_user_1", name: "Developer", openId: "developer_open" }],
    }),
    host.bot,
    developerConfig,
  );
  await waitFor(() => host.cli.captures.length === capturesBefore + 1);
  assert.ok(
    host.cli.captures[capturesBefore]?.prompt.includes("分析模块 A"),
    "重试派发经真实路由第二次启动任务",
  );

  // 第二次执行完成：真实 task/result 链路（携带新交接单）驱动 run 进入 done。
  host.cli.finish({ answer: "重试完成", sessionId: "sess-2" });
  await waitFor(() => {
    const sub = host.root.orchestration.list()[0]?.subTasks[0];
    return sub?.status === "done";
  });

  // 重放同一条重试消息：交接单已被领取消费，必须被忽略，不再次执行。
  await host.root.parallel(
    "bot/message",
    incomingMessage({
      messageId: "m-retry-replay",
      senderType: "bot",
      senderOpenId: "bot_open",
      messageType: "post",
      text: retried.text,
      mentions: [{ key: "@_user_1", name: "Developer", openId: "developer_open" }],
    }),
    host.bot,
    developerConfig,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    host.cli.captures.length,
    capturesBefore + 1,
    "重放同一消息不能再次启动任务",
  );
});
