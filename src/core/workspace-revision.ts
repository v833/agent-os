/**
 * 工作区 revision 指纹：在 Developer 交付时记录 HEAD、已跟踪改动和未跟踪文件内容，
 * 供 QA 固定审查版本并在结果中回填。优先使用 Git 工作树；非 Git 目录使用目录快照。
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readdir, readFile, readlink, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { join, relative, resolve } from "node:path";

const execFileAsync = promisify(execFile);

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
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout;
}

/** 生成当前工作区指纹；结果不包含可变时间，便于 QA 复核同一版本。 */
export async function workspaceRevision(workspaceDir: string): Promise<string> {
  try {
    const gitRoot = (
      await gitOutput(workspaceDir, ["rev-parse", "--show-toplevel"])
    ).trim();
    if (!samePath(gitRoot, workspaceDir)) {
      throw new Error("工作目录不是 Git 仓库根目录");
    }
    const [head, diff, untracked] = await Promise.all([
      gitOutput(workspaceDir, ["rev-parse", "HEAD"]),
      gitOutput(workspaceDir, ["diff", "HEAD", "--binary", "--no-ext-diff"]),
      gitOutput(workspaceDir, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "--exclude=node_modules/",
        "--exclude=dist/",
        "-z",
      ]),
    ]);
    const hash = createHash("sha256");
    hash.update(head.trim());
    hash.update("\0");
    hash.update(diff);
    hash.update("\0");
    for (const path of untracked.split("\0").filter(Boolean).sort()) {
      hash.update(path);
      hash.update("\0");
      const fullPath = join(workspaceDir, path);
      const info = await lstat(fullPath);
      hash.update(String(info.mode & 0o111));
      hash.update("\0");
      hash.update(
        info.isSymbolicLink()
          ? await readlink(fullPath)
          : await readFile(fullPath),
      );
      hash.update("\0");
    }
    return `git:${head.trim()}:${hash.digest("hex")}`;
  } catch {
    return workspaceTreeRevision(workspaceDir);
  }
}

/** 已知目录不是 Git 根目录时直接计算树指纹，避免重复启动必然失败的 Git 进程。 */
export async function workspaceTreeRevision(workspaceDir: string): Promise<string> {
  const hash = createHash("sha256");
  await hashDirectory(workspaceDir, workspaceDir, hash);
  return `tree:${hash.digest("hex")}`;
}

async function hashDirectory(
  root: string,
  current: string,
  hash: ReturnType<typeof createHash>,
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (
      entry.name === ".git" ||
      entry.name === "node_modules" ||
      entry.name === "dist"
    ) {
      continue;
    }
    const fullPath = join(current, entry.name);
    const relPath = relative(root, fullPath);
    hash.update(relPath);
    hash.update("\0");
    const info = await lstat(fullPath);
    hash.update(String(info.mode & 0o111));
    hash.update("\0");
    if (entry.isDirectory()) {
      await hashDirectory(root, fullPath, hash);
    } else if (entry.isSymbolicLink()) {
      hash.update(await readlink(fullPath));
    } else if (entry.isFile()) {
      hash.update(await readFile(fullPath));
    } else {
      hash.update(String((await stat(fullPath)).size));
    }
    hash.update("\0");
  }
}
