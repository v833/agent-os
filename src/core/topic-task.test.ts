/**
 * 话题任务编号测试：验证同话题稳定复用、跨群或跨话题严格隔离。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { topicIdOf, topicTaskId } from "./topic-task.js";

test("同一群聊话题里的不同消息映射为同一个任务", () => {
  const first = {
    messageId: "om_first",
    chatId: "oc_chat",
    threadId: "omt_topic",
    rootId: "om_root",
  };
  const followUp = { ...first, messageId: "om_follow_up" };

  assert.equal(topicIdOf(first), "omt_topic");
  assert.equal(topicTaskId(first), topicTaskId(followUp));
  assert.equal(topicTaskId(first).length, 24);
});

test("不同话题或群聊得到不同任务编号", () => {
  const base = {
    messageId: "om_first",
    chatId: "oc_chat",
    threadId: "omt_topic",
    rootId: "",
  };
  assert.notEqual(
    topicTaskId(base),
    topicTaskId({ ...base, threadId: "omt_other" }),
  );
  assert.notEqual(
    topicTaskId(base),
    topicTaskId({ ...base, chatId: "oc_other" }),
  );
});
