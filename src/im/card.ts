/**
 * 飞书卡片渲染：把多引擎统一事件快照和历史会话选择渲染成稳定视图，
 * 并负责高频任务卡片更新的节流与串行化。
 */
import type { CliRunStats, CliSessionSummary } from "../cli/types.js";
import type { AuthFlow } from "../core/cli-auth.js";
import type { ClarificationFlow } from "../core/clarification.js";
import { retryToken, type OrchestrationRun } from "../core/orchestration.js";
import type { ProductSpecFlow } from "../core/product-spec.js";
import type {
  TaskActivity,
  TaskProgressSnapshot,
} from "../core/task-progress.js";

export type CardJson = Record<string, unknown>;
export type TaskStatus = "running" | "success" | "failed" | "cancelled";

export interface TaskCardOptions {
  title: string;
  status: TaskStatus;
  detail: string;
  progress?: TaskProgressSnapshot;
  answer?: string;
  stats?: CliRunStats;
  technicalDetail?: string;
  abortSessionId?: string;
  abortRunId?: string;
}

export interface ClarificationCardOptions {
  flow: ClarificationFlow;
}

export interface ClarificationStateCardOptions {
  flow: ClarificationFlow;
}

export interface ResumeCardOptions {
  agentSessionId: string;
  cliName: string;
  currentCliSessionId?: string;
  sessions: CliSessionSummary[];
}

export interface SessionNoticeCardOptions {
  title: string;
  detail: string;
  template?: "blue" | "green" | "grey";
}

/** 通用交接卡片展示所需的来源、目标、编排者与任务说明。 */
export interface CollaborationCardOptions {
  senderName: string;
  targetName: string;
  reportToName: string;
  workspaceName: string;
  objective: string;
  instruction: string;
  expectedOutput?: string;
  round: number;
  maxRounds: number;
}

/** 团队成员卡片条目：来自 TeamRegistry 的职责与运行时连接状态。 */
export interface TeamCardMember {
  id: string;
  displayName: string;
  role: string;
  cliName: string;
  skills: string[];
  isLeader: boolean;
  ready: boolean;
}

export interface TeamCardOptions {
  members: TeamCardMember[];
}

/** 编排面板卡片输入：一次或多次 /orchestrate 的运行快照；maxRetry 决定重试按钮。 */
export interface OrchestrationPanelOptions {
  runs: OrchestrationRun[];
  /** 失败子任务最大重试次数；0/缺省不渲染重试按钮（actions 插件下线时的降级）。 */
  maxRetry?: number;
}

/** 生成重试按钮一次性令牌的 nonce：时间戳+随机数，保证同一子任务每批渲染令牌不同。 */
function newRetryNonce(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const STATUS_STYLE = {
  running: { template: "blue", label: "执行中" },
  success: { template: "green", label: "已完成" },
  failed: { template: "red", label: "执行失败" },
  cancelled: { template: "grey", label: "已取消" },
} as const;

const COMPACT_ANSWER_LENGTH = 900;
const MAX_CARD_ANSWER_LENGTH = 6_000;
const RUNNING_ACTIVITY_LIMIT = 3;
const FINISHED_ACTIVITY_LIMIT = 8;

const TOOL_ICONS: Record<string, string> = {
  Agent: "🧩",
  Bash: "⌘",
  Edit: "✏️",
  Glob: "📁",
  Grep: "🔎",
  Read: "📄",
  Task: "🧩",
  TaskOutput: "⏳",
  WebFetch: "🌐",
  WebSearch: "🔍",
  Write: "📝",
  command_execution: "⌘",
};

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1_000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (seconds === 0) return `${minutes} 分钟`;
  return `${minutes} 分 ${seconds} 秒`;
}

function formatCount(value: number): string {
  return value >= 1_000 ? `${Math.round(value / 100) / 10}k` : String(value);
}

function escapeInlineCode(value: string): string {
  return value.replaceAll("`", "ˋ");
}

function escapeFeishuMarkdown(value: string): string {
  // CLI 回答属于不可信文本，不能让其中形似 <at> 的内容变成真实卡片标签。
  return value.replace(/<(?=\/?[A-Za-z][^>]*>)/g, "<&zwj;");
}

function escapeFeishuMarkdownLink(value: string): string {
  // URL 已在产品契约中限制到可信域名；额外转义括号，避免破坏卡片链接语法。
  return value.replaceAll("(", "%28").replaceAll(")", "%29");
}

function activityLine(activity: TaskActivity): string {
  const icon = activity.failed ? "⚠️" : (TOOL_ICONS[activity.toolName] ?? "⚙️");
  const detail = activity.detail
    ? ` · \`${escapeInlineCode(activity.detail)}\``
    : "";
  const duration =
    activity.durationMs >= 1_000
      ? ` · ${formatDuration(activity.durationMs)}`
      : "";
  return `${icon} ${activity.label}${detail}${duration}`;
}

function markdownSplitIndex(text: string, maxLength: number): number {
  if (text.length <= maxLength) return text.length;
  const paragraph = text.lastIndexOf("\n\n", maxLength);
  if (paragraph >= maxLength * 0.55) return paragraph;
  const line = text.lastIndexOf("\n", maxLength);
  return line >= maxLength * 0.55 ? line : maxLength;
}

