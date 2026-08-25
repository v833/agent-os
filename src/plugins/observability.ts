/**
 * observability 可观测性与链路追踪服务插件：
 * 挂载到 ctx.observability，监听任务开始、终态与 qa/result 等生命周期事件，
 * 收集层级 Span、统计 Token 消耗、时延分位数与工具调用，并提供指标大盘与文件导出。
 * 移除本插件或在 cordis.yml 中设置 disabled: true 即可整体下线。
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Service, type Context } from "cordis";
import {
  ObservabilityStore,
  type SystemMetricsSummary,
  type TraceFilter,
  type TraceRecord,
  type TraceSpan,
} from "../core/observability.js";
import type {
  QAResultPayload,
  TaskStartedPayload,
  TaskResultPayload,
} from "./types.js";

export interface ObservabilityConfig {
  /** 内存中最大保留 Trace 记录数，默认 500。 */
  maxTracesInMemory?: number;
  /** 是否将每条完成的 Trace 异步追加落盘到 JSONL 文件，默认 false。 */
  exportToFile?: boolean;
  /** Trace 日志落盘路径，默认 data/traces.jsonl。 */
  traceLogPath?: string;
}

export class ObservabilityService extends Service {
  private readonly store: ObservabilityStore;
  private readonly config: ObservabilityConfig;

  constructor(ctx: Context, config: ObservabilityConfig = {}) {
    super(ctx, "observability");
    this.config = config;
    this.store = new ObservabilityStore({
      maxTraces: config.maxTracesInMemory ?? 500,
    });

    this.registerEventListeners();
  }

  private registerEventListeners(): void {
    this.ctx.on("task/started", (payload: TaskStartedPayload) => {
      try {
        if (this.store.getTrace(payload.traceId)) return;
        this.store.startTrace({
          name: `task/${payload.botConfig.id}`,
          traceId: payload.traceId,
          botId: payload.botConfig.id,
          cliEngine: payload.session.cliId,
          chatId: payload.session.chatId,
          threadId: payload.session.threadId,
          taskId: payload.taskId,
          startTime: payload.startedAt,
        });
      } catch (error) {
        console.error("[可观测性] 建立任务链路失败:", (error as Error).message);
      }
    });

    // 监听任务成功事件
    this.ctx.on("task/result", async (payload: TaskResultPayload) => {
      try {
        const trace = this.recordCompletedTask(payload, "ok");
        if (trace && this.config.exportToFile) {
          await this.appendTraceToFile(trace);
        }
      } catch (error) {
        console.error("[可观测性] 记录任务成功指标失败:", (error as Error).message);
      }
    });

    // 监听任务失败事件
    this.ctx.on("task/failed", async (payload: TaskResultPayload) => {
      try {
        const trace = this.recordCompletedTask(payload, "error");
        if (trace && this.config.exportToFile) {
          await this.appendTraceToFile(trace);
        }
      } catch (error) {
        console.error("[可观测性] 记录任务失败指标失败:", (error as Error).message);
      }
    });

    this.ctx.on("task/paused", async (payload: TaskResultPayload) => {
      try {
        const trace = this.recordCompletedTask(payload, "paused");
        if (trace && this.config.exportToFile) {
          await this.appendTraceToFile(trace);
        }
      } catch (error) {
        console.error("[可观测性] 记录任务暂停指标失败:", (error as Error).message);
      }
    });

    this.ctx.on("task/cancelled", async (payload: TaskResultPayload) => {
      try {
        const trace = this.recordCompletedTask(payload, "cancelled");
        if (trace && this.config.exportToFile) {
          await this.appendTraceToFile(trace);
        }
      } catch (error) {
        console.error("[可观测性] 记录任务取消指标失败:", (error as Error).message);
      }
    });

    // 监听 QA 质量闸门审查结论
    this.ctx.on("qa/result", (payload: QAResultPayload) => {
      try {
        if (payload.qaResult?.verdict) {
          this.store.recordQaResult(payload.qaResult.verdict, {
            botId: payload.botConfig.id,
            chatId: payload.session.chatId,
          });
        }
      } catch (error) {
        console.error("[可观测性] 记录 QA 结论指标失败:", (error as Error).message);
      }
    });
  }

