// 对照实验：启动 agy 后立即注入假授权码，判断 ConPTY stdin 是否被 agy 读取。
import pty from "node-pty";
import { resolveCliCommand } from "../src/cli/command-resolver.js";

const resolved = resolveCliCommand("agy");
const child = pty.spawn(
  resolved.command,
  [...resolved.argsPrefix, "-p", "只回复 OK", "--output-format", "stream-json"],
  { name: "xterm-256color", cols: 140, rows: 40, cwd: process.cwd(), env: process.env },
);

let out = "";
let injected = false;
const started = Date.now();

child.onData((data) => {
  out += data;
  process.stdout.write(data);
  if (!injected && /paste the authorization code/i.test(out)) {
    injected = true;
    console.log("\n>>> 立即注入假码 TEST-INVALID-CODE-123456");
    child.write("TEST-INVALID-CODE-123456\r");
  }
  if (Date.now() - started > 65_000) {
    console.log(">>> 65s 兜底，终止。\n>>> 结论: agy 未在注入后立即报错 -> 可能未读取 stdin 或等待中。");
    child.kill();
  }
});

child.onExit(({ exitCode }) => {
  console.log(`\n>>> agy 退出, 状态码: ${exitCode}, 注入后耗时: ${Date.now() - started}ms`);
  const tail = out.slice(-1200);
  console.log(">>> 输出尾部:\n" + tail);
  process.exit(0);
});
