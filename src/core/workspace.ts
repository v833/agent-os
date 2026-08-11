/**
 * 工作目录工具：解析 bot 配置和话题相对路径，并在启动 CLI 前确认目标目录。
 * 它位于 Agent OS 的配置与会话之间，确保后续进程始终收到可用的绝对 cwd。
 */
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

/** 将相对工作目录按指定基准解析为绝对路径。 */
export function resolveWorkspacePath(
  input: string,
  baseDirectory = process.cwd(),
): string {
  const value = input.trim();
  if (!value) throw new Error("工作目录不能为空");
  return isAbsolute(value) ? resolve(value) : resolve(baseDirectory, value);
}

/** 确认路径存在且确实是文件夹，避免把错误 cwd 传给 CLI。 */
export async function ensureWorkspaceDirectory(
  workspacePath: string,
): Promise<void> {
  let info;
  try {
    info = await stat(workspacePath);
  } catch {
    throw new Error(`工作目录不存在: ${workspacePath}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`工作目录不是文件夹: ${workspacePath}`);
  }
}
