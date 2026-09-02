/** 提及与富媒体解析测试：覆盖占位符还原和三种资源承载形式。 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  extractResourceKeys,
  leadingMentionName,
  parseMentions,
  resolveMentions,
} from "./message-parser.js";

test("解析提及信息", () => {
  assert.deepEqual(
    parseMentions([
      { key: "@_user_1", name: "MyBot", id: { open_id: "ou_bot" } },
      { key: "@_user_2", name: "运营专家", id: { open_id: "ou_user" } },
    ]),
    [
      { key: "@_user_1", name: "MyBot", openId: "ou_bot" },
      { key: "@_user_2", name: "运营专家", openId: "ou_user" },
    ],
  );
  assert.deepEqual(parseMentions(undefined), []);
});

test("还原所有重复出现的提及占位符", () => {
  assert.equal(
    resolveMentions("  @_user_1 看看 @_user_2，@_user_1 也确认一下  ", [
      { key: "@_user_1", name: "MyBot", openId: "ou_bot" },
      { key: "@_user_2", name: "运营专家", openId: "ou_user" },
    ]),
    "@MyBot 看看 @运营专家，@MyBot 也确认一下",
  );
});

test("从飞书原始占位符识别带空格的前导提及名称", () => {
  const mentions = [
    { key: "@_user_1", name: "ThreadPilot", openId: "ou_bot" },
    { key: "@_user_2", name: "开发同学", openId: "ou_user" },
  ];

  assert.equal(
    leadingMentionName("@_user_1 /claude 检查项目", mentions),
    "ThreadPilot",
  );
  assert.equal(
    leadingMentionName("请 @_user_1 检查项目", mentions),
    undefined,
  );
});

test("提取图片和文件消息的资源", () => {
  assert.deepEqual(
    extractResourceKeys("image", JSON.stringify({ image_key: "img_v3_xxx" })),
    [{ type: "image", key: "img_v3_xxx" }],
  );
  assert.deepEqual(
    extractResourceKeys(
      "file",
      JSON.stringify({ file_key: "file_v3_xxx", file_name: "report.xlsx" }),
    ),
    [{ type: "file", key: "file_v3_xxx", fileName: "report.xlsx" }],
  );
});

test("提取 post 消息内嵌的全部图片", () => {
  const content = JSON.stringify({
    content: [
      [{ tag: "text", text: "截图如下" }, { tag: "img", image_key: "img_1" }],
      [{ tag: "img", image_key: "img_2" }],
    ],
  });

  assert.deepEqual(extractResourceKeys("post", content), [
    { type: "image", key: "img_1" },
    { type: "image", key: "img_2" },
  ]);
});
