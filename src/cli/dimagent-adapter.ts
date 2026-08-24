/**
 * DimAgent 适配器：把 `dim exec --json` 的 headless 输出接入 Agent OS。
 * DimAgent 的 ACP 接入由通用 AcpAdapter（engines/acp 插件）提供，不再内嵌于此。
 * 注意：dim 0.3.x 的 JSONL 事件格式是 eventType/payload 结构（text:delta 增量、run:ended 收尾），
 * 最终答案跨多行累积，因此本适配器按会话 ID 维护跨行状态（每轮 headless 独占一个会话/进程）。
 */
import { spawn } from "node:child_process";
import type {
  CliAccessMode,
  CliAdapter,
  CliCompactPlan,
  CliEvent,
  CliLoginOptions,
  CliRunStats,
} from "./types.js";
import type { ApplicationToolProvider } from "./app-tools.js";
import { findAcpApplicationTool } from "./app-tools.js";
import { ensureDimagentProjectMcpConfig } from "./dim-mcp-config.js";
import { stopProcessTree } from "./process-tree.js";
import { summarizeOutput } from "./pty-login.js";

/** 设备码登录的等待上限；用户在浏览器授权通常需要一两分钟，给足缓冲。 */
const DEVICE_LOGIN_TIMEOUT_MS = 5 * 60_000;

interface DimagentEvent {
  type?: unknown;
  subtype?: unknown;
  eventType?: unknown;
  sessionId?: unknown;
  session_id?: unknown;
  id?: unknown;
  toolUseId?: unknown;
  tool_use_id?: unknown;
  toolName?: unknown;
  tool_name?: unknown;
  name?: unknown;
  title?: unknown;
  label?: unknown;
  detail?: unknown;
  command?: unknown;
  answer?: unknown;
  result?: unknown;
  text?: unknown;
  message?: unknown;
  error?: unknown;
  usage?: unknown;
  stats?: unknown;
  item?: unknown;
  payload?: unknown;
}

/** 工具名到进度卡展示文案的映射；未命中时回退为“调用 <工具名>”。 */
const TOOL_LABELS: Record<string, string> = {
  read: "读取文件",
  edit: "修改文件",
  write: "写入文件",
  delete: "删除文件",
  move: "移动文件",
  search: "搜索代码",
  glob: "查找文件",
  grep: "搜索内容",
  exec: "运行命令",
  think: "分析任务",
  fetch: "读取网页",
  WebSearch: "网页搜索",
  WebFetch: "读取网页",
  skill: "加载技能",
  agent: "子代理",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function shortText(value: unknown, maxLength = 72): string | undefined {
  const text = asString(value)?.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > maxLength
    ? `${text.slice(0, maxLength - 1)}…`
    : text;
}

/** 从工具入参提取进度卡明细：优先 command 字段，其次整体 JSON 摘要。 */
function toolInputDetail(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  if (isRecord(input)) {
    if (typeof input.command === "string") return input.command;
    return JSON.stringify(input);
  }
  return undefined;
}

/** 把 dim 的 usage（promptTokens/completionTokens/totalTokens）转成统一统计结构。 */
function statsFromUsage(usage: unknown): CliRunStats | undefined {
  if (!isRecord(usage)) return undefined;
  const inputTokens = asNumber(usage.promptTokens);
  const outputTokens = asNumber(usage.completionTokens);
  const totalTokens = asNumber(usage.totalTokens);
  const cacheReadTokens = asNumber(usage.cacheReadTokens);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    cacheReadTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(totalTokens !== undefined
      ? { totalTokens }
      : { totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0) }),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
  };
}

/** 单个进行中 run 的跨行累积状态；key 为 dim 会话 ID（headless 每 run 独立会话）。 */
interface DimRunState {
  answer: string;
  sessionEmitted: boolean;
}

/** DimAgent 的 headless 适配器；ACP 接入见 AcpAdapter。 */
export class DimagentAdapter implements CliAdapter {
  readonly id = "dimagent" as const;
  readonly command = process.env.DIMAGENT_COMMAND?.trim() || "dim";
  readonly displayName = "DimAgent";
  readonly accessMode: CliAccessMode = "headless";
  /** DimAgent 平台 OAuth 走设备码流程，用户在浏览器授权，无需在卡片输入 key。 */
  readonly loginMode = "device" as const;

  private readonly runStates = new Map<string, DimRunState>();

  constructor(
    private readonly applicationTools: ApplicationToolProvider = () => [],
  ) {}

  /** 每轮启动前把插件 Server 增量合并到当前项目的 `.mcp.json`。 */
  async prepareRun(cwd: string): Promise<void> {
    await ensureDimagentProjectMcpConfig(cwd, this.applicationTools());
  }

  getApplicationTools() {
    return this.applicationTools();
  }

  buildArgs(prompt: string): string[] {
    return ["exec", "--json", "--policy", "full-access", prompt];
  }

  buildResumeArgs(prompt: string, sessionId: string): string[] {
    return ["exec", "resume", "--json", sessionId, prompt];
  }

  buildCompactPlan(_sessionId: string, _instructions?: string): CliCompactPlan {
    throw new Error("DimAgent 暂不支持原生 /compact，请在话题中发起整理任务");
  }

