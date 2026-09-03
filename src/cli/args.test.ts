/**
 * threadpilot CLI 参数解析与版本比较测试。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions, parseCliArgs } from "./args.js";

test("parseCliArgs: 空参数默认启动服务", () => {
  assert.equal(parseCliArgs([]), "start");
});

test("parseCliArgs: --version / -v", () => {
  assert.equal(parseCliArgs(["--version"]), "version");
  assert.equal(parseCliArgs(["-v"]), "version");
});

test("parseCliArgs: --help / -h", () => {
  assert.equal(parseCliArgs(["--help"]), "help");
  assert.equal(parseCliArgs(["-h"]), "help");
});

test("parseCliArgs: update", () => {
  assert.equal(parseCliArgs(["update"]), "update");
});

test("parseCliArgs: 未知参数返回 invalid", () => {
  assert.equal(parseCliArgs(["foo"]), "invalid");
  assert.equal(parseCliArgs(["--unknown"]), "invalid");
  assert.equal(parseCliArgs(["update", "--force"]), "invalid");
});

test("compareVersions: 常规语义化版本", () => {
  assert.equal(compareVersions("0.1.0", "0.2.0"), -1);
  assert.equal(compareVersions("0.1.0", "0.1.0"), 0);
  assert.equal(compareVersions("1.0.0", "0.1.0"), 1);
});

test("compareVersions: 多位数字段", () => {
  assert.equal(compareVersions("0.9.9", "0.10.0"), -1);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
});

test("compareVersions: pre-release 小于正式版本", () => {
  assert.equal(compareVersions("0.1.0-beta", "0.1.0"), -1);
  assert.equal(compareVersions("0.1.0", "0.1.0-beta"), 1);
});

test("compareVersions: 字段数不同的版本", () => {
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.1", "1.0.9"), 1);
});
