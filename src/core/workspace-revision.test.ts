/**
 * 工作区 revision 测试：用临时 Git 仓库验证 HEAD、已跟踪改动和未跟踪文件都会
 * 改变指纹，确保 QA 不会把变化中的工作树误认为固定版本。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { workspaceRevision } from "./workspace-revision.js";

const execFileAsync = promisify(execFile);

test("工作区 revision 覆盖 HEAD、已跟踪改动和未跟踪文件", async () => {
  const directory = await mkdtemp(join(tmpdir(), "threadpilot-revision-"));
  try {
    await execFileAsync("git", ["init", directory]);
    await execFileAsync("git", ["-C", directory, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", directory, "config", "user.name", "Test"]);
    await writeFile(join(directory, "tracked.txt"), "one", "utf8");
    await execFileAsync("git", ["-C", directory, "add", "tracked.txt"]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "init"]);

    const clean = await workspaceRevision(directory);
    assert.match(clean, /^git:[0-9a-f]{40}:[0-9a-f]{64}$/);

    await writeFile(join(directory, "tracked.txt"), "two", "utf8");
    const dirty = await workspaceRevision(directory);
    assert.notEqual(dirty, clean);

    await writeFile(join(directory, "untracked.txt"), "new", "utf8");
    const untracked = await workspaceRevision(directory);
    assert.notEqual(untracked, dirty);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
