/**
 * 可观测性与链路追踪核心领域模型：定义 Span、Trace、Token 消耗统计与系统级指标聚合。
 * 纯函数与内存存储实现，无外部框架依赖，供 Observability 插件与相关测试复用。
 */
import { randomUUID } from "node:crypto";
import type { CliRunStats } from "../cli/types.js";

type SpanKind = "internal" | "server" | "client" | "producer" | "consumer";
type SpanStatus = "unset" | "ok" | "error";

/** 链路追踪单元 Span。 */
export interface TraceSpan {
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: SpanStatus;
  error?: string;
  attributes: Record<string, string | number | boolean | undefined>;
  events?: Array<{ name: string; timestamp: number; attributes?: Record<string, unknown> }>;
}

/** 单次业务任务的完整 Trace 记录。 */
export interface TraceRecord {
  traceId: string;
  name: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: "running" | "ok" | "error" | "paused" | "cancelled";
  botId?: string;
  cliEngine?: string;
  chatId?: string;
  threadId?: string;
  taskId?: string;
  error?: string;
  stats?: {
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    contextUsedTokens?: number;
  };
  toolCallsCount?: number;
  toolMetrics?: Record<string, { invocations: number; failures: number }>;
  spans: TraceSpan[];
}

/** Trace 查询范围；命令层用 botId + chatId 隔离不同群聊和机器人。 */
export interface TraceFilter {
  botId?: string;
  chatId?: string;
}

/** 系统级多维指标汇总快照。 */
export interface SystemMetricsSummary {
  totalTasks: number;
  successTasks: number;
  failedTasks: number;
  pausedTasks: number;
  cancelledTasks: number;
  runningTasks: number;
  successRate: number;
  totalDurationMs: number;
  avgDurationMs: number;
  p50DurationMs: number;
  p90DurationMs: number;
  p99DurationMs: number;
  tokens: {
    total: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  };
  byBot: Record<
    string,
    {
      totalTasks: number;
      successTasks: number;
      failedTasks: number;
      totalTokens: number;
      avgDurationMs: number;
    }
  >;
  byEngine: Record<
    string,
    {
      totalTasks: number;
      successTasks: number;
      failedTasks: number;
      totalTokens: number;
      avgDurationMs: number;
    }
  >;
  byTool: Record<
    string,
    {
      invocations: number;
      failures: number;
    }
  >;
  qa: {
    total: number;
    pass: number;
    changesRequested: number;
    blocked: number;
  };
}

