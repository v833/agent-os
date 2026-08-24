/**
 * Antigravity CLI (agy) 协议适配器：
 * 负责首次/续聊参数构造、stream-json 事件翻译与会话失效判定；
 * 不参与子进程生命周期管理（由通用 Runner 驱动）。
 *
 * 事件语义基于 agy 1.1.x 真实 stream-json 协议（已用本机 agy 1.1.16 探针校准）：
 *   - 顶层以 event 字段判别：init / step_update / result；
 *   - 数据嵌套在 event 同名子对象中（init / step_update / result）；
 *   - step_update 用 step_type + state（ACTIVE=开始 / DONE=结束）描述步骤；
 *   - 工具调用携带 tool_name 与 tool_info（name/parameters/output）；
 *   - 终态 result.response 即最终回答，result.usage 为 token 统计。
 *
 * 能力边界（与 Claude/Codex/DimAgent 的差异）：
 *   - agy 1.1.x 没有命令行 MCP 注入点，适配器会在启动前把应用工具合并到
 *     当前工作区 `.agents/mcp_config.json`，由 agy print/headless 自动发现；
 *   - agy 没有原生 compact 事件协议，buildCompactPlan 明确抛错拒绝 /compact。
 */
import type { ApplicationToolProvider } from "./app-tools.js";
import { findAgyApplicationTool } from "./app-tools.js";
import { ensureAgyMcpConfig } from "./agy-mcp-config.js";
import { runLoginWithPty } from "./pty-login.js";
import type {
  CliAdapter,
  CliCompactPlan,
  CliEvent,
  CliLoginOptions,
  CliRunStats,
} from "./types.js";

const TOOL_LABELS: Record<string, string> = {
  view_file: "查看文件",
  write_to_file: "创建文件",
  replace_file_content: "修改文件",
  multi_replace_file_content: "批量修改文件",
  run_command: "执行终端命令",
  grep_search: "搜索代码",
  find_by_name: "查找文件",
  search_web: "搜索网络",
  read_url_content: "读取网页",
};

/** 登录探测用的极简 prompt：只为触发认证流程，不产生实际工作。 */
const SMLOGIN_PROMPT = "只回复 OK，不要执行任何其他操作。";

interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

/** step_update 事件内嵌的子对象。 */
interface AgyStepUpdate {
  conversation_id?: string;
  step_index?: number;
  /** ACTIVE=步骤开始；DONE=步骤完成。工具的开始/结束据此配对。 */
  state?: string;
  /** 步骤类型判别器：user_input / checkpoint / agent_response / tool / ... */
  step_type?: string;
  tool_name?: string;
  text_delta?: string;
  tool_info?: {
    name?: string;
    parameters?: Record<string, unknown>;
    output?: string;
  };
  usage?: AgyUsage;
}

/** agy stream-json 的单行事件（字段名以真实输出为准，见 src/cli/agy-adapter.test.ts 样例）。 */
interface AgyEvent {
  /** 顶层判别字段：init / step_update / result。 */
  event?: string;
  conversation_id?: string;
  init?: { cwd?: string; tools?: string[]; permission_mode?: string };
  step_update?: AgyStepUpdate;
  result?: {
    conversation_id?: string;
    status?: string;
    response?: string;
    num_turns?: number;
    usage?: AgyUsage;
  };
  error?: string;
}

/** 从 usage 对象计算 usedTokens 与 CliRunStats。 */
function usageStats(usage: AgyUsage | undefined): CliRunStats | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    ...(usage.cache_read_tokens !== undefined
      ? { cacheReadTokens: usage.cache_read_tokens }
      : {}),
  };
}

export class AgyAdapter implements CliAdapter {
  readonly id = "agy" as const;
  readonly command = "agy";
  readonly displayName = "Antigravity";
  readonly accessMode = "headless" as const;

  constructor(
    private readonly applicationTools: ApplicationToolProvider = () => [],
  ) {}

  async prepareRun(cwd: string): Promise<void> {
    await ensureAgyMcpConfig(cwd, this.applicationTools());
  }

  /** 构造首次执行的命令行参数 */
  buildArgs(prompt: string): string[] {
    return [
      "--dangerously-skip-permissions",
      "-p",
      prompt,
      "--output-format",
      "stream-json",
    ];
  }

  /** 构造会话续聊的命令行参数（按会话 ID 恢复） */
  buildResumeArgs(prompt: string, sessionId: string): string[] {
    return [
      "--conversation",
      sessionId,
      "--dangerously-skip-permissions",
      "-p",
      prompt,
      "--output-format",
      "stream-json",
    ];
  }

  /**
   * 上下文整理：agy 1.1.x 的 stream-json 不产出原生 compact 完成事件，
   * 伪装成 claude-stream-json 只会让执行器永远等不到 compact_boundary 而误报失败。
   * 与 DimAgent 一致：明确拒绝，请用户在话题中发起整理任务。
   */
  buildCompactPlan(_sessionId: string, _instructions?: string): CliCompactPlan {
    throw new Error("Antigravity 暂不支持原生 /compact，请在话题中发起整理任务");
  }

