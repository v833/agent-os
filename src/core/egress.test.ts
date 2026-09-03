/**
 * Egress 回传核心单测：GitHub 评论幂等更新、Webhook 重试、QA Markdown 渲染。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GitHubCommentClient,
  buildEgressPayload,
  isTaggedComment,
  postEgressWebhook,
  qaResultToMarkdown,
  tagComment,
} from "./egress.js";
import type { QAResult } from "./qa-result.js";

const API_BASE = "https://api.github.com";

function fetchStub(responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return (async (url: string, init?: RequestInit) =>
    responder(url, (init ?? {}) as RequestInit)) as unknown as typeof fetch;
}

describe("tagComment / isTaggedComment", () => {
  it("正文附带稳定 tag 并可按 tag 识别", () => {
    const tagged = tagComment("报告内容", "github:x/y/pull/1");
    assert.equal(isTaggedComment(tagged, "github:x/y/pull/1"), true);
    assert.equal(isTaggedComment("普通评论", "github:x/y/pull/1"), false);
  });
});

describe("GitHubCommentClient", () => {
  const ref = { owner: "v833", repo: "threadpilot", number: 123 };
  const tag = "github:v833/threadpilot/pull/123";
  const body = "**QA 通过**";

  it("无既有评论时新建", async () => {
    const calls: string[] = [];
    const fetchImpl = fetchStub(async (url, init) => {
      calls.push(`${init.method} ${url}`);
      if (init.method === "GET") {
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ id: 100 }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new GitHubCommentClient({ token: "t", apiBase: API_BASE, fetchImpl });
    const result = await client.postOrUpdateComment(ref, body, tag);
    assert.equal(result.id, 100);
    assert.equal(result.updated, false);
    assert.ok(calls.some((call) => call.startsWith("POST https://api.github.com/repos/v833/threadpilot/issues/123/comments")));
  });

  it("存在同 tag 评论时就地 PATCH 而非重复新建", async () => {
    const calls: string[] = [];
    const existingBody = tagComment("旧报告", `threadpilot:${tag}`);
    const fetchImpl = fetchStub(async (url, init) => {
      calls.push(`${init.method} ${url}`);
      if (init.method === "GET") {
        return new Response(JSON.stringify([{ id: 55, body: existingBody }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ id: 55 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new GitHubCommentClient({ token: "t", apiBase: API_BASE, fetchImpl });
    const result = await client.postOrUpdateComment(ref, body, tag);
    assert.equal(result.id, 55);
    assert.equal(result.updated, true);
    assert.ok(calls.some((call) => call.startsWith("PATCH https://api.github.com/repos/v833/threadpilot/issues/comments/55")));
    assert.ok(!calls.some((call) => call.startsWith("POST")));
  });

  it("API 失败时抛错", async () => {
    const fetchImpl = fetchStub(async () => new Response("rate limited", { status: 403 }));
    const client = new GitHubCommentClient({ token: "t", apiBase: API_BASE, fetchImpl });
    await assert.rejects(() => client.postOrUpdateComment(ref, body, tag), /403/);
  });
});

describe("postEgressWebhook", () => {
  it("首次投递成功即返回", async () => {
    const fetchImpl = fetchStub(async () => new Response("ok", { status: 200 }));
    const result = await postEgressWebhook({ url: "https://hook.example/x", fetchImpl }, { status: "Started" });
    assert.equal(result.delivered, true);
    assert.equal(result.attempts, 1);
  });

  it("失败后按退避表重试并最终放弃", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    let failures = 3;
    const fetchImpl = fetchStub(async () => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("network down");
      }
      return new Response("ok", { status: 200 });
    });
    // 缩短退避等待，加速测试。
    globalThis.setTimeout = ((fn: TimerHandler, _ms: number, ...rest: unknown[]) =>
      originalSetTimeout(fn, 0, ...rest)) as typeof setTimeout;
    try {
      const result = await postEgressWebhook({ url: "https://hook.example/x", fetchImpl, maxRetries: 3 }, { status: "Failed" });
      assert.equal(result.delivered, true);
      assert.equal(result.attempts, 4);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it("非 2xx 响应也按退避表重试并最终成功", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    let failures = 2;
    const fetchImpl = fetchStub(async () => {
      if (failures > 0) {
        failures -= 1;
        return new Response("server error", { status: 500 });
      }
      return new Response("ok", { status: 200 });
    });
    // 缩短退避等待，加速测试。
    globalThis.setTimeout = ((fn: TimerHandler, _ms: number, ...rest: unknown[]) =>
      originalSetTimeout(fn, 0, ...rest)) as typeof setTimeout;
    try {
      const result = await postEgressWebhook({ url: "https://hook.example/x", fetchImpl, maxRetries: 3 }, { status: "Failed" });
      assert.equal(result.delivered, true);
      assert.equal(result.attempts, 3);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it("始终非 2xx 响应最终放弃", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const fetchImpl = fetchStub(async () => new Response("server error", { status: 500 }));
    // 缩短退避等待，加速测试。
    globalThis.setTimeout = ((fn: TimerHandler, _ms: number, ...rest: unknown[]) =>
      originalSetTimeout(fn, 0, ...rest)) as typeof setTimeout;
    try {
      const result = await postEgressWebhook({ url: "https://hook.example/x", fetchImpl, maxRetries: 2 }, { status: "Failed" });
      assert.equal(result.delivered, false);
      assert.equal(result.attempts, 3);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it("非 2xx 重试等待按指数退避序列增长", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    // 记录每次 sleep 的延时值（不真正等待）。
    globalThis.setTimeout = ((fn: TimerHandler, ms: number, ...rest: unknown[]) => {
      delays.push(ms);
      return originalSetTimeout(fn, 0, ...rest);
    }) as typeof setTimeout;
    const fetchImpl = fetchStub(async () => new Response("server error", { status: 500 }));
    try {
      const result = await postEgressWebhook({ url: "https://hook.example/x", fetchImpl, maxRetries: 5 }, { status: "Failed" });
      assert.equal(result.delivered, false);
      assert.equal(result.attempts, 6);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
    // 指数退避：base×2^n → 1000 / 2000 / 4000 / 8000 / 16000（5 次重试后达上限返回）。
    assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 16_000]);
  });
});

describe("qaResultToMarkdown / buildEgressPayload", () => {
  const qa: QAResult = {
    verdict: "pass",
    revision: "abc123",
    tests: [
      { command: "pnpm build", status: "passed", exitCode: 0 },
      { command: "pnpm test", status: "passed", exitCode: 0 },
    ],
    findings: [],
    nextAction: "close",
  };

  it("渲染 QA 通过 Markdown", () => {
    const markdown = qaResultToMarkdown(qa);
    assert.match(markdown, /QA 通过/);
    assert.match(markdown, /abc123/);
    assert.match(markdown, /pnpm build/);
  });

  it("失败 verdict 渲染 findings 区块", () => {
    const failed: QAResult = {
      verdict: "changes_requested",
      revision: "def456",
      tests: [{ command: "pnpm test", status: "failed", exitCode: 1 }],
      findings: [
        {
          id: "F1",
          severity: "P1",
          location: "src/core/ingress.ts:20",
          reproduction: "POST /webhook",
          expected: "200",
          actual: "500",
          recommendation: "修复异常处理",
        },
      ],
      nextAction: "return_to_developer",
    };
    const markdown = qaResultToMarkdown(failed);
    assert.match(markdown, /需要修改/);
    assert.match(markdown, /\[P1\] F1/);
  });

  it("buildEgressPayload 组装统一载荷", () => {
    const payload = buildEgressPayload(
      "QA_Passed",
      { entityId: "v833/threadpilot/pull/123", title: "PR", detailUrl: "https://x" },
      "结论",
    );
    assert.equal(payload.status, "QA_Passed");
    assert.equal(payload.entityId, "v833/threadpilot/pull/123");
    assert.equal(payload.detail, "结论");
  });
});