/** 计算数值数组的分位数（0 - 100）。 */
export function calculatePercentile(values: number[], percentile: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (percentile / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  if (lower === upper) return sorted[lower];
  return Math.round(sorted[lower] * (1 - weight) + sorted[upper] * weight);
}

export interface ObservabilityStoreOptions {
  /** 内存中最大保留 Trace 记录数，超出按 FIFO 淘汰，默认 500 条。 */
  maxTraces?: number;
}

/**
 * 可观测性有界内存存储管理器：
 * 维护 Trace / Span 生命周期、记录 QA 与工具指标，并实时聚合系统统计指标。
 */
export class ObservabilityStore {
  readonly maxTraces: number;
  private readonly traces = new Map<string, TraceRecord>();
  private readonly spanMap = new Map<string, TraceSpan>();
  private readonly traceOrder: string[] = [];

  private readonly qaResults: Array<{
    verdict: "pass" | "changes_requested" | "blocked";
    botId?: string;
    chatId?: string;
  }> = [];

  constructor(options: ObservabilityStoreOptions = {}) {
    const configuredMax = options.maxTraces ?? 500;
    this.maxTraces = Number.isFinite(configuredMax)
      ? Math.max(10, Math.floor(configuredMax))
      : 500;
  }

  /** 发起一条新 Trace。 */
  startTrace(params: {
    name: string;
    traceId?: string;
    botId?: string;
    cliEngine?: string;
    chatId?: string;
    threadId?: string;
    taskId?: string;
    startTime?: number;
  }): TraceRecord {
    const traceId = params.traceId ?? randomUUID();
    const startTime = params.startTime ?? Date.now();
    const existing = this.traces.get(traceId);
    if (existing) return existing;

    const record: TraceRecord = {
      traceId,
      name: params.name,
      startTime,
      status: "running",
      botId: params.botId,
      cliEngine: params.cliEngine,
      chatId: params.chatId,
      threadId: params.threadId,
      taskId: params.taskId,
      spans: [],
    };

    // 自动开辟根 Span
    const rootSpan: TraceSpan = {
      spanId: randomUUID(),
      traceId,
      name: params.name,
      kind: "server",
      startTime,
      status: "unset",
      attributes: {
        "bot.id": params.botId,
        "cli.engine": params.cliEngine,
        "task.id": params.taskId,
      },
    };

    record.spans.push(rootSpan);
    this.spanMap.set(rootSpan.spanId, rootSpan);

    this.traces.set(traceId, record);
    this.traceOrder.push(traceId);
    this.evictIfNecessary();

    return record;
  }

  /** 在指定 Trace 下启动一个子 Span。 */
  startSpan(params: {
    traceId: string;
    name: string;
    parentSpanId?: string;
    kind?: SpanKind;
    attributes?: Record<string, string | number | boolean | undefined>;
    startTime?: number;
  }): TraceSpan | undefined {
    const trace = this.traces.get(params.traceId);
    if (!trace) return undefined;

    const spanId = randomUUID();
    const span: TraceSpan = {
      spanId,
      traceId: params.traceId,
      parentSpanId: params.parentSpanId ?? trace.spans[0]?.spanId,
      name: params.name,
      kind: params.kind ?? "internal",
      startTime: params.startTime ?? Date.now(),
      status: "unset",
      attributes: params.attributes ?? {},
    };

    trace.spans.push(span);
    this.spanMap.set(spanId, span);
    return span;
  }

  /** 结束一个 Span。 */
  endSpan(
    spanId: string,
    params: {
      status?: SpanStatus;
      error?: string;
      endTime?: number;
      attributes?: Record<string, string | number | boolean | undefined>;
    } = {},
  ): TraceSpan | undefined {
    const span = this.spanMap.get(spanId);
    if (!span) return undefined;

    const endTime = params.endTime ?? Date.now();
    span.endTime = endTime;
    span.durationMs = Math.max(0, endTime - span.startTime);
    span.status = params.status ?? (params.error ? "error" : "ok");
    span.error = params.error;
    if (params.attributes) {
      span.attributes = { ...span.attributes, ...params.attributes };
    }
    return span;
  }

  /** 完成一条 Trace。 */
  finishTrace(
    traceId: string,
    params: {
      status: "ok" | "error" | "paused" | "cancelled";
      error?: string;
      endTime?: number;
      stats?: CliRunStats;
      toolCallsCount?: number;
    },
  ): TraceRecord | undefined {
    const trace = this.traces.get(traceId);
    // 生命周期终态只允许写入一次，防止重复事件覆盖真实结论或重复累计指标。
    if (!trace || trace.status !== "running") return undefined;

    const endTime = params.endTime ?? Date.now();
    trace.endTime = endTime;
    trace.durationMs = Math.max(0, endTime - trace.startTime);
    trace.status = params.status;
    trace.error = params.error;
    trace.toolCallsCount = params.toolCallsCount;

    if (params.stats) {
      trace.stats = {
        totalTokens: params.stats.totalTokens,
        inputTokens: params.stats.inputTokens,
        outputTokens: params.stats.outputTokens,
        cacheReadTokens: params.stats.cacheReadTokens,
        cacheCreationTokens: params.stats.cacheCreationTokens,
        contextUsedTokens: params.stats.contextUsedTokens,
      };
    }

    // 自动闭合根 Span
    const rootSpan = trace.spans[0];
    if (rootSpan && !rootSpan.endTime) {
      rootSpan.endTime = endTime;
      rootSpan.durationMs = trace.durationMs;
      rootSpan.status =
        params.status === "ok"
          ? "ok"
          : params.status === "error"
            ? "error"
            : "unset";
      rootSpan.error = params.error;
      if (params.stats?.totalTokens) {
        rootSpan.attributes["token.total"] = params.stats.totalTokens;
      }
    }

    return trace;
  }

  /** 记录 QA 质量闸门结论。 */
  recordQaResult(
    verdict: "pass" | "changes_requested" | "blocked",
    dimensions: TraceFilter = {},
  ): void {
    this.qaResults.push({ verdict, ...dimensions });
    this.qaResults.splice(0, Math.max(0, this.qaResults.length - this.maxTraces));
  }

  /** 记录工具调用指标。 */
  recordToolInvocation(toolName: string, failed: boolean, traceId: string): void {
    const trace = this.traces.get(traceId);
    if (!trace) return;
    trace.toolMetrics ??= {};
    const existing = trace.toolMetrics[toolName] ?? {
      invocations: 0,
      failures: 0,
    };
    existing.invocations += 1;
    if (failed) existing.failures += 1;
    trace.toolMetrics[toolName] = existing;
  }

  /** 获取单个 Trace。 */
  getTrace(traceId: string): TraceRecord | undefined {
    return this.traces.get(traceId);
  }

  /** 列出最近的 Trace 列表（按开始时间倒序）。 */
  listTraces(limit = 20, filter: TraceFilter = {}): TraceRecord[] {
    const result: TraceRecord[] = [];
    const count = Math.max(0, Math.min(limit, this.traceOrder.length));
    for (let i = this.traceOrder.length - 1; i >= 0 && result.length < count; i--) {
      const trace = this.traces.get(this.traceOrder[i]);
      if (trace && this.matchesFilter(trace, filter)) result.push(trace);
    }
    return result;
  }

  /** 聚合计算全局多维指标。 */
  computeSummary(filter: TraceFilter = {}): SystemMetricsSummary {
    const traces = [...this.traces.values()].filter((trace) =>
      this.matchesFilter(trace, filter),
    );
    let totalTasks = 0;
    let successTasks = 0;
    let failedTasks = 0;
    let pausedTasks = 0;
    let cancelledTasks = 0;
    let runningTasks = 0;
    let totalDurationMs = 0;
    const durations: number[] = [];

    const tokens = {
      total: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
    };

    const byBot: SystemMetricsSummary["byBot"] = {};
    const byEngine: SystemMetricsSummary["byEngine"] = {};

    for (const trace of traces) {
      totalTasks += 1;
      if (trace.status === "ok") successTasks += 1;
      else if (trace.status === "error") failedTasks += 1;
      else if (trace.status === "paused") pausedTasks += 1;
      else if (trace.status === "cancelled") cancelledTasks += 1;
      else runningTasks += 1;

      if (trace.durationMs !== undefined) {
        totalDurationMs += trace.durationMs;
        durations.push(trace.durationMs);
      }

      if (trace.stats) {
        tokens.total += trace.stats.totalTokens ?? 0;
        tokens.input += trace.stats.inputTokens ?? 0;
        tokens.output += trace.stats.outputTokens ?? 0;
        tokens.cacheRead += trace.stats.cacheReadTokens ?? 0;
        tokens.cacheCreation += trace.stats.cacheCreationTokens ?? 0;
      }

      // 按 Bot 聚合
      const botKey = trace.botId ?? "unknown";
      if (!byBot[botKey]) {
        byBot[botKey] = {
          totalTasks: 0,
          successTasks: 0,
          failedTasks: 0,
          totalTokens: 0,
          avgDurationMs: 0,
        };
      }
      const botStat = byBot[botKey];
      botStat.totalTasks += 1;
      if (trace.status === "ok") botStat.successTasks += 1;
      else if (trace.status === "error") botStat.failedTasks += 1;
      botStat.totalTokens += trace.stats?.totalTokens ?? 0;

      // 按 Engine 聚合
      const engineKey = trace.cliEngine ?? "unknown";
      if (!byEngine[engineKey]) {
        byEngine[engineKey] = {
          totalTasks: 0,
          successTasks: 0,
          failedTasks: 0,
          totalTokens: 0,
          avgDurationMs: 0,
        };
      }
      const engineStat = byEngine[engineKey];
      engineStat.totalTasks += 1;
      if (trace.status === "ok") engineStat.successTasks += 1;
      else if (trace.status === "error") engineStat.failedTasks += 1;
      engineStat.totalTokens += trace.stats?.totalTokens ?? 0;
    }

    // 计算各维度平均耗时
    for (const [botKey, stat] of Object.entries(byBot)) {
      const botTraces = traces.filter(
        (t) => (t.botId ?? "unknown") === botKey && t.durationMs !== undefined,
      );
      const sum = botTraces.reduce((acc, cur) => acc + (cur.durationMs ?? 0), 0);
      stat.avgDurationMs = botTraces.length ? Math.round(sum / botTraces.length) : 0;
    }

    for (const [engineKey, stat] of Object.entries(byEngine)) {
      const engineTraces = traces.filter(
        (t) => (t.cliEngine ?? "unknown") === engineKey && t.durationMs !== undefined,
      );
      const sum = engineTraces.reduce((acc, cur) => acc + (cur.durationMs ?? 0), 0);
      stat.avgDurationMs = engineTraces.length ? Math.round(sum / engineTraces.length) : 0;
    }

    const byTool: SystemMetricsSummary["byTool"] = {};
    for (const trace of traces) {
      for (const [toolName, stat] of Object.entries(trace.toolMetrics ?? {})) {
        const total = byTool[toolName] ?? { invocations: 0, failures: 0 };
        total.invocations += stat.invocations;
        total.failures += stat.failures;
        byTool[toolName] = total;
      }
    }

    const qa = { total: 0, pass: 0, changesRequested: 0, blocked: 0 };
    for (const result of this.qaResults) {
      if (!this.matchesFilter(result, filter)) continue;
      qa.total += 1;
      if (result.verdict === "pass") qa.pass += 1;
      else if (result.verdict === "changes_requested") qa.changesRequested += 1;
      else qa.blocked += 1;
    }

    const avgDurationMs = durations.length
      ? Math.round(totalDurationMs / durations.length)
      : 0;
    // 等待输入、主动取消和仍在执行的任务都不是质量结论，不计入成功率分母。
    const decidedTasks = successTasks + failedTasks;
    const successRate = decidedTasks
      ? Math.round((successTasks / decidedTasks) * 100)
      : 0;

    return {
      totalTasks,
      successTasks,
      failedTasks,
      pausedTasks,
      cancelledTasks,
      runningTasks,
      successRate,
      totalDurationMs,
      avgDurationMs,
      p50DurationMs: calculatePercentile(durations, 50),
      p90DurationMs: calculatePercentile(durations, 90),
      p99DurationMs: calculatePercentile(durations, 99),
      tokens,
      byBot,
      byEngine,
      byTool,
      qa,
    };
  }

  /** 格式化输出易读的飞书 Markdown 大盘报告。 */
  formatSummaryMarkdown(summary = this.computeSummary()): string {
    const lines: string[] = [];
    lines.push("📊 **Agent OS 可观测性大盘**\n");

    // 核心概览
    lines.push("⚡ **任务吞吐与时延**");
    const statusCounts = [
      `✅ 成功 ${summary.successTasks}`,
      `❌ 失败 ${summary.failedTasks}`,
      `⏸️ 等待输入 ${summary.pausedTasks}`,
      `⏹️ 已取消 ${summary.cancelledTasks}`,
      `⏳ 执行中 ${summary.runningTasks}`,
    ];
    lines.push(`- 任务总量：${summary.totalTasks}（${statusCounts.join(" / ")}）`);
    lines.push(`- 成功率：${summary.successRate}%`);
    const durationPercentiles = [
      `平均 ${(summary.avgDurationMs / 1000).toFixed(1)}s`,
      `P50 ${(summary.p50DurationMs / 1000).toFixed(1)}s`,
      `P90 ${(summary.p90DurationMs / 1000).toFixed(1)}s`,
      `P99 ${(summary.p99DurationMs / 1000).toFixed(1)}s`,
    ];
    lines.push(`- 耗时分布：${durationPercentiles.join(" | ")}\n`);

    // Token 统计
    lines.push("💰 **Token 消耗**");
    lines.push(`- 总 Token：${summary.tokens.total.toLocaleString()}`);
    lines.push(`- 输入 / 输出：${summary.tokens.input.toLocaleString()} / ${summary.tokens.output.toLocaleString()}`);
    lines.push(
      `- 缓存读取 / 创建：${summary.tokens.cacheRead.toLocaleString()} / ${summary.tokens.cacheCreation.toLocaleString()}\n`,
    );

    // Bot 维度
    if (Object.keys(summary.byBot).length > 0) {
      lines.push("🤖 **Bot 成员分布**");
      for (const [botId, s] of Object.entries(summary.byBot)) {
        lines.push(
          [
            `- **${botId}**：${s.totalTasks} 任务（${s.successTasks} 成功）`,
            `${s.totalTokens.toLocaleString()} tokens`,
            `均耗 ${(s.avgDurationMs / 1000).toFixed(1)}s`,
          ].join(" | "),
        );
      }
      lines.push("");
    }

    // 执行引擎维度
    if (Object.keys(summary.byEngine).length > 0) {
      lines.push("⚙️ **执行引擎分布**");
      for (const [engine, s] of Object.entries(summary.byEngine)) {
        lines.push(
          [
            `- **${engine}**：${s.totalTasks} 任务`,
            `${s.totalTokens.toLocaleString()} tokens`,
            `均耗 ${(s.avgDurationMs / 1000).toFixed(1)}s`,
          ].join(" | "),
        );
      }
      lines.push("");
    }

    // QA 质量闸门
    if (summary.qa.total > 0) {
      const qaPassRate = Math.round((summary.qa.pass / summary.qa.total) * 100);
      lines.push("🛡️ **QA 质量闸门**");
      lines.push(`- 审查总次：${summary.qa.total}（通过率 ${qaPassRate}%）`);
      lines.push(`- ✅ 通过 ${summary.qa.pass} | 🔄 返工 ${summary.qa.changesRequested} | 🚫 阻塞 ${summary.qa.blocked}\n`);
    }

    // 常用工具
    const toolEntries = Object.entries(summary.byTool).sort(
      (a, b) => b[1].invocations - a[1].invocations,
    );
    if (toolEntries.length > 0) {
      lines.push("🔧 **工具调用 TOP (前 5 项)**");
      for (const [tool, s] of toolEntries.slice(0, 5)) {
        const failRate = s.invocations ? ((s.failures / s.invocations) * 100).toFixed(1) : "0.0";
        lines.push(`- \`${tool}\`：调用 ${s.invocations} 次（失败率 ${failRate}%）`);
      }
    }

    return lines.join("\n");
  }

  private evictIfNecessary(): void {
    while (this.traceOrder.length > this.maxTraces) {
      const oldestTraceId = this.traceOrder.shift();
      if (!oldestTraceId) break;
      const trace = this.traces.get(oldestTraceId);
      if (trace) {
        for (const span of trace.spans) {
          this.spanMap.delete(span.spanId);
        }
        this.traces.delete(oldestTraceId);
      }
    }
  }

  private matchesFilter(
    value: { botId?: string; chatId?: string },
    filter: TraceFilter,
  ): boolean {
    if (filter.botId !== undefined && value.botId !== filter.botId) return false;
    if (filter.chatId !== undefined && value.chatId !== filter.chatId) return false;
    return true;
  }
}
