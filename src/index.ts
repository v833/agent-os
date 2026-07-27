import "dotenv/config";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const VERSION = "0.1.0";

function hasCommand(command: string): boolean {
  const locator = process.platform === "win32" ? "where.exe" : "sh";
  const args = process.platform === "win32" ? [command] : ["-c", `command -v "$1"`, "--", command];

  return spawnSync(locator, args, { stdio: "ignore" }).status === 0;
}

function check(label: string, ok: boolean, hint: string): void {
  console.log(`  ${ok ? "✅" : "⚠️ "} ${label}${ok ? "" : `  → ${hint}`}`);
}

console.log(`\nAgent OS v${VERSION} — 一个人，一队 Agent\n`);
console.log("环境自检：");

const nodeMajor = Number(process.versions.node.split(".")[0]);
check(`Node.js ${process.versions.node}`, nodeMajor >= 22, "需要 Node 22+");
check(
  ".env 配置文件",
  existsSync(".env"),
  "复制 .env.example 为 .env 并填入飞书凭证",
);
check("Claude Code CLI", hasCommand("claude"), "接入 Claude Code 前需要安装");
check("Codex CLI", hasCommand("codex"), "接入 Codex 前需要安装");

console.log("\n骨架就绪。下一步：接入 AI CLI 的 headless 事件流。\n");