function closeOpenFence(markdown: string): string {
  const fences = markdown.match(/^```/gm)?.length ?? 0;
  return fences % 2 === 1 ? `${markdown}\n\n\`\`\`` : markdown;
}

function markdownPreview(text: string, maxLength: number): string {
  return closeOpenFence(
    text.slice(0, markdownSplitIndex(text, maxLength)).trim(),
  );
}

function compactAnswerPreview(answer: string): string {
  const fenceIndex = answer.search(/\n```/);
  const prose = fenceIndex > 0 ? answer.slice(0, fenceIndex) : answer;
  const preview = markdownPreview(prose, COMPACT_ANSWER_LENGTH)
    .replace(/\n(?:---|#{1,6}\s+[^\n]+)\s*$/, "")
    .trim();
  return preview.length >= 40
    ? preview
    : "回答包含较多代码与细节，展开后可以查看完整内容。";
}

function usageTotal(stats: CliRunStats | undefined): number | undefined {
  if (!stats) return undefined;
  if (stats.totalTokens !== undefined) return stats.totalTokens;
  const values = [
    stats.inputTokens,
    stats.outputTokens,
    stats.cacheReadTokens,
    stats.cacheCreationTokens,
  ].filter((value): value is number => value !== undefined);
  return values.length
    ? values.reduce((sum, value) => sum + value, 0)
    : undefined;
}

function formatContextUsage(
  usedTokens: number | undefined,
  windowTokens: number | undefined,
): string | undefined {
  if (usedTokens === undefined) return undefined;
  if (windowTokens === undefined || windowTokens <= 0) {
    return `当前上下文约 ${formatCount(usedTokens)} tokens`;
  }
  // 累计 usage 可能超过窗口，遇到这种口径不能伪装成当前上下文百分比。
  if (usedTokens > windowTokens) return undefined;
  const percentage = Math.round((usedTokens / windowTokens) * 100);
  return `当前上下文 ${formatCount(usedTokens)} / ${formatCount(windowTokens)}（${percentage}%）`;
}

function formatContextGrowth(
  usedTokens: number | undefined,
  startTokens: number | undefined,
  startedNewSession = false,
): string | undefined {
  if (usedTokens === undefined || startTokens === undefined) return undefined;
  const delta = usedTokens - startTokens;
  const change =
    delta >= 0
      ? `新增 ${formatCount(delta)}`
      : `减少 ${formatCount(Math.abs(delta))}`;
  const startLabel = startedNewSession ? "新会话基础" : "本轮开始";
  return `${startLabel} ${formatCount(startTokens)} · ${change}`;
}

function buildRunningElements(
  options: TaskCardOptions,
): Record<string, unknown>[] {
  const progress = options.progress;
  const currentIcon = progress?.currentToolName
    ? `${TOOL_ICONS[progress.currentToolName] ?? "⚙️"} `
    : "";
  const currentDetail = progress?.currentDetail
    ? `\n\`${escapeInlineCode(progress.currentDetail)}\``
    : "";
  const meta = progress
    ? `${formatDuration(progress.elapsedMs)} · ${progress.toolCount} 次工具调用`
    : "刚刚开始";
  const context = formatContextUsage(
    progress?.contextUsedTokens,
    progress?.contextWindowTokens,
  );
  const contextGrowth = formatContextGrowth(
    progress?.contextUsedTokens,
    progress?.contextStartTokens,
    progress?.startedNewSession,
  );
  const elements: Record<string, unknown>[] = [
    {
      tag: "markdown",
      content: `**${currentIcon}${progress?.current ?? options.detail}**${currentDetail}\n\n${meta}${context ? `\n_${context}_` : ""}${contextGrowth ? `\n_${contextGrowth}_` : ""}`,
    },
  ];

  if (progress?.activities.length) {
    const visible = progress.activities.slice(0, RUNNING_ACTIVITY_LIMIT);
    elements.push({
      tag: "markdown",
      content: `**最近完成（${visible.length} / ${progress.completedCount}）**\n${visible.map(activityLine).join("\n")}`,
    });
  }

  // 每轮唯一 runId 防止旧卡片按钮命中同一会话后来启动的新任务。
  if (options.abortSessionId && options.abortRunId) {
    elements.push({
      tag: "button",
      text: { tag: "plain_text", content: "停止任务" },
      type: "danger",
      width: "default",
      size: "medium",
      behaviors: [
        {
          type: "callback",
          value: {
            action: "abort_task",
            sessionId: options.abortSessionId,
            runId: options.abortRunId,
          },
        },
      ],
    });
  }

  return elements;
}

function collapsibleHeader(content: string): Record<string, unknown> {
  return {
    title: { tag: "plain_text", content },
    vertical_align: "center",
    icon: {
      tag: "standard_icon",
      token: "down-small-ccm_outlined",
      size: "16px 16px",
    },
    icon_position: "right",
    icon_expanded_angle: -180,
  };
}

function buildFinishedElements(
  options: TaskCardOptions,
): Record<string, unknown>[] {
  const progress = options.progress;
  const durationMs = options.stats?.durationMs ?? progress?.elapsedMs;
  const totalTokens = usageTotal(options.stats);
  const context = formatContextUsage(
    progress?.contextUsedTokens ?? options.stats?.contextUsedTokens,
    options.stats?.contextWindowTokens ?? progress?.contextWindowTokens,
  );
  const contextGrowth = formatContextGrowth(
    progress?.contextUsedTokens ?? options.stats?.contextUsedTokens,
    progress?.contextStartTokens,
    progress?.startedNewSession,
  );
  const executionMeta = [
    durationMs !== undefined
      ? `**耗时** ${formatDuration(durationMs)}`
      : undefined,
    progress ? `**工具调用** ${progress.toolCount} 次` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const usageMeta = [
    totalTokens !== undefined
      ? `**累计消耗** ${formatCount(totalTokens)} tokens`
      : undefined,
    context
      ? `**当前上下文** ${context.replace(/^当前上下文(?:约)?\s+/, "")}`
      : undefined,
    contextGrowth ? `**本轮变化** ${contextGrowth}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  const meta = [executionMeta, usageMeta].filter(Boolean).join("\n\n");
  const elements: Record<string, unknown>[] = [];

  if (options.status === "success") {
    const answer = options.answer || options.detail;
    if (answer.length <= COMPACT_ANSWER_LENGTH) {
      elements.push({ tag: "markdown", content: escapeFeishuMarkdown(answer) });
    } else {
      elements.push({
        tag: "markdown",
        content: `${escapeFeishuMarkdown(compactAnswerPreview(answer))}\n\n_完整回答已收起_`,
      });
      elements.push({
        tag: "collapsible_panel",
        expanded: false,
        header: collapsibleHeader("查看完整回答"),
        vertical_spacing: "8px",
        padding: "8px 8px 8px 8px",
        elements: [
          {
            tag: "markdown",
            content: escapeFeishuMarkdown(
              markdownPreview(answer, MAX_CARD_ANSWER_LENGTH),
            ),
          },
        ],
      });
    }
    if (answerNeedsContinuation(answer)) {
      elements.push({
        tag: "markdown",
        content: "_回答较长，剩余内容已继续发送。_",
      });
    }
  } else {
    elements.push({ tag: "markdown", content: `**${options.detail}**` });
    if (options.technicalDetail) {
      elements.push({
        tag: "collapsible_panel",
        expanded: false,
        header: collapsibleHeader("查看错误详情"),
        vertical_spacing: "8px",
        padding: "8px 8px 8px 8px",
        elements: [
          {
            tag: "markdown",
            content: `\`${escapeInlineCode(options.technicalDetail)}\``,
          },
        ],
      });
    }
  }

  if (meta || progress?.activities.length) {
    const visible =
      progress?.activities.slice(0, FINISHED_ACTIVITY_LIMIT) ?? [];
    const activityText = visible.length
      ? `\n\n**最近执行轨迹**\n${visible.map(activityLine).join("\n")}`
      : "";
    elements.push({
      tag: "collapsible_panel",
      expanded: false,
      header: collapsibleHeader("执行详情"),
      vertical_spacing: "8px",
      padding: "8px 8px 8px 8px",
      elements: [
        {
          tag: "markdown",
          content: `${meta || options.detail}${activityText}`,
        },
      ],
    });
  }

  return elements;
}

