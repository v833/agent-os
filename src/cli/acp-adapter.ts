/**
 * 通用 ACP 适配器：把任意提供 Agent Client Protocol server 的 CLI 接入
 * Agent OS，接入方式与具体供应商解耦——只要配置启动命令与参数即可。
 * ACP 模式的会话/事件/取消由 acp-daemon（常驻进程）处理，本适配器只负责
 * 描述“如何拉起这个 ACP server”以及失效会话识别。
 */
import type {
  AcpMcpTransport,
  AcpResumeMethod,
  AcpSessionConfig,
  CliAdapter,
  CliEvent,
  CliCompactPlan,
} from "./types.js";
import type { ApplicationToolProvider } from "./app-tools.js";

/** 声明一个标准 ACP 引擎所需的全部配置，由 engines/acp 插件从 cordis.yml 读取。 */
export interface AcpEngineConfig {
  /** 引擎标识，作为会话与 bot 配置中的 defaultCli 使用。 */
  id: string;
  /** 启动 ACP server 的可执行命令（如 dim、claude 等）。 */
  command: string;
  /** 启动 ACP server 的额外参数（如 ["acp"]）；不传则直接执行 command。 */
  args?: string[];
  /** 卡片与日志展示名；缺省用 `${id} (ACP)`。 */
  displayName?: string;
  /** session/new 后应用的权限、模式和模型覆盖。 */
  session?: AcpSessionConfig;
  /** 恢复已有会话时选择的 ACP 方法；Dim 使用 load 以支持跨进程恢复。 */
  resumeMethod?: AcpResumeMethod;
  /** ACP server 的最低版本；缺少或低于该版本时拒绝启动。 */
  minAgentVersion?: string;
  /** ACP server 支持的 MCP transport；未声明时保留所有传输。 */
  acpMcpTransports?: AcpMcpTransport[];
}

/** 标准 ACP 接入适配器；同一 id 的 headless 实现可并存，靠 accessMode 区分。 */
export class AcpAdapter implements CliAdapter {
  readonly accessMode = "acp" as const;
  readonly id: string;
  readonly command: string;
  readonly displayName: string;
  private readonly args: string[];
  private readonly sessionConfig?: AcpSessionConfig;
  private readonly resumeMethod: AcpResumeMethod;
  private readonly minAgentVersion?: string;
  private readonly acpMcpTransports?: AcpMcpTransport[];

  constructor(
    config: AcpEngineConfig,
    private readonly applicationTools: ApplicationToolProvider = () => [],
  ) {
    this.id = config.id;
    this.command = config.command;
    this.args = config.args ?? [];
    this.displayName = config.displayName ?? `${config.id} (ACP)`;
    this.sessionConfig = config.session;
    this.resumeMethod = config.resumeMethod ?? "auto";
    this.minAgentVersion = config.minAgentVersion;
    this.acpMcpTransports = config.acpMcpTransports;
  }

  /** ACP daemon 从适配器读取插件注册的 MCP Server，保持通用 ACP 接入不绑定具体引擎。 */
  getApplicationTools(): ReturnType<ApplicationToolProvider> {
    return this.applicationTools();
  }

  getAcpSessionConfig(): AcpSessionConfig | undefined {
    return this.sessionConfig;
  }

  getAcpResumeMethod(): AcpResumeMethod {
    return this.resumeMethod;
  }

  getAcpMinAgentVersion(): string | undefined {
    return this.minAgentVersion;
  }

  getAcpMcpTransports(): readonly AcpMcpTransport[] | undefined {
    return this.acpMcpTransports;
  }

  /** ACP 模式不把 prompt 放进启动参数；每次会话的 prompt 通过协议发送。 */
  buildArgs(_prompt: string): string[] {
    return this.args;
  }

  buildResumeArgs(_prompt: string, _sessionId: string): string[] {
    return this.args;
  }

  buildCompactPlan(_sessionId: string, _instructions?: string): CliCompactPlan {
    throw new Error("ACP 引擎暂不支持原生 /compact，请在话题中发起整理任务");
  }

  /** ACP 事件由 acp-daemon 翻译；headless JSONL 解析不适用。 */
  parseEvents(_line: string): CliEvent[] {
    return [];
  }

  /** 判断失败信息是否明确表示恢复指针已经失效（常驻进程重建后旧会话不可恢复）。 */
  isSessionUnavailable(message: string): boolean {
    return (
      /(?:session|conversation)[^\n]*(?:not found|does not exist|expired|invalid|unknown)/i.test(
        message,
      ) ||
      /no (?:such )?(?:session|conversation)\b/i.test(message) ||
      /ACP server 不支持恢复已有会话/.test(message)
    );
  }
}
