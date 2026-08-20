/**
 * 工作区快照测试：验证 dirty Git 工作树被物化到独立 worktree，依赖目录可用于执行，
 * 清理快照后源工作区内容和 node_modules 保持不变。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createWorkspaceSnapshot } from "./workspace-snapshot.js";

const execFileAsync = promisify(execFile);

test("Git 工作区快照固定 dirty 内容并安全复用依赖目录", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-os-snapshot-source-"));
  try {
    await execFileAsync("git", ["init", directory]);
    await execFileAsync("git", ["-C", directory, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", directory, "config", "user.name", "Test"]);
    await writeFile(join(directory, "tracked.txt"), "one", "utf8");
    await writeFile(join(directory, ".gitignore"), "node_modules/\n", "utf8");
    await execFileAsync("git", ["-C", directory, "add", "tracked.txt", ".gitignore"]);
    await execFileAsync("git", ["-C", directory, "commit", "-m", "init"]);

    await writeFile(join(directory, "tracked.txt"), "two", "utf8");
    await writeFile(join(directory, "untracked.txt"), "new", "utf8");
    await mkdir(join(directory, "node_modules", ".bin"), { recursive: true });
    const dependencyMarker = join(directory, "node_modules", ".bin", "marker");
    await writeFile(dependencyMarker, "available", "utf8");

    const snapshot = await createWorkspaceSnapshot(directory);
    assert.notEqual(snapshot.workspaceDir, directory);
    assert.equal(await readFile(join(snapshot.workspaceDir, "tracked.txt"), "utf8"), "two");
    assert.equal(await readFile(join(snapshot.workspaceDir, "untracked.txt"), "utf8"), "new");
    assert.equal(
      await readFile(join(snapshot.workspaceDir, "node_modules", ".bin", "marker"), "utf8"),
      "available",
    );

    await snapshot.cleanup();
    assert.equal(await readFile(dependencyMarker, "utf8"), "available");
    assert.equal(await readFile(join(directory, "tracked.txt"), "utf8"), "two");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
