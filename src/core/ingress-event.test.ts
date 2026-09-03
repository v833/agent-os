/**
 * IngressEvent 契约与来源规范化单测：GitHub / Sentry / 通用 payload。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildIngressEvent,
  normalizeGithubPayload,
  normalizeSentryPayload,
} from "./ingress-event.js";

describe("normalizeGithubPayload", () => {
  it("解析 pull_request.opened", () => {
    const payload = {
      action: "opened",
      pull_request: {
        number: 123,
        title: "feat: ingress webhook",
        html_url: "https://github.com/v833/threadpilot/pull/123",
        draft: false,
      },
      repository: {
        full_name: "v833/threadpilot",
        html_url: "https://github.com/v833/threadpilot",
      },
    };
    const normalized = normalizeGithubPayload(payload, {
      "x-github-delivery": "delivery-abc",
    });
    assert.equal(normalized.eventId, "delivery-abc");
    assert.equal(normalized.eventType, "pull_request.opened");
    assert.equal(normalized.entityId, "v833/threadpilot/pull/123");
    assert.equal(normalized.title, "feat: ingress webhook");
    assert.equal(normalized.metadata.repo, "v833/threadpilot");
  });

  it("解析普通 Issue 评论归一到 issues 实体", () => {
    const payload = {
      action: "created",
      issue: { number: 7, title: "Bug" },
      comment: { body: "请补充测试用例", html_url: "https://github.com/a/b/issues/7#issuecomment-1" },
      repository: { full_name: "a/b" },
    };
    const normalized = normalizeGithubPayload(payload, {});
    assert.equal(normalized.eventType, "issue_comment.created");
    assert.equal(normalized.entityId, "a/b/issues/7");
    assert.equal(normalized.metadata.isPullRequest, false);
  });

  it("解析 PR 评论（issue 含 pull_request）归一到 pull 实体", () => {
    const payload = {
      action: "created",
      issue: { number: 7, title: "feat: x", pull_request: {} },
      comment: { body: "LGTM", html_url: "https://github.com/a/b/pull/7#issuecomment-2" },
      repository: { full_name: "a/b" },
    };
    const normalized = normalizeGithubPayload(payload, {});
    assert.equal(normalized.eventType, "issue_comment.created");
    assert.equal(normalized.entityId, "a/b/pull/7");
    assert.equal(normalized.metadata.isPullRequest, true);
  });

  it("解析 inline review 评论为评论事件而非 pull_request.*", () => {
    // pull_request_review_comment 事件顶层同时带 pull_request 与 comment；
    // comment 分支必须先于 pull_request，否则被误归一化为 pull_request.created。
    const payload = {
      action: "created",
      pull_request: { number: 9, title: "feat: y" },
      comment: { body: "inline LGTM", html_url: "https://github.com/a/b/pull/9#discussion-r1" },
      repository: { full_name: "a/b" },
    };
    const normalized = normalizeGithubPayload(payload, {});
    assert.equal(normalized.eventType, "issue_comment.created");
    assert.equal(normalized.entityId, "a/b/pull/9");
    assert.equal(normalized.metadata.isPullRequest, true);
  });

  it("解析 workflow_run 事件", () => {
    const payload = {
      action: "completed",
      workflow_run: { id: 42, display_title: "CI", html_url: "https://github.com/a/b/actions/runs/42" },
      repository: { full_name: "a/b" },
    };
    const normalized = normalizeGithubPayload(payload, {});
    assert.equal(normalized.eventType, "workflow_run.completed");
    assert.equal(normalized.entityId, "a/b/runs/42");
  });

  it("未知对象抛错", () => {
    assert.throws(() => normalizeGithubPayload({}, {}));
  });
});

describe("normalizeSentryPayload", () => {
  it("解析 alert 结构并提取堆栈元数据", () => {
    const payload = {
      id: "alert-1",
      event: {
        issue: { id: "issue-99", title: "TypeError: x is undefined", permalink: "https://sentry.io/o/1/issues/99" },
        error: { type: "TypeError", value: "x is undefined" },
        stacktrace: "at line 10",
      },
    };
    const normalized = normalizeSentryPayload(payload);
    assert.equal(normalized.eventId, "alert-1");
    assert.equal(normalized.eventType, "alert.triggered");
    assert.equal(normalized.entityId, "sentry/issue-99");
    assert.equal(normalized.title, "TypeError: x is undefined");
    assert.equal(normalized.metadata.errorType, "TypeError");
  });

  it("解析 issue 解决（action=resolved）产出 alert.resolved", () => {
    const payload = {
      id: "alert-2",
      action: "resolved",
      data: {
        issue: {
          id: "issue-88",
          title: "TypeError: boom",
          status: "resolved",
          permalink: "https://sentry.io/o/1/issues/88",
        },
      },
    };
    const normalized = normalizeSentryPayload(payload);
    assert.equal(normalized.eventType, "alert.resolved");
    assert.equal(normalized.entityId, "sentry/issue-88");
    assert.equal(normalized.metadata.status, "resolved");
    assert.equal(normalized.metadata.action, "resolved");
  });

  it("兼容 Integration data.issue/data.event 触发结构", () => {
    const payload = {
      id: "alert-3",
      action: "triggered",
      data: {
        event: { error: { type: "TypeError", value: "boom" }, stacktrace: "at line 3" },
        issue: { id: "issue-77", title: "TypeError", permalink: "https://sentry.io/o/1/issues/77" },
      },
    };
    const normalized = normalizeSentryPayload(payload);
    assert.equal(normalized.eventType, "alert.triggered");
    assert.equal(normalized.entityId, "sentry/issue-77");
    assert.equal(normalized.metadata.errorType, "TypeError");
  });
});

describe("buildIngressEvent", () => {
  it("组装完整事件（含 receivedAt）", () => {
    const event = buildIngressEvent(
      "github",
      {
        action: "opened",
        pull_request: { number: 5, title: "PR", html_url: "https://github.com/a/b/pull/5" },
        repository: { full_name: "a/b" },
      },
      { "x-github-delivery": "d1" },
      "2026-09-03T00:00:00Z",
    );
    assert.equal(event.source, "github");
    assert.equal(event.entityId, "a/b/pull/5");
    assert.equal(event.receivedAt, "2026-09-03T00:00:00Z");
    assert.ok(event.rawPayload);
  });
});
