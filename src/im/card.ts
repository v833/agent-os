/**
 * 飞书任务卡片层：构建只表达任务状态的 JSON 2.0 卡片，
 * 并把高频 Agent 事件合并成低频、顺序稳定的消息更新。
 */

export type CardJson = Record<string, unknown>;
export type TaskStatus = "running" | "success" | "failed";

export interface TaskCardOptions {
  title: string;
  status: TaskStatus;
  progress: number;
  detail: string;
  activities?: string[];
}

const STATUS_STYLE = {
  running: { template: "blue", label: "运行中" },
  success: { template: "green", label: "已完成" },
  failed: { template: "red", label: "执行失败" },
} as const;

function clampProgress(progress: number): number {
  // 外部执行器的进度可能越界或带小数，渲染前统一收敛到整数百分比。
  return Math.min(100, Math.max(0, Math.round(progress)));
}

function buildProgressBar(progress: number): string {
  const filled = Math.round(progress / 10);
  return `${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
}

export function buildTaskCard(options: TaskCardOptions): CardJson {
  const progress = clampProgress(options.progress);
  const style = STATUS_STYLE[options.status];
  const activities = options.activities ?? [];
  const activityText = activities.length
    ? `\n\n**最近进展**\n${activities.map((item) => `- ${item}`).join("\n")}`
    : "";

  return {
    schema: "2.0",
    config: {
      // 共享卡片必须开启 update_multi，patch 后所有查看者才能看到同一状态。
      update_multi: true,
      summary: { content: `${options.title}：${style.label}` },
    },
    header: {
      template: style.template,
      title: { tag: "plain_text", content: options.title },
    },
    body: {
      direction: "vertical",
      elements: [
        {
          tag: "markdown",
          content: [
            `**状态：** ${style.label}`,
            `**进度：** ${buildProgressBar(progress)} ${progress}%`,
            `**当前：** ${options.detail}${activityText}`,
          ].join("\n\n"),
        },
        {
          tag: "button",
          text: {
            tag: "plain_text",
            content: options.status === "running" ? "任务执行中" : style.label,
          },
          type: options.status === "success" ? "primary" : "default",
          disabled: true,
        },
      ],
    },
  };
}

type UpdateCard = (card: CardJson) => Promise<void>;

/** 两秒窗口内无论 push 多少次，只提交最新的一张卡片。 */
export class ThrottledCardUpdater {
  private pendingCard: CardJson | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private updateChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly updateCard: UpdateCard,
    private readonly intervalMs = 2_000,
  ) {}

  push(card: CardJson): void {
    if (this.closed) throw new Error("卡片更新器已经结束");
    this.pendingCard = card;
    this.schedule();
  }

  async finish(finalCard: CardJson): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pendingCard = undefined;
    // 先等已发出的网络请求结束，避免旧进度晚到并覆盖最终状态。
    await this.updateChain;
    await this.updateCard(finalCard);
  }

  /** 取消待发送状态，但等待已经开始的更新结束，不再写入成功终态。 */
  async cancel(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pendingCard = undefined;
    await this.updateChain;
  }

  private schedule(): void {
    // 窗口内只保留一个定时器，后续 push 只覆盖 pendingCard。
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushPending();
    }, this.intervalMs);
  }

  private flushPending(): void {
    const card = this.pendingCard;
    this.pendingCard = undefined;
    if (!card || this.closed) return;

    // Promise 链保证 patch 严格串行，防止响应乱序使卡片状态倒退。
    this.updateChain = this.updateChain
      .then(() => this.updateCard(card))
      .finally(() => {
        if (this.pendingCard && !this.closed) this.schedule();
      });
  }
}
