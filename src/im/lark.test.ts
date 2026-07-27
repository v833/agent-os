/**
 * 飞书适配器纯函数测试：不连接开放平台，只验证双层 JSON 文本解析、
 * 响应头兼容和下载文件扩展名选择规则。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { extractText, getHeader, resourceExtension } from "./lark.js";

test("提取 text 消息正文", () => {
  assert.equal(extractText("text", JSON.stringify({ text: "你好" })), "你好");
});

test("提取 post 消息中的纯文本并忽略 at 和图片", () => {
  const content = JSON.stringify({
    content: [
      [
        { tag: "at", user_id: "ou_xxx" },
        { tag: "text", text: " 你好，" },
      ],
      [
        { tag: "img", image_key: "img_xxx" },
        { tag: "text", text: "在吗？ " },
      ],
    ],
  });

  assert.equal(extractText("post", content), "你好，在吗？");
});

test("非文本消息返回空字符串", () => {
  assert.equal(extractText("image", JSON.stringify({ image_key: "img_xxx" })), "");
});

test("读取不同形式的 Content-Type 响应头", () => {
  assert.equal(getHeader(new Headers({ "content-type": "image/png" }), "content-type"), "image/png");
  assert.equal(getHeader({ "content-type": ["image/jpeg"] }, "content-type"), "image/jpeg");
});

test("文件优先保留原扩展名，图片按响应格式确定扩展名", () => {
  assert.equal(resourceExtension("file", "report.XLSX", "application/octet-stream"), "xlsx");
  assert.equal(resourceExtension("image", undefined, "image/jpeg; charset=binary"), "jpg");
  assert.equal(resourceExtension("image", undefined, "image/webp"), "webp");
  assert.equal(resourceExtension("image", undefined, "application/octet-stream"), "img");
  assert.equal(resourceExtension("file", "无扩展名", "application/octet-stream"), "bin");
});
