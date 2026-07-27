/**
 * Windows CLI 入口解析：绕过 npm 生成的无扩展名 shell 脚本和 .cmd 包装器，
 * 直接定位 Node 入口或原生 exe，从而继续保持 spawn(shell=false)。
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface ResolvedCliCommand {
  command: string;
  argsPrefix: string[];
}

export interface ResolveCliCommandOptions {
  name: string;
  windowsPackageEntry: string[];
  windowsPackageEntryType: "node" | "executable";
}

function pathDirectories(): string[] {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .map((directory) => directory.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

/** 解析已安装 CLI 的可执行入口，非 Windows 平台直接交给 PATH。 */
export function resolveCliCommand(
  options: ResolveCliCommandOptions,
): ResolvedCliCommand {
  if (process.platform !== "win32") {
    return { command: options.name, argsPrefix: [] };
  }

  const directories = pathDirectories();
  for (const directory of directories) {
    const packageEntry = join(directory, ...options.windowsPackageEntry);
    if (!existsSync(packageEntry)) continue;
    if (options.windowsPackageEntryType === "node") {
      return { command: process.execPath, argsPrefix: [packageEntry] };
    }
    return { command: packageEntry, argsPrefix: [] };
  }

  for (const directory of directories) {
    const executable = join(directory, `${options.name}.exe`);
    if (existsSync(executable)) {
      return { command: executable, argsPrefix: [] };
    }
  }

  // 明确使用 .exe，避免 Node 命中 npm 的无扩展名 sh 脚本后返回 EPERM。
  return { command: `${options.name}.exe`, argsPrefix: [] };
}
