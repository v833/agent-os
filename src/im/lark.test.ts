import assert from "node:assert/strict";
import test from "node:test";
import { extractText } from "./lark.js";

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
