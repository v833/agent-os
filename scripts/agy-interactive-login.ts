/**
 * 本机 agy 交互登录脚本（node-pty / ConPTY）：
 * agy 只在真实 TTY 上接受授权码粘贴，管道 stdin 会被忽略。
 * 脚本用伪终端启动 agy，等它打印授权提示后轮询 data/agy-login-code.txt，
 * 外部把授权码写入该文件即触发注入，完成 Google OAuth 登录。
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import pty from "node-pty";
import { resolveCliCommand } from "../src/cli/command-resolver.js";

const CODE_FILE = "data/agy-login-code.txt";
const TOKEN_FILE = `${process.env.USERPROFILE}\\.gemini\\antigravity-cli\\antigravity-oauth-token`;
const TIMEOUT_MS = 90_000;

try {
  unlinkSync(CODE_FILE); // 清理上次残留的授权码文件。
} catch {
  /* 文件不存在无需处理 */
}

const resolved = resolveCliCommand("agy");
const PROXY = process.env.AGY_LOGIN_PROXY ?? "http://127.0.0.1:10808";
const child = pty.spawn(
  resolved.command,
  [...resolved.argsPrefix, "-p", "只回复 OK", "--output-format", "stream-json"],
  {
    name: "xterm-256color",
    cols: 140,
    rows: 40,
    cwd: process.cwd(),
    env: {
      ...process.env,
      // Google OAuth 换 token 需要访问 oauth2.googleapis.com，直连不通时必须走代理
      // （授权页能打开是因为浏览器有代理；CLI 进程默认无代理导致 token exchange 失败）。
      HTTP_PROXY: PROXY,
      HTTPS_PROXY: PROXY,
      ALL_PROXY: PROXY,
      http_proxy: PROXY,
      https_proxy: PROXY,
      all_proxy: PROXY,
    },
  },
);

let output = "";
let injected = false;
let pollTimer: ReturnType<typeof setInterval> | undefined;
const started = Date.now();

function startPolling(): void {
  if (pollTimer) return;
  console.log("\n>>> 授权页已弹出（或用上方 URL）。请完成授权后，把浏览器显示的授权码发给我。");
  console.log(">>> 收到授权码后我会写入 data/agy-login-code.txt，脚本自动注入完成登录。\n");
  pollTimer = setInterval(() => {
    if (injected) return;
    try {
      const code = readFileSync(CODE_FILE, "utf8").trim();
      if (code) {
        injected = true;
        clearInterval(pollTimer);
        console.log(">>> 检测到授权码，正在注入 agy 登录进程…");
        child.write(`${code}\r`);
      }
    } catch {
      /* 文件尚未写入 */
    }
    if (Date.now() - started > TIMEOUT_MS) {
      clearInterval(pollTimer);
      console.error(">>> 超时：授权码未提交，agy 登录窗口可能已结束，请重跑脚本。");
    }
  }, 500);
}

child.onData((data) => {
  output += data;
  process.stdout.write(data);
  if (!pollTimer && /paste the authorization code/i.test(output)) {
    const url = /https?:\/\/[^\s]+/.exec(output)?.[0];
    if (url) console.log(`\n>>> 授权 URL: ${url}`);
    startPolling();
  }
});

child.onExit(({ exitCode }) => {
  if (pollTimer) clearInterval(pollTimer);
  console.log(`\n>>> agy 进程退出，状态码: ${exitCode}`);
  if (exitCode === 0) {
    if (existsSync(TOKEN_FILE)) {
      console.log(`>>> 登录成功！令牌已写入:\n    ${TOKEN_FILE}`);
      console.log(">>> 之后 ThreadPilot 的 agy 任务免登录。");
    } else {
      console.log(">>> 进程成功退出，但未发现令牌文件，请确认授权是否完成。");
    }
  } else {
    console.log(`>>> 登录未完成（退出码 ${exitCode}）。输出尾部:\n${output.slice(-800)}`);
  }
  process.exit(0);
});

// 兜底：进程异常存活时强制终止，避免脚本悬挂。
const guard = setTimeout(() => {
  console.error(">>> 脚本兜底超时，终止 agy 进程。");
  child.kill();
}, TIMEOUT_MS + 15_000);
guard.unref?.();