/** 根据任务状态生成可被飞书原消息持续更新的 JSON 2.0 卡片。 */
export function buildTaskCard(options: TaskCardOptions): CardJson {
  const style = STATUS_STYLE[options.status];
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: `${options.title}：${style.label}` },
    },
    header: {
      template: style.template,
      title: {
        tag: "plain_text",
        content: `${options.title} · ${style.label}`,
      },
    },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      elements:
        options.status === "running"
          ? buildRunningElements(options)
          : buildFinishedElements(options),
    },
  };
}

function formatSessionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function clarificationButton(
  flow: ClarificationFlow,
  option: { id: string; label: string },
): Record<string, unknown> {
  const question = flow.request.questions[flow.currentIndex]!;
  const recommendedOptionId =
    question.recommendedOptionId ?? question.options[0]?.id;
  return {
    tag: "button",
    text: {
      tag: "plain_text",
      content:
        option.id === recommendedOptionId
          ? option.label.includes("推荐")
            ? option.label
            : `${option.label}（推荐）`
          : option.label,
    },
    type: option.id === recommendedOptionId ? "primary" : "default",
    width: "fill",
    size: "medium",
    behaviors: [
      {
        type: "callback",
        value: {
          action: "answer_clarification",
          flowToken: flow.token,
          questionId: question.id,
          optionId: option.id,
        },
      },
    ],
  };
}

function clarificationDecisionButton(
  flow: ClarificationFlow,
  decisionMode: "current" | "remaining",
): Record<string, unknown> {
  const question = flow.request.questions[flow.currentIndex]!;
  return {
    tag: "button",
    text: {
      tag: "plain_text",
      content:
        decisionMode === "current" ? "这一题交给 Agent 决定" : "按推荐方案继续",
    },
    type: decisionMode === "remaining" ? "primary" : "default",
    width: "fill",
    size: "medium",
    behaviors: [
      {
        type: "callback",
        value: {
          action: "answer_clarification",
          flowToken: flow.token,
          questionId: question.id,
          decisionMode,
        },
      },
    ],
  };
}

