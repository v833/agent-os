/**
 * Ingress 规则路由引擎单测：glob 匹配、优先级与多规则命中。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  eventMatchesRule,
  matchIngressEvent,
  type IngressRouteRule,
} from "./ingress-route.js";
import type { IngressEvent } from "./ingress-event.js";

const event: IngressEvent = {
  eventId: "e1",
  source: "github",
  eventType: "pull_request.opened",
  entityId: "v833/threadpilot/pull/123",
  title: "PR #123",
  detailUrl: "https://github.com/v833/threadpilot/pull/123",
  metadata: { repo: "v833/threadpilot", severity: "error" },
  rawPayload: {},
  receivedAt: "2026-09-03T00:00:00Z",
};

function rule(overrides: Partial<IngressRouteRule>): IngressRouteRule {
  return { id: "r1", match: {}, chatId: "oc_1", mentionBots: [], ...overrides };
}

describe("eventMatchesRule", () => {
  it("空匹配条件命中一切事件", () => {
    assert.equal(eventMatchesRule(event, rule({})), true);
  });

  it("来源精确匹配", () => {
    assert.equal(
      eventMatchesRule(event, rule({ match: { source: "github" } })),
      true,
    );
    assert.equal(
      eventMatchesRule(event, rule({ match: { source: "sentry" } })),
      false,
    );
  });

  it("事件类型 glob 匹配", () => {
    assert.equal(
      eventMatchesRule(event, rule({ match: { eventType: "pull_request.*" } })),
      true,
    );
    assert.equal(
      eventMatchesRule(event, rule({ match: { eventType: "issues.*" } })),
      false,
    );
  });

  it("实体键 glob 匹配", () => {
    assert.equal(
      eventMatchesRule(event, rule({ match: { entity: "v833/*" } })),
      true,
    );
    assert.equal(
      eventMatchesRule(event, rule({ match: { entity: "other/*" } })),
      false,
    );
  });

  it("元数据等值匹配", () => {
    assert.equal(
      eventMatchesRule(
        event,
        rule({ match: { metadata: { severity: "error" } } }),
      ),
      true,
    );
  });

  it("禁用规则不命中", () => {
    assert.equal(eventMatchesRule(event, rule({ enabled: false })), false);
  });
});

describe("matchIngressEvent", () => {
  it("按 priority 降序取第一条命中", () => {
    const rules: IngressRouteRule[] = [
      rule({ id: "low", priority: 1, chatId: "oc_low" }),
      rule({ id: "high", priority: 10, chatId: "oc_high" }),
    ];
    const outcome = matchIngressEvent(event, rules);
    assert.equal(outcome?.rule.id, "high");
    assert.equal(outcome?.chatId, "oc_high");
  });

  it("无命中返回 undefined", () => {
    const outcome = matchIngressEvent(event, [
      rule({ match: { source: "sentry" } }),
    ]);
    assert.equal(outcome, undefined);
  });

  it("返回提及 bot 列表", () => {
    const outcome = matchIngressEvent(event, [
      rule({ mentionBots: ["developer", "qa"] }),
    ]);
    assert.deepEqual(outcome?.mentionBots, ["developer", "qa"]);
  });
});
