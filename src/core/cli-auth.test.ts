/**
 * CLI 认证契约测试：认证需求检测（通用模式 + 适配器声明优先）、
 * 登录 URL 提取与登录流程容器（同会话替换、查找与删除）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { CliAdapter } from "../cli/types.js";
import {
  AuthFlowStore,
  extractLoginUrl,
  isAuthRequiredError,
} from "./cli-auth.js";

const AUTH_ERROR =
  "Authentication required. Please visit the URL to log in:\n" +
  "  https://accounts.google.com/o/oauth2/auth?client_id=abc&state=xyz\n" +
  "Or, paste the authorization code here and press Enter:\n" +
  "Error: authentication timed out.";

test("isAuthRequiredError 命中通用认证模式", () => {
  assert.equal(isAuthRequiredError(AUTH_ERROR), true);
  assert.equal(isAuthRequiredError("authentication failed or timed out"), true);
  assert.equal(isAuthRequiredError("Please visit the URL to log in"), true);
  assert.equal(isAuthRequiredError("launch error: not authenticated"), true);
  // 与登录无关的内容不能误判。
  assert.equal(isAuthRequiredError("conversation not found"), false);
  assert.equal(isAuthRequiredError("命令执行失败：exit code 1"), false);
});

test("isAuthRequiredError 优先使用适配器声明的判定", () => {
  const adapter = {
    isAuthRequired: (message: string) => message.includes("专有登录提示"),
  } as CliAdapter;
  assert.equal(
    isAuthRequiredError("专有登录提示：请访问授权页", adapter),
    true,
  );
  assert.equal(isAuthRequiredError(AUTH_ERROR, adapter), false);
});

test("extractLoginUrl 提取错误文本中的第一个 URL", () => {
  assert.equal(
    extractLoginUrl(AUTH_ERROR),
    "https://accounts.google.com/o/oauth2/auth?client_id=abc&state=xyz",
  );
  assert.equal(extractLoginUrl("没有链接的普通错误"), undefined);
});

test("AuthFlowStore 同一会话后发流程替换旧流程", () => {
  const store = new AuthFlowStore();
  const options = {
    botId: "testbot",
    engineId: "agy" as const,
    engineDisplayName: "Antigravity",
    accessMode: "headless" as const,
    sessionId: "sess-1",
    ownerOpenId: "ou-user",
    originalMessageId: "om-1",
    replyInThread: false,
    workspaceDir: "C:\\proj",
    errorMessage: AUTH_ERROR,
  };
  const first = store.create(options);
  assert.equal(first.loginMode, "key");
  const device = store.create({ ...options, loginMode: "device" });
  assert.equal(device.loginMode, "device");
  const again = store.create(options);
  assert.notEqual(first.token, again.token);
  assert.equal(store.get(first.token), undefined);
  assert.equal(store.get(again.token)?.sessionId, "sess-1");
  assert.equal(store.get(again.token)?.loginMode, "key");
  assert.equal(store.findForSession("sess-1", "testbot")?.token, again.token);
  assert.equal(store.findForSession("sess-2", "testbot"), undefined);
  store.delete(again.token);
  assert.equal(store.findForSession("sess-1", "testbot"), undefined);
});