function clarificationAnswerSummary(flow: ClarificationFlow): string {
  return flow.answers
    .map((answer, index) =>
      [
        `${index + 1}. **${escapeFeishuMarkdown(answer.prompt)}**`,
        `${answer.source === "agent" ? "Agent 推荐" : "你的选择"}：${escapeFeishuMarkdown(answer.answer)}`,
      ].join("\n"),
    )
    .join("\n\n");
}

function buildFlowClarificationCard(flow: ClarificationFlow): CardJson {
  const question = flow.request.questions[flow.currentIndex];
  if (!question) return buildClarificationContinuingCard(flow);
  const current = flow.currentIndex + 1;
  const total = flow.request.questions.length;
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: `${flow.request.title}（${current}/${total}）` },
    },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: flow.request.title },
      subtitle: { tag: "plain_text", content: `${current} / ${total}` },
    },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      elements: [
        ...(flow.request.intro && flow.currentIndex === 0
          ? [{ tag: "markdown", content: escapeFeishuMarkdown(flow.request.intro) }]
          : []),
        ...(flow.answers.length
          ? [
              {
                tag: "markdown",
                content: `**已确认 ${flow.answers.length} 项**\n\n${clarificationAnswerSummary(flow)}`,
              },
              { tag: "hr" },
            ]
          : []),
        {
          tag: "markdown",
          content: `**${escapeFeishuMarkdown(question.prompt)}**\n\n选择最符合预期的一项：`,
        },
        ...question.options.map((option) => clarificationButton(flow, option)),
        clarificationDecisionButton(flow, "current"),
        { tag: "hr" },
        {
          tag: "form",
          name: `clarify_${flow.token.slice(0, 8)}`,
          vertical_spacing: "8px",
          elements: [
            {
              tag: "input",
              name: "custom_answer",
              placeholder: { tag: "plain_text", content: "都不合适？在这里写下你的答案" },
              max_length: 500,
            },
            {
              tag: "button",
              name: "submit_custom",
              action_type: "form_submit",
              text: { tag: "plain_text", content: "提交自定义答案" },
              type: "primary",
              width: "default",
              size: "medium",
              value: {
                action: "answer_clarification",
                flowToken: flow.token,
                questionId: question.id,
                custom: true,
              },
            },
          ],
        },
        { tag: "hr" },
        {
          tag: "markdown",
          content: "不想逐项选择？Agent 会保留你已经确认的答案，并为剩余问题采用推荐方案。",
        },
        clarificationDecisionButton(flow, "remaining"),
      ],
    },
  };
}

/** 生成只展示当前问题的逐题澄清表单。 */
export function buildClarificationCard(
  options: ClarificationCardOptions,
): CardJson {
  return buildFlowClarificationCard(options.flow);
}

/** 生成逐题回答完成后立即展示的整理中状态卡。 */
export function buildClarificationContinuingCard(
  flow: ClarificationFlow,
): CardJson {
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: `${flow.request.title}：正在整理` } },
    header: { template: "blue", title: { tag: "plain_text", content: `${flow.request.title} · 正在整理` } },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      elements: [
        {
          tag: "markdown",
          content: [
            "**答案已收到**",
            "正在基于这些选择整理产品说明，无需重复点击。",
            `**已确认 ${flow.answers.length} 项**\n\n${clarificationAnswerSummary(flow)}`,
          ].join("\n\n"),
        },
      ],
    },
  };
}

/** 生成同话题文字补充后旧卡片的失效状态。 */
export function buildClarificationSupersededCard(
  flow: ClarificationFlow,
): CardJson {
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: `${flow.request.title}：已收到新的补充` } },
    header: { template: "grey", title: { tag: "plain_text", content: `${flow.request.title} · 已更新` } },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      elements: [
        {
          tag: "markdown",
          content: [
            "**已收到你在话题里的新消息**",
            "这张卡片已经失效，Agent OS 正在沿用同一个任务上下文处理新的补充。",
            flow.answers.length ? `此前已确认 ${flow.answers.length} 项，相关答案会一并带入。` : "",
          ].filter(Boolean).join("\n\n"),
        },
      ],
    },
  };
}

/** 登录卡片输入框和确认按钮的字段名；auth 插件与卡片渲染必须一致。 */
export const AUTH_INPUT_NAME = "auth_key";
export const AUTH_ACTION_NAME = "submit_auth_key";

/**
 * 生成初始登录卡：key 模式先点「开始登录」再按卡片新链接授权（不使用失败错误
 * 文本里的过期 URL）；device 模式直接点开始进入设备码流程。failureMessage 非空时
 * 追加失败原因，用户可重新开始（一次登录失败不清空流程）。
 */
