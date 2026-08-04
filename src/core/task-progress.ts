/**
 * 任务进度聚合器：把 CLI 的高频工具和上下文事件收拢成稳定快照，
 * 为当前终端日志和后续飞书流式卡片提供无平台依赖的状态模型。
 */
import type { CliEvent } from "../cli/types.js";

export interface TaskActivity {
  toolName: string;
  label: string;
  detail?: string;
  durationMs: number;
  failed: boolean;
}

export interface TaskProgressSnapshot {
  current: string;
  currentToolName?: string;
  currentDetail?: string;
  elapsedMs: number;
  toolCount: number;
  completedCount: number;
  activities: TaskActivity[];
  contextUsedTokens?: number;
  contextStartTokens?: number;
  contextWindowTokens?: number;
  startedNewSession?: boolean;
}

interface ActiveTool {
  toolName: string;
  label: string;
  detail?: string;
  startedAt: number;
}

/** 按工具调用 ID 聚合并发事件，并生成不可回写内部状态的快照。 */
export class TaskProgressTracker {
  private readonly startedAt: number;
  private readonly activeTools = new Map<string, ActiveTool>();
  private readonly activities: TaskActivity[] = [];
  private toolCount = 0;
  private completedCount = 0;
  private contextUsedTokens: number | undefined;
  private contextStartTokens: number | undefined;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly contextWindowTokens?: number,
    private readonly startedNewSession = false,
  ) {
    this.startedAt = now();
  }

  accept(event: CliEvent): TaskProgressSnapshot {
    if (event.type === "context") {
      // 起点只记录一次，才能区分累计上下文与本轮实际增减。
      this.contextStartTokens ??= event.usedTokens;
      this.contextUsedTokens = event.usedTokens;
    }
    if (event.type === "tool_start") {
      this.toolCount += 1;
      this.activeTools.set(event.toolUseId, {
        toolName: event.toolName,
        label: event.label,
        detail: event.detail,
        startedAt: this.now(),
      });
    }
    if (event.type === "tool_end") {
      const tool = this.activeTools.get(event.toolUseId);
      if (tool) {
        this.activeTools.delete(event.toolUseId);
        this.completedCount += 1;
        this.activities.unshift({
          toolName: tool.toolName,
          label: tool.label,
          ...(tool.detail ? { detail: tool.detail } : {}),
          durationMs: Math.max(0, this.now() - tool.startedAt),
          failed: event.failed,
        });
        // 卡片只需要最近活动；限制长度也避免长任务持续占用内存。
        this.activities.splice(12);
      }
    }
    return this.snapshot();
  }

  snapshot(): TaskProgressSnapshot {
    const active = [...this.activeTools.values()].at(-1);
    return {
      current:
        active?.label ?? (this.toolCount ? "正在分析执行结果" : "正在理解任务"),
      ...(active ? { currentToolName: active.toolName } : {}),
      ...(active?.detail ? { currentDetail: active.detail } : {}),
      elapsedMs: Math.max(0, this.now() - this.startedAt),
      toolCount: this.toolCount,
      completedCount: this.completedCount,
      activities: [...this.activities],
      ...(this.contextUsedTokens !== undefined
        ? { contextUsedTokens: this.contextUsedTokens }
        : {}),
      ...(this.contextStartTokens !== undefined
        ? { contextStartTokens: this.contextStartTokens }
        : {}),
      ...(this.contextWindowTokens !== undefined
        ? { contextWindowTokens: this.contextWindowTokens }
        : {}),
      ...(this.startedNewSession ? { startedNewSession: true } : {}),
    };
  }
}