  /**
   * 判断 CLI 报错是否表明会话已失效。agy 对不存在的会话会向 stderr 输出
   * `warning: conversation "xxx" not found`，同时仍以退出码 0 静默新建会话，
   * Runner 靠本方法识别该场景并拒绝“成功”结果。
   */
  isSessionUnavailable(message: string): boolean {
    const text = message.toLowerCase();
    return (
      /(?:session|conversation)[^\n]*(?:not found|could not find|does not exist|expired|invalid|unknown)/.test(
        text,
      ) ||
      /(?:not found|could not find|does not exist|expired|invalid|unknown)[^\n]*(?:session|conversation)/.test(
        text,
      ) ||
      /no (?:such |active )?(?:session|conversation)\b/.test(text)
    );
  }

  /**
   * 判断失败信息是否表明 agy 需要 Google OAuth 登录。
   * 未认证时 agy 在 stderr 输出 "Authentication required. Please visit the URL
   * to log in: ..." 并等待粘贴授权码，最终以 "authentication timed out" 退出。
   */
  isAuthRequired(message: string): boolean {
    const text = message.toLowerCase();
    return (
      /authentication\s+required/.test(text) ||
      /paste\s+the\s+authorization\s+code/.test(text) ||
      /please\s+visit\s+the\s+url\s+to\s+log\s+in/.test(text) ||
      /authentication\s+(?:failed|timed\s*out)/.test(text)
    );
  }

  /**
   * 用 Google OAuth 授权码完成 agy 登录：agy 只在真实 TTY 上读取粘贴的授权码，
   * 管道 stdin 会被忽略（等待超时），因此必须借助 ConPTY 注入。
   * 登录成功后 agy 会把令牌写入 ~/.gemini/antigravity-cli，之后 headless 运行免登录；
   * 已登录时本方法只会执行一轮最小探测即成功退出，保持幂等。
   * 授权码与每次启动的 PKCE 绑定：必须等待用户在本进程打印的授权 URL 上授权后
   * 提交，因此通过 options.getCode 延迟获取，避免使用过期错误文本里的旧授权码。
   */
  async login(code: string, options: CliLoginOptions = {}): Promise<void> {
    await runLoginWithPty({
      command: this.command,
      args: this.buildArgs(SMLOGIN_PROMPT),
      cwd: options.cwd ?? process.cwd(),
      code,
      promptText: "paste the authorization code",
      timeoutMs: options.timeoutMs,
      onOutput: options.onOutput,
      getCode: options.getCode,
    });
  }

  /** 将 agy 的 stream-json 单行输出解析为 Agent OS 标准 CliEvent */
  parseEvents(line: string): CliEvent[] {
    let raw: AgyEvent;
    try {
      raw = JSON.parse(line) as AgyEvent;
    } catch {
      return [];
    }

    const events: CliEvent[] = [];

    // 1. 会话 ID：init 事件顶层携带 conversation_id；result 的会话 id 在其 result 子对象内。
    //    session 事件只由 init 发出（避免重复），result/error 事件仅携带 sessionId 属性。
    const sessionId =
      raw.conversation_id ??
      raw.result?.conversation_id ??
      raw.step_update?.conversation_id;
    if (raw.event === "init" && sessionId) {
      events.push({ type: "session", sessionId });
    }

    // 2. step_update：翻译工具调用（state=ACTIVE 开始 / DONE 结束）与 token 用量。
    if (raw.event === "step_update" && raw.step_update) {
      const step = raw.step_update;
      const toolName = step.tool_name ?? step.tool_info?.name;
      if (toolName) {
        // 真实输出无工具调用 ID，同一工具的 ACTIVE/DONE 用相同 step_index 配对。
        const toolUseId = `step-${step.step_index ?? "unknown"}`;
        const label = TOOL_LABELS[toolName] ?? `调用 ${toolName}`;
        if (step.state === "DONE") {
          events.push({ type: "tool_end", toolUseId, failed: false });
        } else {
          events.push({
            type: "tool_start",
            toolUseId,
            toolName,
            label,
          });
          const applicationToolName = [
            step.tool_name,
            step.tool_info?.name,
          ]
            .map((candidate) =>
              findAgyApplicationTool(this.applicationTools(), candidate),
            )
            .find((candidate): candidate is string => candidate !== undefined);
          if (applicationToolName) {
            events.push({
              type: "tool_call",
              toolUseId,
              toolName: applicationToolName,
              input: step.tool_info?.parameters ?? {},
            });
          }
        }
      }
      if (step.usage) {
        const usedTokens = step.usage.input_tokens ?? step.usage.total_tokens;
        if (usedTokens !== undefined) {
          events.push({ type: "context", usedTokens });
        }
      }
    }

    // 3. 终态 result：response 为最终回答，usage 为统计。
    if (raw.event === "result" && raw.result) {
      const result = raw.result;
      // 状态明确失败且没有回答时按 error 处理，避免把失败当成功。
      const failed =
        result.response === undefined &&
        /error|failure|cancel/i.test(result.status ?? "");
      if (failed) {
        events.push({
          type: "error",
          message: `agy 执行未完成（${result.status ?? "failed"}）`,
          ...(sessionId ? { sessionId } : {}),
        });
      } else {
        const stats = usageStats(result.usage);
        events.push({
          type: "result",
          answer: result.response ?? "",
          ...(sessionId ? { sessionId } : {}),
          ...(stats ? { stats } : {}),
        });
      }
    }

    // 4. 显式错误字段。
    if (raw.error) {
      events.push({
        type: "error",
        message: raw.error,
        ...(sessionId ? { sessionId } : {}),
      });
    }

    return events;
  }

  parseEvent(line: string): CliEvent | undefined {
    return this.parseEvents(line)[0];
  }
}
