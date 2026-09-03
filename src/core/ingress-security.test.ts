/**
 * ingress 安全层单测：HMAC 验签、时间戳漂移与 Nonce 防重放。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TIMESTAMP_DRIFT_SECONDS,
  signGithubRequest,
  signSentryRequest,
  verifyIngressRequest,
  verifyTimestamp,
} from "./ingress-security.js";

const SECRET = "test-secret";

describe("verifyTimestamp", () => {
  const now = Date.parse("2026-09-03T00:00:00Z");

  it("接受秒级时间戳且在漂移窗口内", () => {
    const seconds = now / 1000 - 60;
    assert.deepEqual(verifyTimestamp(seconds, now), { ok: true });
  });

  it("接受毫秒级时间戳", () => {
    const ms = now - 60_000;
    assert.deepEqual(verifyTimestamp(ms, now), { ok: true });
  });

  it("接受 ISO8601/HTTP-date 时间戳文本", () => {
    const iso = new Date(now).toISOString();
    assert.deepEqual(verifyTimestamp(iso, now), { ok: true });
    const httpDate = new Date(now).toUTCString();
    assert.deepEqual(verifyTimestamp(httpDate, now), { ok: true });
  });

  it("拒绝缺失时间戳", () => {
    assert.deepEqual(verifyTimestamp(undefined, now), {
      ok: false,
      failure: "timestamp-missing",
    });
  });

  it("拒绝超出 300 秒漂移", () => {
    const seconds = now / 1000 - (MAX_TIMESTAMP_DRIFT_SECONDS + 1);
    assert.deepEqual(verifyTimestamp(seconds, now), {
      ok: false,
      failure: "timestamp-drift",
    });
  });
});

describe("verifyIngressRequest", () => {
  const now = Date.parse("2026-09-03T00:00:00Z");
  const timestamp = Math.floor(now / 1000);
  const body = JSON.stringify({ pull_request: { number: 1 } });

  function githubHeaders(rawBody = body) {
    return {
      nonce: "delivery-001",
      timestamp,
      signature: signGithubRequest(SECRET, rawBody),
      secret: SECRET,
      rawBody,
      now,
    };
  }

  it("GitHub 签名正确时通过", () => {
    assert.equal(verifyIngressRequest("github", githubHeaders()).ok, true);
  });

  it("GitHub 签名错误时拒绝", () => {
    const result = verifyIngressRequest("github", {
      ...githubHeaders(),
      signature: signGithubRequest("wrong-secret", body),
    });
    assert.deepEqual(result, { ok: false, failure: "signature-mismatch" });
  });

  it("Sentry 裸 hex 签名正确时通过", () => {
    const result = verifyIngressRequest("sentry", {
      nonce: "sentry-001",
      timestamp,
      signature: signSentryRequest(SECRET, body),
      secret: SECRET,
      rawBody: body,
      now,
    });
    assert.equal(result.ok, true);
  });

  it("generic Bearer Token 正确时通过", () => {
    const result = verifyIngressRequest("generic", {
      nonce: "n-001",
      timestamp,
      signature: "Bearer expected-token",
      expectedToken: "expected-token",
      rawBody: body,
      now,
    });
    assert.equal(result.ok, true);
  });

  it("generic Token 错误时拒绝", () => {
    const result = verifyIngressRequest("generic", {
      nonce: "n-001",
      timestamp,
      signature: "Bearer wrong-token",
      expectedToken: "expected-token",
      rawBody: body,
      now,
    });
    assert.deepEqual(result, { ok: false, failure: "signature-mismatch" });
  });

  it("同一 Nonce 重复投递触发防重放", () => {
    const seen = new Set<string>();
    const headers = githubHeaders();
    assert.equal(verifyIngressRequest("github", headers, seen).ok, true);
    const replay = verifyIngressRequest("github", headers, seen);
    assert.deepEqual(replay, { ok: false, failure: "replay" });
  });

  it("Nonce 缺失或为空时拒绝，不落入防重放可放行状态", () => {
    const result = verifyIngressRequest("github", {
      ...githubHeaders(),
      nonce: "",
    });
    assert.deepEqual(result, { ok: false, failure: "nonce-missing" });
    const missing = verifyIngressRequest("github", {
      ...githubHeaders(),
      nonce: undefined as unknown as string,
    });
    assert.deepEqual(missing, { ok: false, failure: "nonce-missing" });
  });

  it("防重放存储超过上限时淘汰最旧 Nonce", () => {
    const seen = new Set<string>(["oldest"]);
    // 上限 2000，先填到 2000 个后，再加入新 Nonce 会触发淘汰 oldest。
    for (let i = 0; i < 1999; i++) seen.add(`nonce-${i}`);
    const headers = githubHeaders();
    assert.equal(verifyIngressRequest("github", headers, seen).ok, true);
    assert.equal(seen.has("oldest"), false);
  });
});