export function buildAuthLoginCard(
  flow: AuthFlow,
  failureMessage?: string,
): CardJson {
  const steps =
    flow.loginMode === "device"
      ? [
          "**1** 点击下方「开始登录」；",
          "**2** 在随后出现的卡片里打开授权链接，用浏览器完成登录；",
          "**3** 授权完成后 Agent OS 自动继续，无需输入任何 key。",
        ]
      : [
          "**1** 点击下方「开始登录」；",
          "**2** 浏览器会**再次弹出**新的授权页（或使用卡片上的链接），请用**新弹出**的页面授权；",
          "**3** 把授权码粘贴到输入框并点「确认」，Agent OS 完成登录。",
        ];
  const elements: Record<string, unknown>[] = [
    {
      tag: "markdown",
      content: [
        `检测到 **${escapeFeishuMarkdown(flow.engineDisplayName)}** 尚未登录，任务无法执行。`,
        ...steps,
      ].filter(Boolean).join("\n\n"),
    },
  ];
  if (failureMessage) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "markdown",
      content: `⚠️ **登录失败**\n${escapeFeishuMarkdown(failureMessage)}`,
    });
  }
  elements.push({ tag: "hr" });
  elements.push({
    tag: "button",
    name: "submit_auth",
    text: { tag: "plain_text", content: "开始登录" },
    type: "primary",
    width: "fill",
    size: "medium",
    behaviors: [
      {
        type: "callback",
        value: {
          action: AUTH_ACTION_NAME,
          authToken: flow.token,
        },
      },
    ],
  });
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: `需要登录 ${flow.engineDisplayName}` },
    },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: `需要登录 ${flow.engineDisplayName}` },
      subtitle: { tag: "plain_text", content: "登录后才能继续执行任务" },
    },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      elements,
    },
  };
}

/**
 * 生成 key 模式登录进程就绪后的授权输入卡：展示本进程的授权链接（PKCE 绑定），
 * 用户在浏览器授权后把授权码粘贴到输入框并确认。
 * 授权链接用 markdown 代码块展示而非链接语法：飞书既不支持 <a> 组件，OAuth URL
 * 含大量 & 字符塞进 markdown 链接又会触发服务端内部错误，纯文本可原样复制最稳妥。
 */
export function buildAuthCodeCard(
  flow: AuthFlow,
  url: string,
): CardJson {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: `${flow.engineDisplayName}：等待你完成授权` },
    },
    header: {
      template: "orange",
      title: { tag: "plain_text", content: "请完成授权" },
      subtitle: { tag: "plain_text", content: flow.engineDisplayName },
    },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      elements: [
        {
          tag: "markdown",
          content:
            "请在浏览器中打开下面的链接完成登录，然后把**授权码**粘贴到输入框。\n\n_⚠️ 请务必使用本卡片上的链接授权（授权码与本次登录绑定）；如果浏览器自动弹出了其他授权页，请关闭它。_",
        },
        {
          tag: "markdown",
          content: `\`${escapeInlineCode(url)}\``,
        },
        {
          tag: "markdown",
          content: "_授权码有效期很短，请在授权完成后尽快提交。_",
        },
        {
          tag: "form",
          name: `auth_${flow.token.slice(0, 8)}`,
          vertical_spacing: "8px",
          elements: [
            {
              tag: "input",
              name: AUTH_INPUT_NAME,
              placeholder: { tag: "plain_text", content: "粘贴授权码后点击确认" },
              // 飞书 input 的 max_length 上限为 1000，超过会被拒绝。
              max_length: 1000,
            },
            {
              tag: "button",
              name: "submit_auth",
              action_type: "form_submit",
              text: { tag: "plain_text", content: "确认并登录" },
              type: "primary",
              width: "default",
              size: "medium",
              value: {
                action: AUTH_ACTION_NAME,
                authToken: flow.token,
              },
            },
          ],
        },
      ],
    },
  };
}

/** 生成提交登录 key 后立即展示的进行中状态卡。 */
export function buildAuthSubmittingCard(flow: AuthFlow): CardJson {
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: `${flow.engineDisplayName}：正在登录` } },
    header: {
      template: "orange",
      title: { tag: "plain_text", content: `正在登录 ${flow.engineDisplayName}` },
      subtitle: { tag: "plain_text", content: "请不要重复提交" },
    },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      elements: [
        {
          tag: "markdown",
          content:
            flow.loginMode === "device"
              ? "正在启动设备码登录流程，请稍候…"
              : "正在使用你提交的 key 完成登录，请稍候。\n\n_授权码有效期通常只有几分钟，超时后需要重新生成。_",
        },
      ],
    },
  };
}

/** 生成 device 登录的授权等待卡：展示授权链接与设备码，用户在浏览器完成授权。 */
export function buildAuthDeviceWaitingCard(
  flow: AuthFlow,
  url: string,
  code?: string,
): CardJson {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: `${flow.engineDisplayName}：等待浏览器授权` },
    },
    header: {
      template: "orange",
      title: { tag: "plain_text", content: `等待你完成授权` },
      subtitle: { tag: "plain_text", content: flow.engineDisplayName },
    },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      elements: [
        {
          tag: "markdown",
          content:
            "请在浏览器中打开下面的链接完成登录（建议直接用完整链接，无需手动输入设备码）：",
        },
        {
          tag: "markdown",
          content: `\`${escapeInlineCode(url)}\``,
        },
        ...(code
          ? [
              {
                tag: "markdown",
                content: `设备码：\`${escapeInlineCode(escapeFeishuMarkdown(code))}\``,
              } as Record<string, unknown>,
            ]
          : []),
        {
          tag: "markdown",
          content: "授权完成后 Agent OS 会自动继续，无需再操作。",
        },
      ],
    },
  };
}

