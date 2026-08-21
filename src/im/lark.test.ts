/**
 * 飞书适配器纯函数测试：不连接开放平台，只验证双层 JSON 文本解析、
 * 响应头兼容和下载文件扩展名选择规则。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChatMentionMessage,
  buildMentionPostContent,
  extractMessageText,
  fitFeishuText,
  getHeader,
  parseCardAction,
  resourceExtension,
} from "./lark.js";

test("构造带语言节点的真实 bot 提及 post", () => {
  assert.deepEqual(
    buildMentionPostContent(
      { openId: "ou_reviewer", name: "审查助手" },
      "请查看上方卡片",
    ),
    {
      zh_cn: {
        title: "",
        content: [
          [
            { tag: "at", user_id: "ou_reviewer", user_name: "审查助手" },
            { tag: "text", text: " 请查看上方卡片" },
          ],
        ],
      },
    },
  );
});

test("sendMentionToChat 构造向群发送新根消息的 @ post 请求", () => {
  const message = buildChatMentionMessage(
    "oc_chat",
    { openId: "ou_developer", name: "开发者" },
    "请分析模块 A",
  );
  assert.equal(message.params.receive_id_type, "chat_id");
  assert.equal(message.data.receive_id, "oc_chat");
  assert.equal(message.data.msg_type, "post");
  // 内容必须是 @ 目标 bot + 文本的 post 结构，供目标 bot 经 router 协作识别。
  assert.deepEqual(JSON.parse(message.data.content), {
    zh_cn: {
      title: "",
      content: [
        [
          { tag: "at", user_id: "ou_developer", user_name: "开发者" },
          { tag: "text", text: " 请分析模块 A" },
        ],
      ],
    },
  });
});

test("提取 text 消息正文", () => {
  assert.equal(
    extractMessageText("text", JSON.stringify({ text: "你好" })),
    "你好",
  );
});

test("提取 post 消息中的提及、链接、代码、Markdown 和换行", () => {
  const content = JSON.stringify({
    content: [
      [
        { tag: "at", user_id: "@_user_1" },
        { tag: "text", text: " 请检查 " },
        { tag: "a", text: "文档", href: "https://example.com" },
        { tag: "br" },
        { tag: "code", text: "pnpm build" },
      ],
      [
        { tag: "img", image_key: "img_xxx" },
        { tag: "code_block", text: "const answer = 42;" },
      ],
      [
        { tag: "md", text: "**完成**" },
      ],
    ],
  });

  assert.equal(
    extractMessageText("post", content),
    "@_user_1 请检查 文档\npnpm build\nconst answer = 42;\n**完成**",
  );
});

test("提取飞书语言节点包裹的 post 消息", () => {
  assert.equal(
    extractMessageText(
      "post",
      JSON.stringify({
        zh_cn: {
          title: "",
          content: [[{ tag: "text", text: "任务编号：abc123abc123" }]],
        },
      }),
    ),
    "任务编号：abc123abc123",
  );
});

test("非文本消息返回空字符串", () => {
  assert.equal(
    extractMessageText("image", JSON.stringify({ image_key: "img_xxx" })),
    "",
  );
});

test("读取不同形式的 Content-Type 响应头", () => {
  assert.equal(getHeader(new Headers({ "content-type": "image/png" }), "content-type"), "image/png");
  assert.equal(getHeader({ "content-type": ["image/jpeg"] }, "content-type"), "image/jpeg");
});

test("评论回复按飞书长度限制截断，零上限不返回内容", () => {
  assert.equal(fitFeishuText("  abc  ", 10), "abc");
  assert.equal(fitFeishuText("abcdef", 4), "abc…");
  assert.equal(fitFeishuText("abcdef", 0), "");
});

test("文件优先保留原扩展名，图片按响应格式确定扩展名", () => {
  assert.equal(resourceExtension("file", "report.XLSX", "application/octet-stream"), "xlsx");
  assert.equal(resourceExtension("image", undefined, "image/jpeg; charset=binary"), "jpg");
  assert.equal(resourceExtension("image", undefined, "image/webp"), "webp");
  assert.equal(resourceExtension("image", undefined, "application/octet-stream"), "img");
  assert.equal(resourceExtension("file", "无扩展名", "application/octet-stream"), "bin");
});

test("解析新版飞书卡片回调中的真实操作者、消息和按钮值", () => {
  assert.deepEqual(
    parseCardAction({
      operator: { open_id: "ou_owner" },
      context: { open_message_id: "om_card" },
      action: {
        form_value: { priority: "high" },
        value: {
          action: "abort_task",
          sessionId: "session-1",
          runId: "run-1",
        },
      },
    }),
    {
      operatorOpenId: "ou_owner",
      messageId: "om_card",
      formValue: { priority: "high" },
      value: {
        action: "abort_task",
        sessionId: "session-1",
        runId: "run-1",
      },
    },
  );
});

test("兼容旧版卡片回调字段并把非对象 value 收敛为空对象", () => {
  assert.deepEqual(
    parseCardAction({
      operator_id: { open_id: "ou_legacy" },
      open_message_id: "om_legacy",
      action: { value: "abort_task" },
    }),
    {
      operatorOpenId: "ou_legacy",
      messageId: "om_legacy",
      value: {},
    },
  );
});