  /**
   * 解析 dim 0.3.x 的 JSONL 事件（eventType/payload 结构）。
   * 文本答案通过 text:delta 增量跨行累积，run:ended 时一次性发出 result；
   * 因适配器是全局单例、多轮任务并发共享，状态按会话 ID 隔离，run:ended 后即清理。
   */
  parseEvents(line: string): CliEvent[] {
    let event: DimagentEvent;
    try {
      event = JSON.parse(line) as DimagentEvent;
    } catch {
      return [];
    }

    const sessionId = asString(event.sessionId ?? event.session_id);
    const type = `${asString(event.eventType) ?? asString(event.type) ?? ""}`;
    const payload = isRecord(event.payload) ? event.payload : {};
    const events: CliEvent[] = [];

    // run:accepted 是每个 run 的首事件，此时创建累积状态并尽早发出会话事件，
    // 让 Runner 在后续失败时也能把错误包装成可续聊的 CliRunError。
    if (type === "run:accepted") {
      if (sessionId && !this.runStates.has(sessionId)) {
        this.runStates.set(sessionId, { answer: "", sessionEmitted: false });
        events.push({ type: "session", sessionId });
        this.runStates.get(sessionId)!.sessionEmitted = true;
      }
    }
    const state = sessionId ? this.runStates.get(sessionId) : undefined;

    if (type === "run:started" && state) {
      // 新一轮 run 重新累积答案；续聊的会话也在本进程重新输出全部 text:delta。
      state.answer = "";
    } else if (type === "text:delta" && state && typeof payload.delta === "string") {
      state.answer += payload.delta;
    } else if (type === "context:usage") {
      if (typeof payload.usedTokens === "number") {
        events.push({ type: "context", usedTokens: payload.usedTokens });
      }
    } else if (type === "tool:started") {
      const toolUseId = asString(payload.toolCallId);
      const toolName = asString(payload.toolName) ?? "Tool";
      if (toolUseId) {
        const applicationToolName = findAcpApplicationTool(
          this.applicationTools(),
          toolName,
        );
        events.push({
          type: "tool_start",
          toolUseId,
          toolName,
          label: TOOL_LABELS[toolName] ?? `调用 ${toolName}`,
          ...(shortText(toolInputDetail(payload.toolInput))
            ? { detail: shortText(toolInputDetail(payload.toolInput)) }
            : {}),
        });
        // tool_call 让 Runner 记录本轮成功调用的应用工具（失败的会在 tool_end 剔除）。
        // 只有插件注册的 MCP 工具进入澄清/应用工具结果链路；文件、命令等
        // 内建工具仍只展示进度，避免把所有工具调用误当作业务工具。
        if (applicationToolName) {
          events.push({
            type: "tool_call",
            toolUseId,
            toolName: applicationToolName,
            input: payload.toolInput ?? {},
          });
        }
      }
    } else if (type === "tool:completed") {
      const toolUseId = asString(payload.toolCallId);
      if (toolUseId) {
        const toolResult = isRecord(payload.toolResult) ? payload.toolResult : undefined;
        events.push({
          type: "tool_end",
          toolUseId,
          failed: toolResult?.isError === true,
        });
      }
    } else if (type === "run:ended") {
      const status = asString(payload.status) ?? "";
      const reason = asString(payload.reason) ?? "";
      const failed =
        status === "failed" || status === "error" || status === "cancelled" || reason === "error";
      if (failed) {
        events.push({
          type: "error",
          message: `DimAgent 执行未完成（${status || reason || "unknown"}）`,
          ...(sessionId ? { sessionId } : {}),
        });
      } else if (state) {
        events.push({
          type: "result",
          answer: state.answer,
          ...(sessionId ? { sessionId } : {}),
          ...(statsFromUsage(payload.usage) ? { stats: statsFromUsage(payload.usage) } : {}),
        });
      }
      if (sessionId) this.runStates.delete(sessionId);
    }

    // 累积状态回写（run:ended 已在上面清理，避免重新插入导致泄漏）。
    if (sessionId && state && type !== "run:ended") {
      this.runStates.set(sessionId, state);
    }
    return events;
  }

  isSessionUnavailable(message: string): boolean {
    return (
      /(?:session|conversation)[^\n]*(?:not found|does not exist|expired|invalid|unknown)/i.test(
        message,
      ) ||
      /no (?:such )?(?:session|conversation)\b/i.test(message) ||
      /ACP server 不支持恢复已有会话/.test(message)
    );
  }

  /** 判断失败信息是否表明 DimAgent 尚未登录（未认证时提示运行 auth login）。 */
  isAuthRequired(message: string): boolean {
    const text = message.toLowerCase();
    return (
      /not signed in to dimagent/.test(text) ||
      /auth login --provider/.test(text) ||
      /please (?:run )?dim auth login/.test(text) ||
      /sign in (?:first|required)/.test(text)
    );
  }

  /**
   * 用设备码流程完成 DimAgent 平台 OAuth 登录：`dim auth login --device-login`
   * 会把授权 URL 与设备码打印到 stdout 后轮询等待，用户在浏览器完成授权后
   * 进程以退出码 0 结束并写入凭据。全程不读 stdin，普通子进程即可驱动；
   * stdout 实时经 onOutput 转发，auth 插件据此把 URL/设备码推送到卡片。
   */
  async login(_code: string, options: CliLoginOptions = {}): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.command, ["auth", "login", "--device-login"], {
        cwd: options.cwd ?? process.cwd(),
        env: process.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(() => {
        // 设备码超时后结束进程树，避免残留轮询进程。
        void stopProcessTree(child).then(() =>
          fail(new Error("登录超时：请在浏览器中完成授权后再试。")),
        );
      }, options.timeoutMs ?? DEVICE_LOGIN_TIMEOUT_MS);
      const collect = (chunk: Buffer | string) => {
        const text = chunk.toString();
        output += text;
        options.onOutput?.(text);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.once("error", (error) => fail(error));
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          options.onOutput?.("\n[agent-os] 登录进程已退出（状态码 0）\n");
          resolve();
        } else {
          fail(
            new Error(
              `登录没有完成（退出码 ${code}）：${summarizeOutput(output)}`,
            ),
          );
        }
      });
    });
  }
}