/** 生成登录成功后的绿色终态卡；用户重新发送指令即可继续任务。 */
export function buildAuthSuccessCard(flow: AuthFlow): CardJson {
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: `${flow.engineDisplayName}：已登录` } },
    header: {
      template: "green",
      title: { tag: "plain_text", content: "登录成功" },
      subtitle: { tag: "plain_text", content: flow.engineDisplayName },
    },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      elements: [
        {
          tag: "markdown",
          content: `**${escapeFeishuMarkdown(flow.engineDisplayName)}** 已完成登录。\n\n请重新发送刚才的指令（或发送「继续执行」），任务会正常执行。`,
        },
      ],
    },
  };
}

function productDocumentList(flow: ProductSpecFlow): string {
  if (flow.request.deliveryMode === "lark-doc") {
    return `☁️ **飞书云文档** · [打开文档](${escapeFeishuMarkdownLink(flow.request.documentUrl)})`;
  }
  return [
    `📘 **Spec** · \`${escapeInlineCode(escapeFeishuMarkdown(flow.request.specPath))}\``,
    `🎫 **Tickets** · \`${escapeInlineCode(escapeFeishuMarkdown(flow.request.ticketsPath))}\``,
  ].join("\n");
}

/** 生成带确认按钮的产品文档卡；按钮只携带随机 token。 */
export function buildProductSpecApprovalCard(flow: ProductSpecFlow): CardJson {
  const elements: Record<string, unknown>[] = [
    {
      tag: "markdown",
      content: [
        `**${escapeFeishuMarkdown(flow.request.title)}**`,
        escapeFeishuMarkdown(flow.request.summary),
      ].join("\n\n"),
    },
    { tag: "hr" },
    {
      tag: "markdown",
      content: `**共享产物**\n${productDocumentList(flow)}`,
    },
    {
      tag: "button",
      text: { tag: "plain_text", content: "确认产品方案" },
      type: "primary_filled",
      width: "fill",
      size: "medium",
      behaviors: [{
        type: "callback",
        value: {
          action: "approve_product_spec",
          flowToken: flow.token,
        },
      }],
    },
    {
      tag: "markdown",
      content: "_确认后只记录“产品方案已就绪”，本节不会自动交给开发。_",
    },
  ];

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: `${flow.request.title}：待确认` },
    },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "产品文档已生成" },
      subtitle: {
        tag: "plain_text",
        content:
          flow.request.deliveryMode === "lark-doc"
            ? "飞书云文档待确认"
            : "本地 Spec · Tickets 待确认",
      },
    },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      elements,
    },
  };
}

/** 生成确认完成后的绿色终态卡。 */
export function buildProductSpecApprovedCard(
  flow: ProductSpecFlow,
): CardJson {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: `${flow.request.title}：已确认` },
    },
    header: {
      template: "green",
      title: { tag: "plain_text", content: "产品方案已确认" },
      subtitle: { tag: "plain_text", content: "产品阶段已就绪" },
    },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      elements: [{
        tag: "markdown",
        content: [
          `**${escapeFeishuMarkdown(flow.request.title)}**`,
          escapeFeishuMarkdown(flow.request.summary),
          `**已确认文档**\n${productDocumentList(flow)}`,
          flow.approvedAt
            ? `确认时间：${escapeFeishuMarkdown(flow.approvedAt)}`
            : "",
          "_本节到这里结束，不会自动派发开发任务。_",
        ].filter(Boolean).join("\n\n"),
      }],
    },
  };
}

/** 生成同一任务提交新方案后旧确认卡的失效状态。 */
export function buildProductSpecExpiredCard(
  flow: ProductSpecFlow,
): CardJson {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: `${flow.request.title}：已失效` },
    },
    header: {
      template: "grey",
      title: { tag: "plain_text", content: "产品方案确认已失效" },
    },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      elements: [{
        tag: "markdown",
        content: [
          `**${escapeFeishuMarkdown(flow.request.title)}**`,
          "同一任务已经提交了更新的产品方案，请查看话题中最新的确认卡。",
        ].join("\n\n"),
      }],
    },
  };
}

