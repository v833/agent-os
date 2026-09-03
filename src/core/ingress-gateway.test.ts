/**
 * Ingress 网关端到端测试：真实 HTTP 服务 + 验签/防重放/规范化/派发全链路，
 * 覆盖 Sentry 端到端集成链路。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { startIngressGateway, type IngressGateway } from "./ingress-gateway.js";
import { signGithubRequest, signSentryRequest } from "./ingress-security.js";
import type { IngressEvent } from "./ingress-event.js";

const SECRET = "secret";

async function waitForListening(gateway: IngressGateway): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (gateway.port > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("网关未在超时时间内监听");
}

describe("Ingress 网关端到端", () => {
  it("Sentry Integration webhook（真实头名 + ISO 时间戳）全链路", async () => {
    const dispatched: IngressEvent[] = [];
    const gateway = startIngressGateway({
      auth: { sentry: { secret: SECRET } },
      port: 0,
      handleEvent: (event) => {
        dispatched.push(event);
      },
      now: Date.parse("2026-09-03T00:00:00Z"),
    });
    await waitForListening(gateway);

    const payload = {
      id: "alert-1",
      event: {
        issue: { id: "issue-99", title: "TypeError", permalink: "https://sentry.io/1/issues/99" },
        error: { type: "TypeError", value: "boom" },
      },
    };
    const rawBody = JSON.stringify(payload);
    const response = await fetch(`http://127.0.0.1:${gateway.port}/api/v1/ingress/webhook/sentry`, {
      method: "POST",
      headers: {
        "request-id": "req-1",
        "sentry-hook-timestamp": "2026-09-03T00:00:00Z",
        "sentry-hook-resource": "event_alert",
        "sentry-hook-signature": signSentryRequest(SECRET, rawBody),
        "content-type": "application/json",
      },
      body: rawBody,
    });
    const result = (await response.json()) as { ok: boolean; eventId: string };
    assert.equal(response.status, 200);
    assert.equal(result.ok, true);
    assert.equal(result.eventId, "alert-1");
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]!.source, "sentry");
    assert.equal(dispatched[0]!.entityId, "sentry/issue-99");
    gateway.close();
  });

  it("GitHub 签名错误返回 401", async () => {
    const gateway = startIngressGateway({
      auth: { github: { secret: SECRET } },
      port: 0,
      handleEvent: () => undefined,
    });
    await waitForListening(gateway);
    const rawBody = JSON.stringify({ pull_request: { number: 1 } });
    const timestamp = Math.floor(Date.now() / 1000);
    const response = await fetch(`http://127.0.0.1:${gateway.port}/api/v1/ingress/webhook/github`, {
      method: "POST",
      headers: {
        "x-github-delivery": "d1",
        "x-timestamp": String(timestamp),
        "x-hub-signature-256": signGithubRequest("wrong-secret", rawBody),
      },
      body: rawBody,
    });
    assert.equal(response.status, 401);
    gateway.close();
  });

  it("时间戳漂移超过 300 秒返回 403", async () => {
    const gateway = startIngressGateway({
      auth: { github: { secret: SECRET } },
      port: 0,
      handleEvent: () => undefined,
      now: Date.parse("2026-09-03T00:00:00Z"),
    });
    await waitForListening(gateway);
    const rawBody = JSON.stringify({ pull_request: { number: 1 } });
    // 漂移 301 秒。
    const timestamp = Math.floor(Date.parse("2026-09-03T00:00:00Z") / 1000) - 301;
    const response = await fetch(`http://127.0.0.1:${gateway.port}/api/v1/ingress/webhook/github`, {
      method: "POST",
      headers: {
        "x-github-delivery": "d2",
        "x-timestamp": String(timestamp),
        "x-hub-signature-256": signGithubRequest(SECRET, rawBody),
      },
      body: rawBody,
    });
    assert.equal(response.status, 403);
    gateway.close();
  });

  it("相同 Delivery ID 重复投递返回 403（防重放）", async () => {
    const gateway = startIngressGateway({
      auth: { github: { secret: SECRET } },
      port: 0,
      handleEvent: () => undefined,
      now: Date.parse("2026-09-03T00:00:00Z"),
    });
    await waitForListening(gateway);
    const rawBody = JSON.stringify({ pull_request: { number: 1 } });
    const timestamp = Math.floor(Date.parse("2026-09-03T00:00:00Z") / 1000);
    const headers = {
      "x-github-delivery": "d-replay",
      "x-timestamp": String(timestamp),
      "x-hub-signature-256": signGithubRequest(SECRET, rawBody),
    };
    const first = await fetch(`http://127.0.0.1:${gateway.port}/api/v1/ingress/webhook/github`, {
      method: "POST",
      headers,
      body: rawBody,
    });
    const second = await fetch(`http://127.0.0.1:${gateway.port}/api/v1/ingress/webhook/github`, {
      method: "POST",
      headers,
      body: rawBody,
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 403);
    gateway.close();
  });

  it("未注册来源返回 404", async () => {
    const gateway = startIngressGateway({
      auth: {},
      port: 0,
      handleEvent: () => undefined,
    });
    await waitForListening(gateway);
    const response = await fetch(`http://127.0.0.1:${gateway.port}/api/v1/ingress/webhook/gitlab`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(response.status, 404);
    gateway.close();
  });

  it("支持显式配置监听地址（host 可覆盖默认 0.0.0.0）", async () => {
    const gateway = startIngressGateway({
      auth: {},
      port: 0,
      host: "127.0.0.1",
      handleEvent: () => undefined,
    });
    await waitForListening(gateway);
    const response = await fetch(`http://127.0.0.1:${gateway.port}/health`);
    assert.equal(response.status, 200);
    gateway.close();
  });
});
