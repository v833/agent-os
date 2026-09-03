/**
 * threadpilot CLI 参数解析与版本比较（纯逻辑，供入口与测试复用）。
 */

export type CliCommand = "start" | "version" | "help" | "update" | "invalid";

/**
 * 解析命令行参数（不含 node 与脚本自身）。
 * 空参数默认启动服务；未知参数返回 "invalid"。
 */
export function parseCliArgs(argv: string[]): CliCommand {
  if (argv.length === 0) return "start";
  const [arg] = argv;
  // 基础命令均不接受额外参数，避免 "threadpilot update --force" 之类的误用。
  if (argv.length > 1) return "invalid";
  if (arg === "--version" || arg === "-v") return "version";
  if (arg === "--help" || arg === "-h") return "help";
  if (arg === "update") return "update";
  return "invalid";
}

/**
 * 简易语义化版本比较：按 "." 分段逐段数值比较。
 * 返回 -1 / 0 / 1 表示 a < b / a == b / a > b。
 * pre-release 后缀（如 0.1.0-beta）视为小于对应正式版本。
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const split = (v: string): number[] => {
    const [core] = v.split("-", 1);
    return core.split(".").map((part) => Number.parseInt(part, 10) || 0);
  };
  const aParts = split(a);
  const bParts = split(b);
  const length = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < length; i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  // 核心版本相同：有 pre-release 后缀者更小。
  const aPre = a.includes("-");
  const bPre = b.includes("-");
  if (aPre !== bPre) return aPre ? -1 : 1;
  return 0;
}