  private recordCompletedTask(
    payload: TaskResultPayload,
    status: "ok" | "error" | "paused" | "cancelled",
  ): TraceRecord | undefined {
    const existingTrace = payload.traceId
      ? this.store.getTrace(payload.traceId)
      : undefined;
    // 同一任务的终态事件可能因上游重试而重复到达；已结算的 Trace 必须保持幂等。
    if (existingTrace && existingTrace.status !== "running") return undefined;
    const trace =
      existingTrace ??
      this.store.startTrace({
        name: `task/${payload.botConfig.id}`,
        traceId: payload.traceId,
        botId: payload.botConfig.id,
        cliEngine: payload.session.cliId,
        chatId: payload.session.chatId,
        threadId: payload.session.threadId,
        taskId: payload.taskId,
        startTime:
          payload.durationMs !== undefined
            ? Date.now() - payload.durationMs
            : undefined,
      });

    if (payload.toolMetrics) {
      for (const [toolName, metrics] of Object.entries(payload.toolMetrics)) {
        for (let index = 0; index < metrics.invocations; index += 1) {
          this.store.recordToolInvocation(
            toolName,
            index < metrics.failures,
            trace.traceId,
          );
        }
      }
    } else if (Array.isArray(payload.toolCalls)) {
      for (const call of payload.toolCalls) {
        if (call && typeof call === "object" && "toolName" in call) {
          this.store.recordToolInvocation(
            String((call as { toolName: unknown }).toolName),
            false,
            trace.traceId,
          );
        }
      }
    }

    return this.store.finishTrace(trace.traceId, {
      status,
      stats: payload.stats,
      toolCallsCount: Array.isArray(payload.toolCalls) ? payload.toolCalls.length : undefined,
      endTime: Date.now(),
    });
  }

  private async appendTraceToFile(trace: TraceRecord): Promise<void> {
    const filePath = this.config.traceLogPath ?? "data/traces.jsonl";
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, JSON.stringify(trace) + "\n", "utf8");
  }

  /** 获取系统全局指标聚合快照。 */
  getSummary(filter: TraceFilter = {}): SystemMetricsSummary {
    return this.store.computeSummary(filter);
  }

  /** 格式化生成 Markdown 指标大盘。 */
  formatSummaryMarkdown(filter: TraceFilter = {}): string {
    return this.store.formatSummaryMarkdown(this.store.computeSummary(filter));
  }

  /** 获取指定 Trace 详情。 */
  getTrace(traceId: string): TraceRecord | undefined {
    return this.store.getTrace(traceId);
  }

  /** 获取最近的 Trace 列表。 */
  getRecentTraces(limit = 20, filter: TraceFilter = {}): TraceRecord[] {
    return this.store.listTraces(limit, filter);
  }

  /** 导出全部 Trace 为 JSONL 字符串。 */
  exportTracesJsonl(): string {
    return this.store
      .listTraces(this.store.maxTraces)
      .map((t) => JSON.stringify(t))
      .join("\n");
  }

  /** 显式创建一条外部链路追踪。 */
  startTrace(params: Parameters<ObservabilityStore["startTrace"]>[0]): TraceRecord {
    return this.store.startTrace(params);
  }

  /** 在 Trace 下开启子 Span。 */
  startSpan(params: Parameters<ObservabilityStore["startSpan"]>[0]): TraceSpan | undefined {
    return this.store.startSpan(params);
  }

  /** 结束指定 Span。 */
  endSpan(
    spanId: string,
    params?: Parameters<ObservabilityStore["endSpan"]>[1],
  ): TraceSpan | undefined {
    return this.store.endSpan(spanId, params);
  }
}

export const name = "observability";
export const inject = [];

export function apply(ctx: Context, config?: ObservabilityConfig) {
  new ObservabilityService(ctx, config);
}
