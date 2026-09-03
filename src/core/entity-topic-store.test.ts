/**
 * 实体→话题映射存储单测：upsert/get、findByThread 反查、close 与落盘恢复。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EntityTopicSchema,
  JsonEntityTopicStore,
  entityKeyOf,
  type EntityTopic,
} from "./entity-topic-store.js";

const base: EntityTopic = {
  entityKey: "github:v833/threadpilot/pull/123",
  source: "github",
  entityId: "v833/threadpilot/pull/123",
  chatId: "oc_1",
  rootMessageId: "msg-root",
  threadId: "msg-root",
  status: "open",
  firstEventAt: "2026-09-03T00:00:00Z",
  lastEventAt: "2026-09-03T00:00:00Z",
  eventCount: 1,
  lastSummary: "PR #123",
};

describe("EntityTopicStore", () => {
  it("upsert/get 往返", () => {
    const store = new JsonEntityTopicStore(join(tmpdir(), "t1.json"));
    store.upsert(base);
    assert.equal(store.get(base.entityKey)?.rootMessageId, "msg-root");
  });

  it("findByThread 按 chatId+rootMessageId 反查", () => {
    const store = new JsonEntityTopicStore(join(tmpdir(), "t2.json"));
    store.upsert(base);
    const found = store.findByThread("oc_1", "msg-root");
    assert.equal(found?.entityKey, base.entityKey);
    assert.equal(store.findByThread("oc_2", "msg-root"), undefined);
  });

  it("close 后仍可查但不在 open 列表", () => {
    const store = new JsonEntityTopicStore(join(tmpdir(), "t3.json"));
    store.upsert(base);
    store.close(base.entityKey);
    assert.equal(store.listOpen().length, 0);
    assert.equal(store.get(base.entityKey)?.status, "closed");
  });

  it("落盘后重新加载恢复映射", () => {
    const dir = mkdtempSync(join(tmpdir(), "entity-topic-"));
    const path = join(dir, "topics.json");
    const store = new JsonEntityTopicStore(path);
    store.upsert(base);
    store.close(base.entityKey);

    const reloaded = new JsonEntityTopicStore(path);
    const topic = reloaded.get(base.entityKey);
    assert.equal(topic?.status, "closed");
    assert.equal(topic?.eventCount, 1);

    const raw = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(Array.isArray(raw), true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("坏记录在加载时被过滤", () => {
    const dir = mkdtempSync(join(tmpdir(), "entity-topic-bad-"));
    const path = join(dir, "topics.json");
    writeFileSync(
      path,
      JSON.stringify([
        { ...base, entityKey: 123 },
        base,
      ]),
      "utf8",
    );
    const store = new JsonEntityTopicStore(path);
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0]!.entityKey, base.entityKey);
    rmSync(dir, { recursive: true, force: true });
  });

  it("entityKeyOf 拼接稳定键", () => {
    assert.equal(entityKeyOf("github", "a/b/pull/1"), "github:a/b/pull/1");
  });

  it("EntityTopicSchema 校验必填字段", () => {
    assert.throws(() => EntityTopicSchema.parse({ ...base, entityKey: "" }));
  });
});
