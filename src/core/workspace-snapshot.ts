/**
 * 工作区快照：把 Developer 交付时的工作树物化成 QA 专用目录，
 * 供审查任务在固定版本上运行，避免 QA 与返工任务并发写入同一工作区。
 */
import { execFile } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { workspaceRevision } from "./workspace-revision.js";

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const IGNORED_SNAPSHOT_NAMES = new Set([".git", "node_modules", "dist"]);

function samePath(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
  });
  return result.stdout;
}

async function isGitWorkspace(workspaceDir: string): Promise<boolean> {
  try {
    const root = (
      await gitOutput(workspaceDir, ["rev-parse", "--show-toplevel"])
    ).trim();
    return samePath(root, workspaceDir);
  } catch {
    return false;
  }
}

function assertSafeRelativePath(root: string, path: string): string {
  const fullPath = resolve(root, path);
  const rel = relative(root, fullPath);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`工作区快照包含非法相对路径: ${path}`);
  }
  return fullPath;
}

async function copyUntrackedFiles(
  sourceDir: string,
  targetDir: string,
  paths: string[],
): Promise<void> {
  for (const path of paths) {
    const sourcePath = assertSafeRelativePath(sourceDir, path);
    const targetPath = assertSafeRelativePath(targetDir, path);
    await mkdir(dirname(targetPath), { recursive: true });
    await cp(sourcePath, targetPath, { recursive: true, dereference: false });
  }
}

async function copyTree(sourceDir: string, targetDir: string): Promise<void> {
  await cp(sourceDir, targetDir, {
    recursive: true,
    dereference: false,
    filter: (source) => !IGNORED_SNAPSHOT_NAMES.has(basename(source)),
  });
}

async function validateSnapshotLinks(
  root: string,
  current = root,
): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (IGNORED_SNAPSHOT_NAMES.has(entry.name)) continue;
    const fullPath = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      const target = resolve(dirname(fullPath), await readlink(fullPath));
      const rel = relative(root, target);
      if (rel === ".." || rel.startsWith(`..${sep}`)) {
        throw new Error(
          `工作区包含指向快照外部的符号链接: ${relative(root, fullPath)}`,
        );
      }
      continue;
    }
    if (entry.isDirectory()) await validateSnapshotLinks(root, fullPath);
  }
}

async function linkDependencies(
  sourceDir: string,
  targetDir: string,
): Promise<boolean> {
  const sourceModules = join(sourceDir, "node_modules");
  try {
    const info = await lstat(sourceModules);
    if (!info.isDirectory()) return false;
    await symlink(sourceModules, join(targetDir, "node_modules"), "junction");
    return true;
  } catch (error) {
    // 依赖目录是可选优化；不存在或无法创建 junction 时 QA 仍可自行安装依赖。
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(
        `[工作区快照] 未能复用 node_modules: ${(error as Error).message}`,
      );
    }
    return false;
  }
}

async function unlinkDependencies(targetDir: string): Promise<void> {
  const targetModules = join(targetDir, "node_modules");
  try {
    await unlink(targetModules);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function removeGitWorktree(
  sourceDir: string,
  targetDir: string,
): Promise<void> {
  try {
    await gitOutput(sourceDir, ["worktree", "remove", "--force", targetDir]);
  } catch {
    // 清理阶段即使 Git 元数据已损坏，也要继续删除临时目录。
  }
}

export interface WorkspaceSnapshot {
  /** QA 实际运行 CLI 的隔离目录。 */
  workspaceDir: string;
  /** 快照对应的 Developer 源目录。 */
  sourceWorkspaceDir: string;
  /** 快照创建前计算的稳定工作树指纹。 */
  revision: string;
  /** 删除快照及其临时 Git 元数据；可安全重复调用。 */
  cleanup(): Promise<void>;
}

/**
 * 创建与源工作树内容一致的隔离快照。Git 仓库使用 detached worktree 并应用
 * `git diff HEAD --binary` 与未跟踪文件；非 Git 目录复制可审查内容。生成后同时
 * 校验源目录和快照目录 revision，源目录在复制期间发生变化会直接拒绝交接。
 */
export async function createWorkspaceSnapshot(
  sourceWorkspaceDir: string,
): Promise<WorkspaceSnapshot> {
  const sourceDir = resolve(sourceWorkspaceDir);
  const revision = await workspaceRevision(sourceDir);
  const parentDir = await mkdtemp(join(tmpdir(), "threadpilot-qa-"));
  const targetDir = join(parentDir, "workspace");
  let gitWorktree = false;
  let dependenciesLinked = false;
  let cleaned = false;

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    // Windows 上 git worktree remove 会递归经过 junction；必须先断开依赖链接，
    // 否则清理 QA 快照可能误删 Developer 工作区的 node_modules 内容。
    if (dependenciesLinked) await unlinkDependencies(targetDir);
    if (gitWorktree) await removeGitWorktree(sourceDir, targetDir);
    await rm(parentDir, { recursive: true, force: true });
  };

  try {
    if (await isGitWorkspace(sourceDir)) {
      const [head, diff, untrackedOutput] = await Promise.all([
        gitOutput(sourceDir, ["rev-parse", "HEAD"]),
        gitOutput(sourceDir, ["diff", "HEAD", "--binary", "--no-ext-diff"]),
        gitOutput(sourceDir, [
          "ls-files",
          "--others",
          "--exclude-standard",
          "--exclude=node_modules/",
          "--exclude=dist/",
          "-z",
        ]),
      ]);
      await gitOutput(sourceDir, [
        "worktree",
        "add",
        "--detach",
        targetDir,
        head.trim(),
      ]);
      gitWorktree = true;

      if (diff) {
        const patchPath = join(parentDir, "changes.patch");
        await writeFile(patchPath, diff, "utf8");
        await gitOutput(targetDir, [
          "apply",
          "--binary",
          "--whitespace=nowarn",
          patchPath,
        ]);
      }
      await copyUntrackedFiles(
        sourceDir,
        targetDir,
        untrackedOutput.split("\0").filter(Boolean).sort(),
      );
      await validateSnapshotLinks(targetDir);
      dependenciesLinked = await linkDependencies(sourceDir, targetDir);
    } else {
      await copyTree(sourceDir, targetDir);
      await validateSnapshotLinks(targetDir);
      dependenciesLinked = await linkDependencies(sourceDir, targetDir);
    }

    const [sourceAfter, snapshotRevision] = await Promise.all([
      workspaceRevision(sourceDir),
      workspaceRevision(targetDir),
    ]);
    if (sourceAfter !== revision || snapshotRevision !== revision) {
      throw new Error(
        `工作区在快照期间发生变化（期望 ${revision}，源目录 ${sourceAfter}，快照 ${snapshotRevision}）`,
      );
    }
    return {
      workspaceDir: targetDir,
      sourceWorkspaceDir: sourceDir,
      revision,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
