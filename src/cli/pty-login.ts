/**
 * 通用 ConPTY 登录注入器：很多 CLI（如 agy）只在真实 TTY 上接受登录授权码，
 * 管道 stdin 会被忽略并等待超时。本模块用 node-pty 创建伪终端，等 CLI 输出
 * 认证提示后把授权码作为键盘输入写入，让普通 Node 进程也能完成交互式登录。
 */
import { spawn } from "node-pty";
import { resolveCliCommand } from "./command-resolver.js";

export interface PtyLoginOptions {
  command: string;
  args: string[];
  /** 登录进程的工作目录。 */
  cwd: string;
  /** 用户从飞书卡片提交的授权码/登录 key；与 getCode 二选一。 */
  code?: string;
  /** CLI 打印该文本（不区分大小写）后开始注入授权码，例如 "paste the authorization code"。 */
  promptText: string;
  /** 整体超时毫秒；缺省 90 秒（OAuth 授权码通常只有几分钟有效）。 */
  timeoutMs?: number;
  /** 登录进程输出回调，可用于在登录卡片上展示进度。 */
  onOutput?: (chunk: string) => void;
  /**
   * 延迟注入：进程打印提示后先等本回调返回用户提交的授权码再写入 stdin。
   * 授权码与进程自身打印的授权 URL（PKCE）绑定，必须等用户按该 URL 授权后提交。
   */
  getCode?: () => Promise<string>;
}

/** 截取输出尾部并压缩成单行，让飞书卡片能展示可读的错误摘要。 */
export function summarizeOutput(output: string, maxLength = 400): string {
  const tail = output.trim().slice(-maxLength);
  return tail.replace(/\s+/g, " ").trim();
}

/**
 * 在伪终端中启动命令、注入授权码并等待进程退出。
 * 退出码 0 视为登录成功；非 0 / 超时按失败拒绝并携带输出摘要。
 */
export function runLoginWithPty(options: PtyLoginOptions): Promise<void> {
  const resolved = resolveCliCommand(options.command);
  const timeoutMs = options.timeoutMs ?? 90_000;
  const prompt = options.promptText.toLowerCase();

  return new Promise<void>((resolve, reject) => {
    // 成功/失败都只允许一个出口（超时与退出可能先后到达）。
    let settled = false;
    let output = "";
    let injected = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(
        new Error(
          `登录超时：等待「${options.promptText}」或进程退出超过 ${Math.round(timeoutMs / 1000)} 秒`,
        ),
      );
    }, timeoutMs);

    let child;
    try {
      child = spawn(resolved.command, [...resolved.argsPrefix, ...options.args], {
        name: "xterm-256color",
        cols: 140,
        rows: 40,
        cwd: options.cwd,
        env: process.env,
      });
    } catch (error) {
      fail(new Error(`无法启动登录进程：${(error as Error).message}`));
      return;
    }

    child.onData((data) => {
      output += data;
      options.onOutput?.(data);
      if (!injected && output.toLowerCase().includes(prompt)) {
        // 提示出现后标记已命中，避免同一输出再次触发注入逻辑。
        injected = true;
        if (options.getCode) {
          // 延迟注入：授权码必须来自本进程打印的授权 URL，等用户在卡片提交后写入。
          options.onOutput?.("\n[agent-os] 等待用户提交授权码…\n");
          options
            .getCode()
            .then((code) => {
              if (settled) return;
              options.onOutput?.("\n[agent-os] 正在注入登录 key…\n");
              child.write(`${code}\r`);
            })
            .catch(() => {
              // getCode 被拒绝（如流程被替换）时静默放弃注入。
            });
        } else {
          options.onOutput?.("\n[agent-os] 检测到授权提示，正在注入登录 key…\n");
          child.write(`${options.code ?? ""}\r`);
        }
      }
    });
    child.onExit(({ exitCode }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (exitCode === 0) {
        options.onOutput?.("\n[agent-os] 登录进程已退出（状态码 0）\n");
        resolve();
      } else {
        fail(
          new Error(`登录没有完成（退出码 ${exitCode}）：${summarizeOutput(output)}`),
        );
      }
    });
  });
}