/**
 * 测试调度器自检：验证参数边界、静态 manifest 与逻辑分片不会漏掉测试。
 * 这些测试由调度器自身发现，用来守住并行提速后的结果完整性。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  distributeTestNames,
  parseArguments,
  testNamesFromSource,
} from "./test-runner.mjs";

test("参数解析按范围选择保守的默认并发数", () => {
  assert.deepEqual(parseArguments([], 20), {
    scope: "all",
    serial: false,
    workers: 6,
  });
  assert.deepEqual(parseArguments(["--scope", "cli"], 20), {
    scope: "cli",
    serial: false,
    workers: 3,
  });
  assert.deepEqual(parseArguments(["--workers", "2"], 20), {
    scope: "all",
    serial: false,
    workers: 2,
  });
});

test("参数解析拒绝未知范围和非法并发数", () => {
  assert.throws(() => parseArguments(["--scope", "unknown"]), /未知测试范围/);
  assert.throws(() => parseArguments(["--workers", "0"]), /必须是正整数/);
  assert.throws(() => parseArguments(["--unknown"]), /未知测试参数/);
});

test("静态 manifest 统计顶层及 describe 内的 test/it", () => {
  const source = `
    test("顶层", () => {});
    test.skip("跳过", () => {});
    describe("分组", () => {
      it("嵌套", () => {});
      it.todo("待办");
    });
  `;
  assert.deepEqual(testNamesFromSource(source), ["顶层", "跳过", "嵌套", "待办"]);
  assert.deepEqual(testNamesFromSource(source, "test.ts", true), ["顶层", "跳过"]);
});

test("逻辑分片完整且每个测试只分配一次", () => {
  const names = ["a", "b", "c", "d", "e", "f", "g"];
  const shards = distributeTestNames(names, 3);
  assert.deepEqual(shards, [
    ["a", "d", "g"],
    ["b", "e"],
    ["c", "f"],
  ]);
  assert.deepEqual(shards.flat().toSorted(), names);
});
