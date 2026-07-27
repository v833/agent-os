import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskCard, ThrottledCardUpdater } from "./card.js";

test("构建可共享更新的运行中卡片", () => {
  const card = buildTaskCard({
    title: "模拟任务",
    status: "running",
    progress: 35.4,
    detail: "分析相关文件",
    activities: ["读取项目结构", "定位任务入口"],
  }) as any;

  assert.equal(card.schema, "2.0");
  assert.equal(card.config.update_multi, true);
  assert.equal(card.config.summary.content, "模拟任务：运行中");
  assert.equal(card.header.template, "blue");
  assert.match(card.body.elements[0].content, /进度：.*35%/);
  assert.match(card.body.elements[0].content, /- 读取项目结构/);
  assert.equal(card.body.elements[1].disabled, true);
  assert.equal(card.body.elements[1].text.content, "任务执行中");
});

test("卡片状态和进度边界正确渲染", () => {
  const success = buildTaskCard({
    title: "任务",
    status: "success",
    progress: 140,
    detail: "完成",
  }) as any;
  const failed = buildTaskCard({
    title: "任务",
    status: "failed",
    progress: -10,
    detail: "失败",
  }) as any;

  assert.equal(success.header.template, "green");
  assert.match(success.body.elements[0].content, /100%/);
  assert.equal(success.body.elements[1].text.content, "已完成");
  assert.equal(failed.header.template, "red");
  assert.match(failed.body.elements[0].content, /0%/);
  assert.equal(failed.body.elements[1].text.content, "执行失败");
});

test("节流器在窗口内只提交最新卡片，并串行收尾", async () => {
  const updates: number[] = [];
  const updater = new ThrottledCardUpdater(
    async (card) => {
      updates.push((card as { version: number }).version);
      await new Promise((resolve) => setTimeout(resolve, 2));
    },
    10,
  );

  updater.push({ version: 1 });
  updater.push({ version: 2 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await updater.finish({ version: 3 });

  assert.deepEqual(updates, [2, 3]);
  assert.throws(() => updater.push({ version: 4 }), /已经结束/);
});

test("finish 会丢弃尚未提交的中间状态", async () => {
  const updates: number[] = [];
  const updater = new ThrottledCardUpdater(async (card) => {
    updates.push((card as { version: number }).version);
  }, 50);

  updater.push({ version: 1 });
  await updater.finish({ version: 9 });

  assert.deepEqual(updates, [9]);
});