/** 生成历史 CLI 会话列表；按钮只携带 ID，真实性由入口回调重新校验。 */
export function buildResumeCard(options: ResumeCardOptions): CardJson {
  const elements: Record<string, unknown>[] = options.sessions.length
    ? options.sessions.flatMap((session, index) => {
        const current = session.id === options.currentCliSessionId;
        const row: Record<string, unknown> = {
          tag: "column_set",
          flex_mode: "none",
          horizontal_spacing: "12px",
          columns: [
            {
              tag: "column",
              width: "weighted",
              weight: 4,
              elements: [
                {
                  tag: "markdown",
                  content: `**${escapeFeishuMarkdown(session.title)}**\n_${formatSessionTime(session.updatedAt)} · ${escapeInlineCode(session.id.slice(0, 8))}_`,
                },
              ],
            },
            {
              tag: "column",
              width: "auto",
              vertical_align: "center",
              elements: current
                ? [{ tag: "markdown", content: "**当前会话**" }]
                : [
                    {
                      tag: "button",
                      text: { tag: "plain_text", content: "恢复" },
                      type: "primary_filled",
                      size: "medium",
                      behaviors: [
                        {
                          type: "callback",
                          value: {
                            action: "resume_cli_session",
                            agentSessionId: options.agentSessionId,
                            cliSessionId: session.id,
                          },
                        },
                      ],
                    },
                  ],
            },
          ],
        };
        return index === options.sessions.length - 1
          ? [row]
          : [row, { tag: "hr" }];
      })
    : [
        {
          tag: "markdown",
          content:
            "当前工作目录里还没有可以恢复的 CLI 会话。先完成一次任务，再用 `/new` 开启新会话。",
        },
      ];

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: `${options.cliName}：选择历史会话` },
    },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "恢复历史会话" },
      subtitle: { tag: "plain_text", content: options.cliName },
    },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      elements: [
        { tag: "markdown", content: "选择后，当前话题会继续使用对应的 CLI 上下文。" },
        ...elements,
      ],
    },
  };
}

/** 生成 /new 或 compact 完成后的轻量终态卡片。 */
export function buildSessionNoticeCard(
  options: SessionNoticeCardOptions,
): CardJson {
  return {
    schema: "2.0",
    config: { summary: { content: options.title } },
    header: {
      template: options.template ?? "blue",
      title: { tag: "plain_text", content: options.title },
    },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      elements: [{ tag: "markdown", content: escapeFeishuMarkdown(options.detail) }],
    },
  };
}

/** 生成交接说明卡片；真正触达目标 bot 的 @ 由独立 post 消息完成。 */
export function buildCollaborationCard(
  options: CollaborationCardOptions,
): CardJson {
  const isLastRound = options.round >= options.maxRounds;
  const title = "协作任务已派发";
  const footer = isLastRound
    ? `这是当前任务允许的最后一次交接；结果会通知 ${options.reportToName}，由其决定下一步。`
    : `完成后，结果会自动交回 ${options.reportToName} 继续组织后续工作。`;
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: {
        content: `${title}：${options.senderName} → ${options.targetName}`,
      },
    },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: title },
      subtitle: {
        tag: "plain_text",
        content: `${options.senderName} → ${options.targetName}`,
      },
    },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      elements: [
        {
          tag: "markdown",
          content: `**${escapeFeishuMarkdown(options.objective)}**\n\n${options.targetName}，请按下方说明完成当前协作任务。`,
        },
        {
          tag: "column_set",
          flex_mode: "none",
          horizontal_spacing: "16px",
          columns: [
            {
              tag: "column",
              width: "weighted",
              weight: 3,
              elements: [
                {
                  tag: "markdown",
                  content: `**项目**\n${escapeFeishuMarkdown(options.workspaceName)}`,
                },
              ],
            },
            {
              tag: "column",
              width: "weighted",
              weight: 2,
              elements: [
                {
                  tag: "markdown",
                  content: `**结果交给**\n${escapeFeishuMarkdown(options.reportToName)}`,
                },
              ],
            },
          ],
        },
        {
          tag: "collapsible_panel",
          expanded: false,
          header: collapsibleHeader("查看任务说明"),
          vertical_spacing: "8px",
          padding: "8px 8px 8px 8px",
          elements: [
            {
              tag: "markdown",
              content: escapeFeishuMarkdown(
                markdownPreview(options.instruction, MAX_CARD_ANSWER_LENGTH),
              ),
            },
            ...(options.expectedOutput
              ? [
                  {
                    tag: "markdown",
                    content: `**期望产出**\n${escapeFeishuMarkdown(options.expectedOutput)}`,
                  },
                ]
              : []),
          ],
        },
        { tag: "hr" },
        {
          tag: "markdown",
          content: `_${footer}_`,
        },
      ],
    },
  };
}

export function buildTeamCard(options: TeamCardOptions): CardJson {
  const leader = options.members.find((member) => member.isLeader);
  const memberElements = options.members.map((member) => {
    const badges = [
      member.isLeader ? "Team Leader" : "",
      member.ready ? "已连接" : "未连接",
    ]
      .filter(Boolean)
      .join(" · ");
    const skills =
      member.skills.length > 0
        ? member.skills.map((skill) => `$${skill}`).join("、")
        : "无";
    return {
      tag: "markdown",
      content: [
        `**${escapeFeishuMarkdown(member.displayName)}**  _${badges}_`,
        escapeFeishuMarkdown(member.role),
        `引擎：${escapeFeishuMarkdown(member.cliName)}　Skill：${escapeFeishuMarkdown(skills)}`,
      ].join("\n"),
    };
  });

  return {
    schema: "2.0",
    config: {
      summary: { content: `Agent 团队：${options.members.length} 位成员` },
    },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "Agent 团队" },
      subtitle: {
        tag: "plain_text",
        content: leader
          ? `${options.members.length} 位成员 · ${leader.displayName} 负责统筹`
          : `${options.members.length} 位成员`,
      },
    },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      elements: [
        {
          tag: "markdown",
          content:
            "每位成员使用自己的飞书身份、执行引擎和项目 Skill，工作目录与会话彼此独立。",
        },
        { tag: "hr" },
        ...memberElements,
      ],
    },
  };
}

