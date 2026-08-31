/**
 * /board 命令插件单元与集成测试：覆盖 /board help、/board link、
 * /board status 以及 /board init 的全自动建表、热挂载与冲突保护。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Context, Service } from "cordis";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { apply as applyBoardCommand } from "./board.js";
import { BitableBoardService } from "../bitable-board.js";
import { CardsService } from "../cards.js";
import type { BotConfig } from "../../core/bot-registry.js";
import type { Session } from "../../core/session-manager.js";
import type { CardJson } from "../../im/card.js";
import type { Bot, CardAction, IncomingMessage } from "../../im/lark.js";
import type { CommandHandler } from "../types.js";

class MockCommandsService extends Service {
  readonly handlers = new Map<string, CommandHandler>();

  constructor(ctx: Context) {
    super(ctx, "commands");
  }

  register(name: string, handler: CommandHandler): void {
    this.handlers.set(name, handler);
  }

  get(name: string): CommandHandler | undefined {
    return this.handlers.get(name);
  }
}

class MockConfigService extends Service {
  teamLeaderId = "developer";
  constructor(ctx: Context) {
    super(ctx, "config");
  }
  bot(id: string) {
    return { id, defaultCliId: "codex" } as BotConfig;
  }
}

class MockLarkService extends Service {
  constructor(ctx: Context, private readonly botInstance: Bot) {
    super(ctx, "lark");
  }
  bot(_id: string) {
    return {
      config: { id: "developer" } as BotConfig,
      bot: this.botInstance,
    };
  }
}

function setupTestEnvironment(options: {
  createAppSuccess?: boolean;
  createFieldSuccess?: boolean;
  scanFails?: boolean;
  scanPermissionDenied?: boolean;
  storagePath?: string;
} = {}) {
  const root = new Context();
  const commands = new MockCommandsService(root);
  new CardsService(root);
  new MockConfigService(root);

  const bitableBoard = new BitableBoardService(root, {
    sync: true,
    pull: false,
    storagePath: options.storagePath ?? join(tmpdir(), `agent-os-board-command-${randomUUID()}.json`),
  });

  const replies: string[] = [];
  const repliedCards: CardJson[] = [];
  const updatedCards: Array<{ messageId: string; card: CardJson }> = [];

  const mockClient = {
    bitable: {
      v1: {
        app: {
          create: async (payload: { data?: { name?: string } }) => {
            if (options.createAppSuccess === false) {
              return { code: 99991663, msg: "403 Forbidden: bitable:app 权限未开通" };
            }
            return {
              code: 0,
              data: {
                app: {
                  app_token: "bascnTestCmdToken",
                  default_table_id: "tblTestCmdTable",
                  url: "https://feishu.cn/base/bascnTestCmdToken",
                },
              },
            };
          },
        },
        appTableField: {
          list: async () => ({
            code: 0,
            data: { items: [], has_more: false },
          }),
          create: async (_payload: unknown) => {
            if (options.createFieldSuccess === false) {
              return { code: 1254000, msg: "字段创建失败" };
            }
            return {
              code: 0,
              data: { field: { field_id: "fld_test" } },
            };
          },
          update: async () => ({ code: 0, data: { field: { field_id: "fld_test" } } }),
        },
        appTableView: {
          create: async () => ({
            code: 0,
            data: { view: { view_id: "vew_kanban" } },
          }),
        },
        appTableRecord: {
          list: async () => {
            if (options.scanPermissionDenied) {
              return { code: 99991663, msg: "403 Forbidden: bitable:app 权限未开通" };
            }
            if (options.scanFails) {
              throw new Error("1254001 app not found");
            }
            return { code: 0, data: { items: [], has_more: false } };
          },
          create: async () => ({ code: 0, data: { record: { record_id: "rec_1" } } }),
          update: async () => ({ code: 0, data: {} }),
        },
      },
    },
  };

  const botInstance: Bot = {
    client: mockClient as never,
    reply: async (_messageId: string, text: string) => {
      replies.push(text);
      return `msg-reply-${replies.length}`;
    },
    replyCard: async (_messageId: string, card: CardJson) => {
      repliedCards.push(card);
      return `msg-card-${repliedCards.length}`;
    },
    updateCard: async (messageId: string, card: CardJson) => {
      updatedCards.push({ messageId, card });
    },
    send: async () => "msg-send",
  } as unknown as Bot;

  new MockLarkService(root, botInstance);

  applyBoardCommand(root);

  const botConfig: BotConfig = {
    id: "developer",
    appId: "app_1",
    appSecret: "sec_1",
    defaultCliId: "codex",
    accessMode: "headless",
    workspaceDir: "/workspace",
    role: "开发",
    skills: [],
    systemPrompt: "sys",
    collaborationMaxRounds: 16,
  };

  const session: Session = {
    id: "sess-1",
    botId: "developer",
    chatId: "oc_group_1",
    threadId: "th_1",
    workspaceDir: "/workspace",
    cliId: "codex",
    accessMode: "headless",
    status: "idle",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const message: IncomingMessage = {
    messageId: "om_req_1",
    chatId: "oc_group_1",
    threadId: "th_1",
    rootId: "",
    chatType: "group",
    messageType: "text",
    text: "/board",
    rawContent: "",
    senderType: "user",
    senderOpenId: "ou_user_1",
    mentions: [],
  };

  return {
    root,
    commands,
    bitableBoard,
    replies,
    repliedCards,
    updatedCards,
    botInstance,
    botConfig,
    session,
    message,
    handler: commands.get("board")!,
  };
}

test("/board 或 /board help 输出使用帮助", async () => {
  const { handler, botConfig, session, message, botInstance, root, replies } =
    setupTestEnvironment();
  assert.ok(handler);

  await handler({
    ctx: root,
    bot: botInstance,
    botConfig,
    message,
    session,
    isNew: false,
    hasThread: true,
    taskId: "board-test-task",
    resolvedText: "/board",
    command: { name: "board", args: "" },
    cliAdapter: { id: "codex", displayName: "Codex" } as never,
  });

  assert.equal(replies.length, 1);
  assert.ok(replies[0].includes("命令指南"));
  assert.ok(replies[0].includes("/board init"));
  assert.ok(replies[0].includes("/board link"));
});

test("/board link 未挂载时提示去初始化，挂载后返回看板元信息", async () => {
  const { handler, botConfig, session, message, botInstance, root, bitableBoard, replies } =
    setupTestEnvironment();

  // 1. 未挂载时
  await handler({
    ctx: root,
    bot: botInstance,
    botConfig,
    message,
    session,
    isNew: false,
    hasThread: true,
    taskId: "board-test-task",
    resolvedText: "/board link",
    command: { name: "board", args: "link" },
    cliAdapter: { id: "codex", displayName: "Codex" } as never,
  });

  assert.equal(replies.length, 1);
  assert.ok(replies[0].includes("尚未挂载"));

  // 2. 模拟手动挂载后
  await bitableBoard.mount({
    appToken: "bascnLinked",
    tableId: "tblLinked",
    url: "https://feishu.cn/base/bascnLinked",
    name: "研发进度表",
    saveToStorage: false,
  });

  await handler({
    ctx: root,
    bot: botInstance,
    botConfig,
    message,
    session,
    isNew: false,
    hasThread: true,
    taskId: "board-test-task",
    resolvedText: "/board link",
    command: { name: "board", args: "link" },
    cliAdapter: { id: "codex", displayName: "Codex" } as never,
  });

  assert.equal(replies.length, 2);
  assert.ok(replies[1].includes("研发进度表"));
  assert.ok(replies[1].includes("https://feishu.cn/base/bascnLinked"));
  assert.ok(replies[1].includes("tblLinked"));
});

test("/board status 详细展示服务状态大盘", async () => {
  const { handler, botConfig, session, message, botInstance, root, replies } =
    setupTestEnvironment();

  await handler({
    ctx: root,
    bot: botInstance,
    botConfig,
    message,
    session,
    isNew: false,
    hasThread: true,
    taskId: "board-test-task",
    resolvedText: "/board status",
    command: { name: "board", args: "status" },
    cliAdapter: { id: "codex", displayName: "Codex" } as never,
  });

  assert.equal(replies.length, 1);
  assert.ok(replies[0].includes("飞书任务看板运行状态"));
  assert.ok(replies[0].includes("未挂载"));
  assert.ok(replies[0].includes("已关联任务数"));
});

test("/board init 执行全自动建表、更新就绪卡片并就地热挂载", async () => {
  const {
    handler,
    botConfig,
    session,
    message,
    botInstance,
    root,
    bitableBoard,
    repliedCards,
    updatedCards,
  } = setupTestEnvironment();

  await handler({
    ctx: root,
    bot: botInstance,
    botConfig,
    message,
    session,
    isNew: false,
    hasThread: true,
    taskId: "board-test-task",
    resolvedText: "/board init 敏捷开发大盘",
    command: { name: "board", args: "init 敏捷开发大盘" },
    cliAdapter: { id: "codex", displayName: "Codex" } as never,
  });

  // 发送了初始进度卡片，且最终更新了就绪卡片
  assert.equal(repliedCards.length, 1);
  const initialHeader = repliedCards[0].header as { template: string };
  assert.equal(initialHeader.template, "blue");

  assert.equal(updatedCards.length, 1);
  const updatedHeader = updatedCards[0].card.header as { template: string; title: { content: string } };
  assert.equal(updatedHeader.template, "green");
  assert.ok(updatedHeader.title.content.includes("已就绪"));

  // 服务已热挂载
  assert.equal(bitableBoard.isMounted(), true);
  const storage = bitableBoard.getStorage();
  assert.equal(storage?.appToken, "bascnTestCmdToken");
  assert.equal(storage?.tableId, "tblTestCmdTable");
  assert.equal(storage?.name, "敏捷开发大盘");
});

test("/board init 在已有看板时提示冲突，携带 --force 允许覆盖", async () => {
  const {
    handler,
    botConfig,
    session,
    message,
    botInstance,
    root,
    bitableBoard,
    repliedCards,
  } = setupTestEnvironment();

  // 预先挂载一个看板
  await bitableBoard.mount({
    appToken: "bascnOld",
    tableId: "tblOld",
    name: "旧看板",
    saveToStorage: false,
  });

  // 不带 --force 触发 init
  await handler({
    ctx: root,
    bot: botInstance,
    botConfig,
    message,
    session,
    isNew: false,
    hasThread: true,
    taskId: "board-test-task",
    resolvedText: "/board init 新看板",
    command: { name: "board", args: "init 新看板" },
    cliAdapter: { id: "codex", displayName: "Codex" } as never,
  });

  assert.equal(repliedCards.length, 1);
  const conflictHeader = repliedCards[0].header as { template: string };
  assert.equal(conflictHeader.template, "orange");

  // 携带 --force 覆盖
  await handler({
    ctx: root,
    bot: botInstance,
    botConfig,
    message,
    session,
    isNew: false,
    hasThread: true,
    taskId: "board-test-task",
    resolvedText: "/board init --force 强制覆盖看板",
    command: { name: "board", args: "init --force 强制覆盖看板" },
    cliAdapter: { id: "codex", displayName: "Codex" } as never,
  });

  // 成功热挂载新看板
  assert.equal(bitableBoard.getStorage()?.name, "强制覆盖看板");
});

test("/board init 遇到 403 权限错误时更新错误卡片与权限引导", async () => {
  const {
    handler,
    botConfig,
    session,
    message,
    botInstance,
    root,
    updatedCards,
  } = setupTestEnvironment({ createAppSuccess: false });

  await handler({
    ctx: root,
    bot: botInstance,
    botConfig,
    message,
    session,
    isNew: false,
    hasThread: true,
    taskId: "board-test-task",
    resolvedText: "/board init",
    command: { name: "board", args: "init" },
    cliAdapter: { id: "codex", displayName: "Codex" } as never,
  });

  assert.equal(updatedCards.length, 1);
  const errorHeader = updatedCards[0].card.header as { template: string };
  assert.equal(errorHeader.template, "red");
  const body = updatedCards[0].card.body as { elements: Array<{ tag: string; content?: string }> };
  assert.ok(body.elements[0].content?.includes("bitable:app"));
});

test("/board init 建表成功但首次扫描 403 时拒绝挂载并展示权限错误卡", async () => {
  const {
    handler,
    botConfig,
    session,
    message,
    botInstance,
    root,
    updatedCards,
    bitableBoard,
  } = setupTestEnvironment({ scanPermissionDenied: true });

  await handler({
    ctx: root,
    bot: botInstance,
    botConfig,
    message,
    session,
    isNew: false,
    hasThread: true,
    taskId: "board-test-task",
    resolvedText: "/board init",
    command: { name: "board", args: "init" },
    cliAdapter: { id: "codex", displayName: "Codex" } as never,
  });

  const updated = updatedCards[updatedCards.length - 1];
  assert.ok(updated, "应更新进度卡为权限错误卡");
  const header = updated.card.header as { template: string };
  assert.equal(header.template, "red", "权限错误不得展示为橙色降级卡");
  const content = JSON.stringify(updated.card);
  assert.ok(content.includes("bitable:app"), "错误卡应包含权限开通指引");
  assert.ok(content.includes("bascnTestCmdToken"), "应提示已成功创建的 App Token");
  assert.ok(!content.includes("board_retry_init"), "孤立 App 不得提供一键重试");
  assert.equal(bitableBoard.isMounted(), false, "首次扫描权限失败时不得提交挂载");
  bitableBoard.stop();
});

test("看板卡片动作支持查看状态与覆盖二次确认", async () => {
  const {
    bitableBoard,
    botInstance,
    botConfig,
    root,
  } = setupTestEnvironment();
  await bitableBoard.mount({
    appToken: "bascnExisting",
    tableId: "tblExisting",
    name: "已有看板",
    saveToStorage: false,
  });

  const action = (value: Record<string, unknown>): CardAction => ({
    operatorOpenId: "ou_user_1",
    messageId: "card-board",
    value,
  });
  const status = await root.serial(
    "bot/card-action",
    action({ action: "board_status" }),
    botInstance,
    botConfig,
  );
  assert.equal(status?.card?.type, "raw");
  assert.match(JSON.stringify(status?.card?.data), /已有看板/);

  const confirm = await root.serial(
    "bot/card-action",
    action({ action: "board_force_init_confirm" }),
    botInstance,
    botConfig,
  );
  assert.equal(confirm?.toast?.type, "warning");
  assert.match(JSON.stringify(confirm?.card?.data), /确认覆盖并创建/);
});

test("/board init 并发请求只允许一个初始化流程进入 OpenAPI", async () => {
  const {
    handler,
    botConfig,
    session,
    message,
    botInstance,
    root,
    replies,
    repliedCards,
    updatedCards,
  } = setupTestEnvironment();
  const input = {
    ctx: root,
    bot: botInstance,
    botConfig,
    message,
    session,
    isNew: false,
    hasThread: true,
    taskId: "board-test-task",
    resolvedText: "/board init",
    command: { name: "board", args: "init" },
    cliAdapter: { id: "codex", displayName: "Codex" } as never,
  } as Parameters<typeof handler>[0];

  await Promise.all([handler(input), handler(input)]);
  assert.equal(repliedCards.length, 1, "只有一个请求应发送初始化进度卡");
  assert.equal(updatedCards.length, 1, "只有一个请求应完成初始化卡片更新");
  assert.equal(
    replies.some((reply) => reply.includes("已有任务看板正在初始化")),
    true,
  );
});

test("/board init 绑定初始化群作为反向拉起回退群聊", async () => {
  const { handler, botConfig, session, message, botInstance, root, bitableBoard } =
    setupTestEnvironment();

  await handler({
    ctx: root,
    bot: botInstance,
    botConfig,
    message,
    session,
    isNew: false,
    hasThread: true,
    taskId: "board-test-task",
    resolvedText: "/board init 绑定群聊看板",
    command: { name: "board", args: "init 绑定群聊看板" },
    cliAdapter: { id: "codex", displayName: "Codex" } as never,
  });

  // 群聊ID必须持久化，零配置记录（未填群聊ID）也能反向拉起。
  assert.equal(bitableBoard.getStorage()?.fallbackChatId, "oc_group_1");
});

test("冲突卡片携带用户请求的新看板名称", async () => {
  const { handler, botConfig, session, message, botInstance, root, bitableBoard, repliedCards } =
    setupTestEnvironment();

  await bitableBoard.mount({
    appToken: "bascnOld",
    tableId: "tblOld",
    name: "旧看板",
    saveToStorage: false,
  });

  await handler({
    ctx: root,
    bot: botInstance,
    botConfig,
    message,
    session,
    isNew: false,
    hasThread: true,
    taskId: "board-test-task",
    resolvedText: "/board init 研发大盘",
    command: { name: "board", args: "init 研发大盘" },
    cliAdapter: { id: "codex", displayName: "Codex" } as never,
  });

  assert.equal(repliedCards.length, 1);
  const conflictJson = JSON.stringify(repliedCards[0]);
  // 新名称出现在提示里，且确认按钮 value 携带的是用户请求的新名称。
  assert.ok(conflictJson.includes("研发大盘"), "冲突卡应展示用户请求的新名称");
  const elements = (
    repliedCards[0].body as {
      elements: Array<{
        tag: string;
        behaviors?: Array<{ value: Record<string, unknown> }>;
      }>;
    }
  ).elements;
  const confirmButton = elements.find(
    (element) =>
      element.tag === "button" &&
      (element.behaviors?.[0]?.value as { action?: string } | undefined)
        ?.action === "board_force_init_confirm",
  );
  const forceValue = confirmButton?.behaviors?.[0]?.value;
  assert.equal(forceValue?.name, "研发大盘", "确认覆盖应使用用户请求的新名称");
  assert.equal(forceValue?.appToken, "bascnOld", "应携带当前看板 appToken 供版本校验");
});

test("旧冲突卡在挂载切换后不得覆盖新看板", async () => {
  const { root, botInstance, botConfig } = setupTestEnvironment();
  const bitableBoard = root.bitableBoard as BitableBoardService;

  await bitableBoard.mount({
    appToken: "bascnV1",
    tableId: "tblV1",
    name: "V1 看板",
    saveToStorage: false,
  });

  const action = (value: Record<string, unknown>): CardAction => ({
    operatorOpenId: "ou_user_1",
    messageId: "card-board",
    value,
  });

  // 卡片携带旧 appToken，但当前已切换到新看板：必须拒绝，不得覆盖。
  await bitableBoard.mount({
    appToken: "bascnV2",
    tableId: "tblV2",
    name: "V2 看板",
    saveToStorage: false,
  });
  const stale = await root.serial(
    "bot/card-action",
    action({ action: "board_force_init", name: "V2 看板", appToken: "bascnV1" }),
    botInstance,
    botConfig,
  );
  assert.equal(stale?.toast?.type, "error", "旧卡片应被拒绝");

  // 携带当前 appToken 的卡片才允许覆盖。
  const fresh = await root.serial(
    "bot/card-action",
    action({ action: "board_force_init", name: "新看板", appToken: "bascnV2" }),
    botInstance,
    botConfig,
  );
  assert.equal(fresh?.toast?.type, "success");
});

test("/board init 首次扫描失败时展示降级卡片而非就绪卡片", async () => {
  const { handler, botConfig, session, message, botInstance, root, repliedCards, updatedCards, bitableBoard } =
    setupTestEnvironment({ scanFails: true });

  await handler({
    ctx: root,
    bot: botInstance,
    botConfig,
    message,
    session,
    isNew: false,
    hasThread: true,
    taskId: "board-test-task",
    resolvedText: "/board init",
    command: { name: "board", args: "init" },
    cliAdapter: { id: "codex", displayName: "Codex" } as never,
  });

  // 进度卡（蓝色）被更新为降级卡（橙色），而不是绿色就绪卡。
  const updated = updatedCards[updatedCards.length - 1];
  assert.ok(updated, "应更新进度卡为降级卡");
  const updatedHeader = updated.card.header as { template: string; title: { content: string } };
  assert.equal(updatedHeader.template, "orange");
  assert.ok(updatedHeader.title.content.includes("同步暂未就绪"));
  assert.equal(repliedCards.length, 1);

  // 清理降级重试定时器，避免残留句柄拖住测试进程。
  bitableBoard.stop();
});

test("旧错误卡重试不得绕过活跃看板冲突保护", async () => {
  const { root, botInstance, botConfig, bitableBoard } = setupTestEnvironment();
  await bitableBoard.mount({
    appToken: "bascnB",
    tableId: "tblB",
    name: "B 看板",
    saveToStorage: false,
  });
  const action = (value: Record<string, unknown>): CardAction => ({
    operatorOpenId: "ou_user_1",
    messageId: "card-board",
    value,
  });

  // 已挂载 B 后，点击无版本令牌的旧错误卡“重试”：必须拒绝。
  const stale = await root.serial(
    "bot/card-action",
    action({ action: "board_retry_init", name: "A 看板", appToken: "" }),
    botInstance,
    botConfig,
  );
  assert.equal(stale?.toast?.type, "error", "无令牌的旧错误卡不得覆盖新看板");

  // 携带不匹配令牌的旧错误卡同样拒绝。
  const mismatch = await root.serial(
    "bot/card-action",
    action({ action: "board_retry_init", name: "A 看板", appToken: "bascnA" }),
    botInstance,
    botConfig,
  );
  assert.equal(mismatch?.toast?.type, "error", "令牌不匹配的旧错误卡不得覆盖新看板");
  bitableBoard.stop();
});

test("未挂载时旧错误卡重试允许重新初始化", async () => {
  const { root, botInstance, botConfig } = setupTestEnvironment();
  const action = (value: Record<string, unknown>): CardAction => ({
    operatorOpenId: "ou_user_1",
    messageId: "card-board",
    value,
  });
  const retried = await root.serial(
    "bot/card-action",
    action({ action: "board_retry_init", name: "重试看板", appToken: "" }),
    botInstance,
    botConfig,
  );
  assert.equal(retried?.toast?.type, "success", "未挂载时应允许重试");
  (root.bitableBoard as BitableBoardService).stop();
});

test("建表成功但挂载失败时错误卡附带已创建的 App Token 且无重试按钮", async () => {
  // storagePath 指向已存在的目录：saveBoardStorage 的 rename 会失败，模拟挂载失败。
  const dir = mkdtempSync(join(tmpdir(), "agent-os-board-storage-"));
  try {
    const { handler, botConfig, session, message, botInstance, root, updatedCards, bitableBoard } =
      setupTestEnvironment({ storagePath: dir });

    await handler({
      ctx: root,
      bot: botInstance,
      botConfig,
      message,
      session,
      isNew: false,
      hasThread: true,
      taskId: "board-test-task",
      resolvedText: "/board init",
      command: { name: "board", args: "init" },
      cliAdapter: { id: "codex", displayName: "Codex" } as never,
    });

    const updated = updatedCards[updatedCards.length - 1];
    assert.ok(updated, "应更新为错误卡");
    const updatedHeader = updated.card.header as { template: string };
    assert.equal(updatedHeader.template, "red");
    const content = JSON.stringify(updated.card);
    // 表格已创建：错误卡应提示 App Token（避免用户重复建表）。
    assert.ok(content.includes("bascnTestCmdToken"), "应提示已创建的 App Token");
    // 孤儿场景不应展示“重试”按钮，防止一键重复创建 Base。
    assert.ok(!content.includes("board_retry_init"), "孤儿场景不得提供重试按钮");
    assert.ok(content.includes("--force"), "应提示用 --force 覆盖重建");
    bitableBoard.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
