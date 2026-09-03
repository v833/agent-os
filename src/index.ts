#!/usr/bin/env node
/**
 * ThreadPilot 引导入口：创建根 Context 并挂载 loader 插件。
 * loader 读取 cordis.yml 声明式装配全部服务与功能插件——“一切皆为插件”。
 *
 * 同时作为全局 CLI 入口（命令名 tpl，兼容别名 threadpilot），支持基础命令：
 *   tpl                       启动服务
 *   tpl --version/-v          打印版本号
 *   tpl --help/-h             打印用法
 *   tpl update                检查 npm 是否有新版本
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { Context } from "cordis";
import { apply as loaderApply, name as loaderName } from "./plugins/loader.js";
import { compareVersions, parseCliArgs } from "./cli/args.js";

// 读取包版本号：ESM 下通过 createRequire 解析 package.json，避免 JSON import attributes 对 tsconfig.module 的要求。
const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const command = parseCliArgs(process.argv.slice(2));

if (command === "version") {
  console.log(pkg.version);
  process.exit(0);
}

if (command === "help") {
  console.log(`tpl v${pkg.version} — 在飞书话题里指挥你的 AI 编程团队（兼容别名: threadpilot）

用法:
  tpl                   启动服务（读取当前目录 cordis.yml）
  tpl -v, --version     打印版本号
  tpl -h, --help        打印本帮助
  tpl update            检查 npm 上是否有新版本`);
  process.exit(0);
}

if (command === "invalid") {
  console.error(`未知命令: ${process.argv.slice(2).join(" ")}
运行 "threadpilot --help" 查看用法。`);
  process.exit(1);
}

if (command === "update") {
  await checkForUpdate(pkg.version);
  process.exit(0);
}

const root = new Context();

try {
  await root.plugin({ name: loaderName, apply: loaderApply });
  // 原始根 Context 不限制服务访问，这里输出与旧版一致的启动摘要。
  for (const adapter of root.cli.list()) {
    console.log(`[CLI] id=${adapter.id} command=${adapter.command}`);
  }
  for (const config of root.config.bots) {
    console.log(
      `[Bot ${config.id.toUpperCase()}] default_cli=${config.defaultCliId} access_mode=${config.accessMode} workspace=${config.workspaceDir}`,
    );
  }
  console.log(`[团队] Team Leader=${root.config.teamLeaderId}`);
  console.log("ThreadPilot 启动完成");
} catch (error) {
  console.error("ThreadPilot 启动失败:", (error as Error).message);
  process.exit(1);
}

/**
 * 查询 npm registry 最新版本并对比本地版本，打印升级提示。
 * 走系统 npm（继承用户 registry 与代理配置），Windows 下需 shell 解析 npm.cmd。
 */
function checkForUpdate(current: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("npm", ["view", "threadpilot", "version"], {
      shell: true,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      console.error(
        `无法检查更新（${error.message}），请确认网络与 npm 源后手动运行 "npm view threadpilot version"。`,
      );
      resolve();
    });
    child.on("close", (code) => {
      if (code !== 0 || !stdout.trim()) {
        const reason = stderr.trim() || `npm 退出码 ${code}`;
        console.error(
          `无法检查更新（${reason}），请确认网络与 npm 源后手动运行 "npm view threadpilot version"。`,
        );
        resolve();
        return;
      }
      const latest = stdout.trim();
      const diff = compareVersions(latest, current);
      if (diff > 0) {
        console.log(
          `有新版本可升级: ${latest}（当前 ${current}）→ 运行 "npm install -g threadpilot@latest"，升级后命令为 tpl`,
        );
      } else {
        console.log(`已是最新版本 ${current}`);
      }
      resolve();
    });
  });
}
