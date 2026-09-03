/**
 * ingress 插件服务单测：路由派发 → 建话题/追加的端到端行为。
 * 覆盖 QA 缺陷回归：多 Bot 目标全部 @、首事件即关闭事件置 closed、
 * 同 entityKey 并发只建一个话题。
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "cordis";
import type { IngressEvent } from "../core/ingress-event.js";
import type { IngressRouteRule } from "../core/ingress-route.js";
import {
  JsonEntityTopicStore,
  entityKeyOf,
} from "../core/entity-topic-store.js";
import {
  IngressService,
  type IngressDispatchDeps,
} from "./ingress.js";
import type { BotRuntime } from "./types.js";
import type { Bot, BotIdentity } from "../im/lark.js";

const SENDER_ID = "sender";

interface BotCallLogs {
  mentioned: Array<{
    chatId: string;
    targets: BotIdentity | BotIdentity[];
    text: string;
  }>;
  sent: Array<{ chatId: string; text: string }>;
  replies: string[];
}

function identity(botId: string): BotIdentity {
  return { openId: `ou_${botId}`, name: botId };
}

function makeRuntime(
  calls: BotCallLogs,
  botId: string = SENDER_ID,
  firstDelayMs = 0,
): BotRuntime {
  const bot = {
    send: async (chatId: string, text: string) => {
      calls.sent.push({ chatId, text });
      return `sent-${calls.sent.length}`;
    },
    reply: async (messageId: string, text: string) => {
      calls.replies.push(text);
      return `reply-${calls.replies.length}`;
    },
    sendMentionToChat: async (
      chatId: string,
      targets: BotIdentity | BotIdentity[],
      text: string,
    ) => {
      if (firstDelayMs > 0 && calls.mentioned.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, firstDelayMs));
      }
      calls.mentioned.push({ chatId, targets, text });
      return `mention-${calls.mentioned.length}`;
    },
  } as unknown as Bot;
  return {
    config: { id: SENDER_ID } as never,
    bot,
    identity: identity(botId),
  };
}

function makeEvent(
  overrides: Partial<IngressEvent> & { eventType: string; entityId: string },
): IngressEvent {
  return {
    eventId: "delivery-1",
    source: "github",
    title: "事件",
    detailUrl: "https://example.com/x",
    metadata: {},
    rawPayload: {},
    receivedAt: "2026-09-03T00:00:00Z",
    ...overrides,
  };
}

/** 建临时落盘存储并注册目录清理。 */
function makeStore(): JsonEntityTopicStore {
  const dir = mkdtempSync(join(tmpdir(), "ingress-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return new JsonEntityTopicStore(join(dir, "topics.json"));
}

function makeService(
  store: JsonEntityTopicStore,
  rules: IngressRouteRule[],
  botOf: (botId: string) => BotRuntime | undefined,
): IngressService {
  return new IngressService(
    new Context(),
    store,
    rules,
    SENDER_ID,
    { botOf } as IngressDispatchDeps,
  );
}

describe("IngressService.dispatch 建话题", () => {
  it("多 Bot 目标时全部 @ 而非只通知首个", async () => {
    const calls = { mentioned: [], sent: [], replies: [] } as BotCallLogs;
    const store = makeStore();
    const service = makeService(
      store,
      [
        {
          id: "r1",
          chatId: "oc_chat",
          mentionBots: ["fe", "qa"],
          match: { eventType: "pull_request.*" },
        },
      ],
      (botId) => makeRuntime(calls, botId),
    );
    await service.dispatch(
      makeEvent({ eventType: "pull_request.opened", entityId: "a/b/pull/1" }),
    );

    assert.equal(calls.mentioned.length, 1);
    assert.deepEqual(calls.mentioned[0].targets, [
      identity("fe"),
      identity("qa"),
    ]);
    const topic = store.get(entityKeyOf("github", "a/b/pull/1"));
    assert.equal(topic?.status, "open");
  });

  it("无 @ 目标时退回纯文本发送", async () => {
    const calls = { mentioned: [], sent: [], replies: [] } as BotCallLogs;
    const store = makeStore();
    const service = makeService(
      store,
      [{ id: "r1", chatId: "oc_chat", match: { eventType: "pull_request.*" }, mentionBots: [] }],
      (botId) => makeRuntime(calls, botId),
    );
    await service.dispatch(
      makeEvent({ eventType: "pull_request.opened", entityId: "a/b/pull/2" }),
    );

    assert.equal(calls.sent.length, 1);
    assert.equal(calls.mentioned.length, 0);
  });

  it("首事件即关闭事件时话题状态置为 closed", async () => {
    const calls = { mentioned: [], sent: [], replies: [] } as BotCallLogs;
    const store = makeStore();
    const service = makeService(
      store,
      [{ id: "r1", chatId: "oc_chat", match: { eventType: "pull_request.*" }, mentionBots: [] }],
      (botId) => makeRuntime(calls, botId),
    );
    await service.dispatch(
      makeEvent({ eventType: "pull_request.closed", entityId: "a/b/pull/3" }),
    );

    const topic = store.get(entityKeyOf("github", "a/b/pull/3"));
    assert.equal(topic?.status, "closed");
  });

  it("sentry alert.resolved 首事件建 closed 话题", async () => {
    const calls = { mentioned: [], sent: [], replies: [] } as BotCallLogs;
    const store = makeStore();
    const service = makeService(
      store,
      [{ id: "r1", chatId: "oc_chat", match: { eventType: "alert.*" }, mentionBots: [] }],
      (botId) => makeRuntime(calls, botId),
    );
    await service.dispatch(
      makeEvent({
        source: "sentry",
        eventType: "alert.resolved",
        entityId: "sentry/issue-99",
      }),
    );

    const topic = store.get(entityKeyOf("sentry", "sentry/issue-99"));
    assert.equal(topic?.status, "closed");
  });

  it("同一 entityKey 并发只建一个话题", async () => {
    const calls = { mentioned: [], sent: [], replies: [] } as BotCallLogs;
    const store = makeStore();
    const service = makeService(
      store,
      [{ id: "r1", chatId: "oc_chat", match: { eventType: "pull_request.*" }, mentionBots: ["fe"] }],
      (botId) => makeRuntime(calls, botId, 30),
    );
    const event = makeEvent({
      eventType: "pull_request.opened",
      entityId: "a/b/pull/4",
    });
    // 并发两次同实体事件：锁应串行化，第一个建话题，第二个追加。
    await Promise.all([service.dispatch(event), service.dispatch(event)]);

    assert.equal(calls.mentioned.length, 1, "只应建一次话题");
    const topic = store.get(entityKeyOf("github", "a/b/pull/4"));
    assert.equal(topic?.eventCount, 2);
  });

  it("并发 closed 事件只建一个 closed 话题，重复关闭幂等", async () => {
    const calls = { mentioned: [], sent: [], replies: [] } as BotCallLogs;
    const store = makeStore();
    const service = makeService(
      store,
      [{ id: "r1", chatId: "oc_chat", match: { eventType: "pull_request.*" }, mentionBots: ["fe"] }],
      (botId) => makeRuntime(calls, botId, 30),
    );
    const event = makeEvent({
      eventType: "pull_request.closed",
      entityId: "a/b/pull/4",
    });
    // 并发两次关闭事件：第一个建 closed 话题，第二个是重复关闭，应幂等忽略。
    await Promise.all([service.dispatch(event), service.dispatch(event)]);

    assert.equal(calls.mentioned.length, 1, "只应建一次话题");
    const topic = store.get(entityKeyOf("github", "a/b/pull/4"));
    assert.equal(topic?.status, "closed");
    assert.equal(topic?.eventCount, 1);
  });

  it("closed 映射收到新活动时重新开话题", async () => {
    const calls = { mentioned: [], sent: [], replies: [] } as BotCallLogs;
    const store = makeStore();
    const service = makeService(
      store,
      [{ id: "r1", chatId: "oc_chat", match: { eventType: "pull_request.*" }, mentionBots: ["fe"] }],
      (botId) => makeRuntime(calls, botId),
    );
    await service.dispatch(
      makeEvent({ eventType: "pull_request.closed", entityId: "a/b/pull/6" }),
    );
    // 关闭后新 PR 活动（reopened 非关闭型）：重新建话题，状态 open。
    await service.dispatch(
      makeEvent({ eventType: "pull_request.reopened", entityId: "a/b/pull/6" }),
    );

    assert.equal(calls.mentioned.length, 2, "重开后应再次建话题");
    const topic = store.get(entityKeyOf("github", "a/b/pull/6"));
    assert.equal(topic?.status, "open");
    assert.equal(topic?.eventCount, 1);
  });

  it("未命中路由时不动存储", async () => {
    const calls = { mentioned: [], sent: [], replies: [] } as BotCallLogs;
    const store = makeStore();
    const service = makeService(
      store,
      [{ id: "r1", chatId: "oc_chat", match: { eventType: "sentry.*" }, mentionBots: [] }],
      (botId) => makeRuntime(calls, botId),
    );
    const rule = await service.dispatch(
      makeEvent({ eventType: "pull_request.opened", entityId: "a/b/pull/5" }),
    );
    assert.equal(rule, undefined);
    assert.equal(store.list().length, 0);
    assert.equal(calls.mentioned.length, 0);
  });
});