const SUBTASK_STATUS_LABEL = {
  pending: "⏳ 等待",
  done: "✅ 完成",
  failed: "❌ 失败",
} as const;

/** 编排面板卡片：展示每次 /orchestrate 的并行子任务进度与结果摘要。 */
export function buildOrchestrationPanelCard(
  options: OrchestrationPanelOptions,
): CardJson {
  if (!options.runs.length) {
    return {
      schema: "2.0",
      config: { summary: { content: "编排面板：暂无运行" } },
      header: {
        template: "blue",
        title: { tag: "plain_text", content: "编排面板" },
      },
      body: {
        direction: "vertical",
        vertical_spacing: "12px",
        elements: [
          {
            tag: "markdown",
            content:
              "还没有编排运行。用 `/orchestrate <任务>` 启动一次并行编排。",
          },
        ],
      },
    };
  }

  const maxRetry = options.maxRetry ?? 0;
  const runElements = options.runs
    .flatMap((run) => {
      const done = run.subTasks.filter((sub) => sub.status === "done").length;
      const subElements = run.subTasks.flatMap((sub) => {
        const detail =
          sub.status === "done" && sub.answer
            ? `\n${escapeFeishuMarkdown(markdownPreview(sub.answer, 200))}`
            : sub.status === "failed" && sub.error
              ? `\n_${escapeFeishuMarkdown(sub.error)}_`
              : "";
        const markdown = {
          tag: "markdown",
          content: `${SUBTASK_STATUS_LABEL[sub.status]} **#${escapeFeishuMarkdown(sub.id)}**［${escapeFeishuMarkdown(sub.targetBotId)}］\n${escapeFeishuMarkdown(sub.prompt)}${detail}`,
        };
        // 仅失败且未达上限的子任务渲染「重试」按钮；maxRetry=0（actions 插件下线）不渲染。
        if (sub.status === "failed" && maxRetry > 0 && sub.retryCount < maxRetry) {
          return [
            markdown,
            {
              tag: "button",
              text: { tag: "plain_text", content: "重试" },
              type: "default",
              width: "default",
              size: "medium",
              behaviors: [
                {
                  type: "callback",
                  value: {
                    action: "retry_subtask",
                    runId: run.runId,
                    subTaskId: sub.id,
                    // 每次渲染生成一次性令牌：服务侧按 run 实例标识完整校验后消费，拒绝重复点击。
                    retryToken: retryToken(run.instanceId, sub.id, newRetryNonce()),
                  },
                },
              ],
            },
          ];
        }
        return [markdown];
      });
      return [
        {
          tag: "markdown",
          content: `**${run.runId}** · ${done}/${run.subTasks.length} 完成\n_${escapeFeishuMarkdown(markdownPreview(run.prompt, 120))}_`,
        },
        ...subElements,
        { tag: "hr" },
      ];
    })
    .slice(0, -1);

  return {
    schema: "2.0",
    config: {
      summary: { content: `编排面板：${options.runs.length} 个运行` },
    },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "编排面板" },
      subtitle: {
        tag: "plain_text",
        content: `${options.runs.length} 个运行`,
      },
    },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      elements: [
        { tag: "markdown", content: "并行子任务进度一览。" },
        { tag: "hr" },
        ...runElements,
      ],
    },
  };
}

export function answerNeedsContinuation(answer: string): boolean {
  return answer.length > MAX_CARD_ANSWER_LENGTH;
}

export function answerContinuation(answer: string): string {
  return answer.slice(markdownSplitIndex(answer, MAX_CARD_ANSWER_LENGTH));
}

/** 把卡片之外的长答案切成适合飞书文本消息的非空片段。 */
export function splitLongText(text: string, maxLength = 4_000): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    const newline = remaining.lastIndexOf("\n", maxLength);
    const splitAt = newline > maxLength / 2 ? newline : maxLength;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

type UpdateCard = (card: CardJson) => Promise<void>;

/** 一秒窗口内无论 push 多少次，只串行提交最新的一张卡片。 */
export class ThrottledCardUpdater {
  private pendingCard: CardJson | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private updateChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly updateCard: UpdateCard,
    private readonly intervalMs = 1_000,
  ) {}

  push(card: CardJson): void {
    if (this.closed) return;
    this.pendingCard = card;
    this.schedule();
  }

  async finish(finalCard: CardJson): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pendingCard = undefined;
    // 中间更新失败不应阻止最终状态覆盖运行中卡片。
    await this.updateChain.catch(() => undefined);
    await this.updateCard(finalCard);
  }

  async cancel(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pendingCard = undefined;
    await this.updateChain.catch(() => undefined);
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

    // Promise 链防止 patch 响应乱序；吞掉中间失败后仍允许后续或最终更新。
    this.updateChain = this.updateChain
      .catch(() => undefined)
      .then(() => this.updateCard(card))
      .catch(() => undefined)
      .finally(() => {
        if (this.pendingCard && !this.closed) this.schedule();
      });
  }
}
