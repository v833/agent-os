/** 工作目录工具测试：验证相对路径、绝对路径和目录类型边界。 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ensureWorkspaceDirectory,
  resolveWorkspacePath,
} from "./workspace.js";

test("相对路径按基准目录解析，绝对路径保持绝对", () => {
  const baseDirectory = join(process.cwd(), "workspace-base");
  assert.equal(
    resolveWorkspacePath(" ../project ", baseDirectory),
    join(process.cwd(), "project"),
  );
  assert.equal(
    resolveWorkspacePath(baseDirectory, "ignored"),
    baseDirectory,
  );
});

test("空路径会被拒绝", () => {
  assert.throws(() => resolveWorkspacePath("  "), /工作目录不能为空/);
});

test("目录校验区分不存在路径、普通文件和真实目录", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "threadpilot-workspace-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "file.txt");
  const childDirectory = join(directory, "project");
  await writeFile(filePath, "content", "utf8");
  await mkdir(childDirectory);

  await ensureWorkspaceDirectory(childDirectory);
  await assert.rejects(
    ensureWorkspaceDirectory(join(directory, "missing")),
    /工作目录不存在/,
  );
  await assert.rejects(
    ensureWorkspaceDirectory(filePath),
    /工作目录不是文件夹/,
  );
});
