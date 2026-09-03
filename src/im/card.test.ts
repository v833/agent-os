/**
 * 飞书任务卡片测试：覆盖四种生命周期视图、多引擎工具信息、
 * 上下文口径、长答案拆分，以及节流更新的串行与唯一终态。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { TaskProgressSnapshot } from "../core/task-progress.js";
import {
  answerContinuation,
  answerNeedsContinuation,
  buildAuthCodeCard,
  buildAuthLoginCard,
  buildAuthSubmittingCard,
  buildAuthDeviceWaitingCard,
  buildAuthSuccessCard,
  buildBoardConflictCard,
  buildBoardDegradedCard,
  buildBoardErrorCard,
  buildBoardInitProgressCard,
  buildBoardReadyCard,
  buildClarificationCard,
  buildClarificationContinuingCard,
  buildClarificationSupersededCard,
  buildCollaborationCard,
  buildOrchestrationPanelCard,
  buildProductSpecApprovalCard,
  buildProductSpecApprovedCard,
  buildProductSpecExpiredCard,
  buildResumeCard,
  buildSessionNoticeCard,
  buildTaskCard,
  buildTeamCard,
  splitLongText,
  ThrottledCardUpdater,
} from "./card.js";
import type { AuthFlow } from "../core/cli-auth.js";
import type { OrchestrationRun } from "../core/orchestration.js";

function progress(
  overrides: Partial<TaskProgressSnapshot> = {},
): TaskProgressSnapshot {
  return {
    current: "运行命令",
    currentToolName: "command_execution",
    currentDetail: "pnpm `test`",
    elapsedMs: 1_540,
    toolCount: 2,
    completedCount: 1,
    activities: [
      {
        toolName: "command_execution",
        label: "运行命令",
        detail: "pnpm build",
        durationMs: 1_200,
        failed: false,
      },
    ],
    contextStartTokens: 1_000,
    contextUsedTokens: 1_500,
    contextWindowTokens: 10_000,
    ...overrides,
  };
}

test("运行中卡片展示 Codex 进度、上下文、轨迹和安全停止参数", () => {
  const card = buildTaskCard({
    title: "Codex",
    status: "running",
    detail: "正在理解任务",
    progress: progress(),
    abortSessionId: "session-1",
    abortRunId: "run-1",
  }) as any;

  assert.equal(card.schema, "2.0");
  assert.equal(card.config.update_multi, true);
  assert.equal(card.header.template, "blue");
  assert.equal(card.header.title.content, "Codex · 执行中");
  assert.match(card.body.elements[0].content, /⌘ 运行命令/);
  assert.match(card.body.elements[0].content, /pnpm ˋtestˋ/);
  assert.match(card.body.elements[0].content, /2 秒 · 2 次工具调用/);
  assert.match(card.body.elements[0].content, /1\.5k \/ 10k（15%）/);
  assert.match(card.body.elements[0].content, /本轮开始 1k · 新增 500/);
  assert.match(card.body.elements[1].content, /最近完成（1 \/ 1）/);
  assert.deepEqual(card.body.elements[2].behaviors[0].value, {
    action: "abort_task",
    sessionId: "session-1",
    runId: "run-1",
  });
});
test("新 CLI 会话使用新会话基础口径且缺少 runId 时不渲染停止按钮", () => {
  const card = buildTaskCard({
    title: "Claude Code",
    status: "running",
    detail: "正在理解任务",
    progress: progress({ startedNewSession: true }),
    abortSessionId: "session-1",
  }) as any;

  assert.match(card.body.elements[0].content, /新会话基础 1k · 新增 500/);
  assert.equal(card.body.elements.some((element: any) => element.tag === "button"), false);
});

test("成功卡片把答案置顶并转义伪标签", () => {
  const card = buildTaskCard({
    title: "Claude Code",
    status: "success",
    detail: "执行完成",
    progress: progress(),
    answer: "完成 <at id=ou_fake></at>",
    stats: {
      durationMs: 2_500,
      totalTokens: 2_048,
      contextWindowTokens: 10_000,
    },
  }) as any;

  assert.equal(card.header.template, "green");
  assert.match(card.body.elements[0].content, /<&zwj;at id=ou_fake>/);
  assert.equal(
    card.body.elements.some(
      (element: any) =>
        element.tag === "collapsible_panel" &&
        element.header.title.content === "执行详情",
    ),
    true,
  );
  assert.doesNotMatch(JSON.stringify(card), /发送给/);
});

test("长回答生成安全预览、折叠全文并把超限部分切成文本块", () => {
  const answer = `${"详细说明。".repeat(220)}\n\n\`\`\`typescript\n${"const value = 1;\n".repeat(300)}\`\`\``;
  const card = buildTaskCard({
    title: "Codex",
    status: "success",
    detail: "执行完成",
    answer,
  }) as any;

  assert.equal(answerNeedsContinuation(answer), true);
  assert.match(card.body.elements[0].content, /完整回答已收起/);
  const fullAnswerPanel = card.body.elements.find(
    (element: any) => element.header?.title?.content === "查看完整回答",
  );
  assert.ok(fullAnswerPanel);
  assert.ok(fullAnswerPanel.elements[0].content.length <= 6_010);
  const chunks = splitLongText(answerContinuation(answer));
  assert.ok(chunks.length >= 1);
  assert.equal(chunks.every((chunk) => chunk.length <= 4_000), true);
  assert.equal(chunks.every(Boolean), true);
});

test("失败卡片在提供 retryAction 时渲染重试任务按钮", () => {
  const cardWithRetry = buildTaskCard({
    title: "Claude (ACP)",
    status: "failed",
    detail: "执行没有完成。你可以点击下方按钮重试。",
    technicalDetail: "API Error: 402",
    retryAction: {
      sessionId: "session-402",
      retryToken: "token-402",
    },
  }) as any;

  const retryButton = cardWithRetry.body.elements.find(
    (el: any) => el.tag === "button" && el.text?.content === "重试任务",
  );
  assert.ok(retryButton, "应渲染重试任务按钮");
  assert.equal(retryButton.type, "primary");
  assert.deepEqual(retryButton.behaviors[0]?.value, {
    action: "retry_task",
    sessionId: "session-402",
    retryToken: "token-402",
  });
});

test("失败与取消卡片使用独立样式并折叠技术错误", () => {
  const failed = buildTaskCard({
    title: "Codex",
    status: "failed",
    detail: "执行没有完成。你可以重试。",
    technicalDetail: "exit code 1",
    progress: progress(),
  }) as any;
  const cancelled = buildTaskCard({
    title: "Claude Code",
    status: "cancelled",
    detail: "本次任务已停止。",
    progress: progress(),
  }) as any;

  assert.equal(failed.header.template, "red");
  assert.equal(failed.body.elements[1].header.title.content, "查看错误详情");
  assert.match(failed.body.elements[1].elements[0].content, /exit code 1/);
  assert.equal(cancelled.header.template, "grey");
  assert.equal(cancelled.header.title.content, "Claude Code · 已取消");
});

test("累计上下文超过窗口时不伪造上下文百分比", () => {
  const card = buildTaskCard({
    title: "Claude Code",
    status: "success",
    detail: "完成",
    answer: "完成",
    stats: { totalTokens: 260_000, contextWindowTokens: 200_000 },
  }) as any;
  const serialized = JSON.stringify(card);

  assert.match(serialized, /累计消耗/);
  assert.doesNotMatch(serialized, /当前上下文/);
});

test("澄清卡片逐题展示选项、自定义输入和已确认答案", () => {
  const flow: any = {
    token: "clarify-token",
    taskId: "task-1",
    botId: "product",
    sessionId: "session-1",
    ownerOpenId: "ou_owner",
    originalMessageId: "om_root",
    requestedPrompt: "增加优先级",
    replyInThread: true,
    currentIndex: 0,
    answers: [],
    request: {
    title: "确认范围",
    intro: "请选择实现方式。",
    questions: [
      {
        id: "priority",
        prompt: "优先级支持几档？",
        recommendedOptionId: "three",
        options: [
          { id: "three", label: "三档" },
          { id: "custom", label: "自定义" },
        ],
      },
      {
        id: "entry",
        prompt: "从哪里进入？",
        recommendedOptionId: "list",
        options: [
          { id: "list", label: "列表" },
          { id: "menu", label: "菜单" },
        ],
      },
    ],
    },
  };
  const waiting = buildClarificationCard({ flow }) as any;
  const serialized = JSON.stringify(waiting);
  assert.match(serialized, /优先级支持几档/);
  assert.doesNotMatch(serialized, /从哪里进入/);
  assert.match(serialized, /三档（推荐）/);
  assert.match(serialized, /按推荐方案继续/);
  const form = waiting.body.elements.find((element: any) => element.tag === "form");
  assert.equal(form.tag, "form");
  assert.equal(form.elements[0].name, "custom_answer");
  assert.deepEqual(form.elements[1].value, {
    action: "answer_clarification",
    flowToken: "clarify-token",
    questionId: "priority",
    custom: true,
  });

  flow.currentIndex = 1;
  flow.answers.push({
    questionId: "priority",
    prompt: "优先级支持几档？",
    answer: "三档",
    source: "user",
  });
  const next = JSON.stringify(buildClarificationCard({ flow }));
  assert.match(next, /已确认 1 项/);
  assert.match(next, /从哪里进入/);
  assert.match(JSON.stringify(buildClarificationContinuingCard(flow)), /正在整理/);
  assert.match(JSON.stringify(buildClarificationSupersededCard(flow)), /已更新/);
});

test("恢复卡片展示历史会话并为非当前记录生成安全回调参数", () => {
  const card = buildResumeCard({
    agentSessionId: "agent-session",
    cliName: "Codex",
    currentCliSessionId: "thread-current",
    sessions: [
      {
        id: "thread-current",
        title: "当前任务",
        updatedAt: "2026-08-11T10:00:00.000Z",
      },
      {
        id: "thread-other",
        title: "检查 <at id=ou_fake></at>",
        updatedAt: "2026-08-10T10:00:00.000Z",
      },
    ],
  }) as any;

  assert.equal(card.header.title.content, "恢复历史会话");
  assert.match(card.body.elements[1].columns[1].elements[0].content, /当前会话/);
  const otherRow = card.body.elements[3];
  assert.deepEqual(
    otherRow.columns[1].elements[0].behaviors[0].value,
    {
      action: "resume_cli_session",
      agentSessionId: "agent-session",
      cliSessionId: "thread-other",
    },
  );
  assert.match(otherRow.columns[0].elements[0].content, /<&zwj;at/);
});

test("会话提示卡片使用指定状态颜色", () => {
  const card = buildSessionNoticeCard({
    title: "上下文已整理",
    detail: "CLI 会话 ID 保持不变",
    template: "green",
  }) as any;
  assert.equal(card.header.template, "green");
  assert.match(card.body.elements[0].content, /CLI 会话 ID/);
});

const productSpecFlow = {
  token: "product-spec-token",
  taskId: "task-1",
  botId: "product",
  sessionId: "session-1",
  ownerOpenId: "ou_owner",
  workspaceDir: "C:\\workspace",
  documentRevision: "revision-1",
  request: {
    title: "用户 <at id=ou_fake></at> 详情页",
    summary: "只读展示基础信息。",
    deliveryMode: "local",
    specPath: ".scratch/user-detail/spec.md",
    ticketsPath: ".scratch/user-detail/issues",
  },
  status: "pending",
} as const;

test("产品文档待确认卡展示转义路径并携带确认按钮", () => {
  const card = buildProductSpecApprovalCard(productSpecFlow) as any;

  assert.equal(card.header.template, "blue");
  assert.equal(card.header.title.content, "产品文档已生成");
  assert.match(JSON.stringify(card), /<&zwj;at id=ou_fake>/);
  assert.match(JSON.stringify(card), /\.scratch\/user-detail\/spec\.md/);
  assert.equal(
    card.body.elements.some((element: any) => element.tag === "button"),
    true,
  );
});

test("飞书产品文档卡只展示云文档入口", () => {
  const card = buildProductSpecApprovalCard({
    ...productSpecFlow,
    documentRevision: undefined,
    request: {
      title: "用户详情页",
      summary: "只读展示基础信息。",
      deliveryMode: "lark-doc",
      documentUrl: "https://example.feishu.cn/docx/AbCdEf123)(next",
    },
  }) as any;
  const serialized = JSON.stringify(card);

  assert.equal(card.header.subtitle.content, "飞书云文档待确认");
  assert.match(serialized, /打开文档/);
  assert.match(
    serialized,
    /https:\/\/example\.feishu\.cn\/docx\/AbCdEf123%29%28next/,
  );
  assert.doesNotMatch(serialized, /spec\.md|Tickets.*issues/);
});

test("产品文档已确认和已失效卡分别展示终态", () => {
  const approved = buildProductSpecApprovedCard({
    ...productSpecFlow,
    status: "approved",
    approvedAt: "2026-08-21T00:00:00.000Z",
  }) as any;
  const expired = buildProductSpecExpiredCard({
    ...productSpecFlow,
    status: "expired",
  }) as any;

  assert.equal(approved.header.template, "green");
  assert.match(JSON.stringify(approved), /2026-08-21T00:00:00.000Z/);
  assert.equal(expired.header.template, "grey");
  assert.match(JSON.stringify(expired), /已经提交了更新的产品方案/);
});

test("交接卡片展示来源、目标、编排者和任务说明", () => {
  const card = buildCollaborationCard({
    senderName: "开发助手",
    targetName: "审查助手",
    reportToName: "CEO 助理",
    workspaceName: "example-project",
    objective: "检查实现",
    instruction: "请检查 <at id=ou_fake></at> 的实现",
    expectedOutput: "给出审查结论",
    round: 1,
    maxRounds: 2,
  }) as any;

  assert.equal(card.header.title.content, "协作任务已派发");
  assert.match(card.config.summary.content, /开发助手.*审查助手/);
  assert.match(JSON.stringify(card), /example-project/);
  assert.match(JSON.stringify(card), /CEO 助理/);
  assert.match(JSON.stringify(card), /给出审查结论/);
  assert.match(JSON.stringify(card), /<&zwj;at id=ou_fake>/);
});

test("最后一轮交接卡片展示收口提示", () => {
  const card = buildCollaborationCard({
    senderName: "审查助手",
    targetName: "开发助手",
    reportToName: "CEO 助理",
    workspaceName: "example-project",
    objective: "修复审查问题",
    instruction: "请修复审查指出的问题",
    round: 2,
    maxRounds: 2,
  }) as any;

  assert.equal(card.header.title.content, "协作任务已派发");
  assert.match(card.config.summary.content, /审查助手.*开发助手/);
  assert.match(JSON.stringify(card), /最后一次交接/);
  assert.match(JSON.stringify(card), /查看任务说明/);
});

test("节流窗口只提交最新卡片并把最终更新严格排在在途更新之后", async () => {
  const updates: number[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  let releaseFirst: (() => void) | undefined;
  const firstUpdateStarted = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let notifyStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const updater = new ThrottledCardUpdater(async (card) => {
    const version = (card as { version: number }).version;
    updates.push(version);
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    if (version === 2) {
      notifyStarted?.();
      await firstUpdateStarted;
    }
    concurrent -= 1;
  }, 5);

  updater.push({ version: 1 });
  updater.push({ version: 2 });
  await started;
  updater.push({ version: 3 });
  const finishing = updater.finish({ version: 9 });
  releaseFirst?.();
  await finishing;

  assert.deepEqual(updates, [2, 9]);
  assert.equal(maxConcurrent, 1);
  updater.push({ version: 10 });
  assert.deepEqual(updates, [2, 9]);
});

test("中间更新失败后 finish 仍会尝试提交最终卡片", async () => {
  const updates: number[] = [];
  const updater = new ThrottledCardUpdater(async (card) => {
    const version = (card as { version: number }).version;
    updates.push(version);
    if (version === 1) throw new Error("临时更新失败");
  }, 1);

  updater.push({ version: 1 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await updater.finish({ version: 2 });

  assert.deepEqual(updates, [1, 2]);
});

test("cancel 丢弃待发送状态并阻止之后的 push 与 finish", async () => {
  const updates: number[] = [];
  const updater = new ThrottledCardUpdater(async (card) => {
    updates.push((card as { version: number }).version);
  }, 5);

  updater.push({ version: 1 });
  await updater.cancel();
  updater.push({ version: 2 });
  await updater.finish({ version: 3 });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(updates, []);
});

test("团队卡片展示成员职责、引擎、Skill 与连接状态", () => {
  const card = buildTeamCard({
    members: [
      {
        id: "ceo-assistant",
        displayName: "CEO 助理",
        role: "CEO 助理，负责理解目标、组织成员并汇总团队结论",
        cliName: "Claude Code",
        skills: [],
        isLeader: true,
        ready: true,
      },
      {
        id: "product",
        displayName: "产品经理",
        role: "产品经理，负责澄清需求",
        cliName: "Claude Code",
        skills: ["grill-me"],
        isLeader: false,
        ready: false,
      },
    ],
  });
  const text = JSON.stringify(card);
  assert.ok(text.includes("Agent 团队"), "卡片标题为 Agent 团队");
  assert.ok(text.includes("CEO 助理 负责统筹"), "副标题说明负责人统筹");
  assert.ok(text.includes("Team Leader"), "负责人带 Team Leader 徽标");
  assert.ok(text.includes("已连接"), "在线成员显示已连接");
  assert.ok(text.includes("未连接"), "离线成员显示未连接");
  assert.ok(text.includes("$grill-me"), "展示项目 Skill");
  assert.ok(text.includes("Claude Code"), "展示默认执行引擎");
});

/** 构造编排 run：ownerOpenId 固定为发起人，子任务携带状态与重试次数。 */
function orchestrationRun(
  runId: string,
  subTasks: Array<{
    id: string;
    status: "pending" | "done" | "failed";
    retryCount?: number;
  }>,
): OrchestrationRun {
  return {
    runId,
    // 卡片重试令牌按 run 实例标识生成，测试用固定假实例即可验证绑定关系。
    instanceId: `instance-${runId}`,
    prompt: `任务 ${runId}`,
    ownerOpenId: "ou_owner",
    chatId: "chat1",
    botId: "testbot",
    startedAt: new Date().toISOString(),
    subTasks: subTasks.map((sub) => ({
      id: sub.id,
      prompt: `子任务 ${sub.id}`,
      targetBotId: "developer",
      status: sub.status,
      retryCount: sub.retryCount ?? 0,
      attempt: 0,
    })),
  };
}

/** 从编排面板卡片中取出全部「重试」按钮的 value。 */
function retryValuesOf(
  card: Record<string, unknown>,
): Record<string, unknown>[] {
  const elements = (card.body as { elements?: unknown[] } | undefined)
    ?.elements ?? [];
  const values: Record<string, unknown>[] = [];
  for (const element of elements) {
    const behaviors = (element as { behaviors?: { value?: unknown }[] })
      ?.behaviors ?? [];
    for (const behavior of behaviors) {
      const value = behavior.value;
      if (
        typeof value === "object" &&
        value !== null &&
        (value as { action?: string }).action === "retry_subtask"
      ) {
        values.push(value as Record<string, unknown>);
      }
    }
  }
  return values;
}

test("失败子任务渲染「重试」按钮且 value 携带 runId/subTaskId/retryToken", () => {
  const card = buildOrchestrationPanelCard({
    runs: [orchestrationRun("run-001", [{ id: "t1", status: "failed" }])],
    maxRetry: 2,
  });
  const values = retryValuesOf(card);
  assert.equal(values.length, 1, "失败子任务应渲染一个重试按钮");
  assert.equal(values[0].runId, "run-001");
  assert.equal(values[0].subTaskId, "t1");
  // 令牌绑定 run 实例标识而非展示编号，跨进程重启后旧令牌无法命中新 run。
  assert.match(String(values[0].retryToken), /^instance-run-001:t1:/);
});

test("达到重试上限的失败子任务不再渲染重试按钮", () => {
  const card = buildOrchestrationPanelCard({
    runs: [
      orchestrationRun("run-001", [{ id: "t1", status: "failed", retryCount: 2 }]),
    ],
    maxRetry: 2,
  });
  assert.deepEqual(retryValuesOf(card), [], "retryCount 达上限不能渲染按钮");
});

test("非 failed 子任务不渲染重试按钮", () => {
  const card = buildOrchestrationPanelCard({
    runs: [
      orchestrationRun("run-001", [
        { id: "t1", status: "done" },
        { id: "t2", status: "pending" },
      ]),
    ],
    maxRetry: 2,
  });
  assert.deepEqual(retryValuesOf(card), [], "非失败子任务不能渲染重试按钮");
});

test("maxRetry 缺省或为 0 时不渲染重试按钮（actions 下线降级）", () => {
  const failed = orchestrationRun("run-001", [
    { id: "t1", status: "failed" },
  ]);
  assert.deepEqual(
    retryValuesOf(buildOrchestrationPanelCard({ runs: [failed] })),
    [],
    "maxRetry 缺省时不能渲染重试按钮",
  );
  assert.deepEqual(
    retryValuesOf(buildOrchestrationPanelCard({ runs: [failed], maxRetry: 0 })),
    [],
    "maxRetry=0 时不能渲染重试按钮",
  );
});

function authFlow(loginMode: "key" | "device"): AuthFlow {
  return {
    token: "tok12345678",
    botId: "b",
    engineId: "agy",
    engineDisplayName: "Antigravity",
    accessMode: "headless",
    sessionId: "s",
    ownerOpenId: "o",
    originalMessageId: "m",
    replyInThread: false,
    workspaceDir: ".",
    loginUrl: "https://accounts.google.com/oauth",
    errorMessage: "",
    loginMode,
    status: "awaiting-key",
  };
}

test("登录卡 markdown content 只含字符串，卡片 JSON 对飞书合法", () => {
  // 回归保护：曾把 {tag:hr} 对象混进 markdown content 导致飞书 400。
  for (const mode of ["key", "device"] as const) {
    const card = buildAuthLoginCard(authFlow(mode), "authentication timed out");
    const body = card.body as { elements: Array<Record<string, unknown>> };
    const markdowns = body.elements.filter(
      (element) => element.tag === "markdown",
    );
    assert.ok(markdowns.length >= 1, `${mode} 模式应有说明文本`);
    for (const element of markdowns) {
      assert.equal(
        typeof element.content,
        "string",
        `${mode} 模式 markdown content 必须是字符串`,
      );
    }
    assert.ok(
      body.elements.some((element) => element.tag === "button"),
      `${mode} 模式初始卡应提供「开始登录」按钮`,
    );
  }
});

test("授权输入卡（key 模式两步流程）含 URL 纯文本、输入框与确认按钮", () => {
  const card = buildAuthCodeCard(authFlow("key"), "https://accounts.google.com/o/oauth2/auth?x=1&y=2");
  const body = card.body as { elements: Array<Record<string, unknown>> };
  // 授权链接必须是纯文本：飞书不支持 <a> 组件，markdown 链接里的 & 又会触发
  // 服务端内部错误，只有代码块纯文本能稳定展示。
  assert.equal(
    body.elements.some((e) => e.tag === "a"),
    false,
    "不能使用 <a> 组件",
  );
  const urls = body.elements
    .filter((e) => e.tag === "markdown")
    .map((e) => String(e.content));
  assert.ok(
    urls.some((content) => content.includes("https://accounts.google.com/o/oauth2/auth?x=1&y=2")),
    "授权链接应以纯文本展示",
  );
  const form = body.elements.find((e) => e.tag === "form") as {
    elements: Array<Record<string, unknown>>;
  };
  assert.ok(form, "授权输入卡应有表单");
  assert.equal(
    form.elements.some((e) => e.tag === "input"),
    true,
    "应有授权码输入框",
  );
  assert.equal(
    form.elements.some((e) => e.tag === "button"),
    true,
    "应有确认按钮",
  );
});

test("登录相关卡片均能生成且结构完整", () => {
  const flow = authFlow("key");
  const submitting = buildAuthSubmittingCard(flow);
  const deviceWaiting = buildAuthDeviceWaitingCard(flow, "https://dimagent.cn/device", "Y4WW-BKV2");
  const success = buildAuthSuccessCard(flow);
  assert.equal(JSON.stringify(submitting).length > 0, true);
  assert.equal(JSON.stringify(deviceWaiting).length > 0, true);
  assert.equal(JSON.stringify(success).length > 0, true);
});

test("任务看板初始化进行中卡片结构合法且含步骤说明", () => {
  const card = buildBoardInitProgressCard({ name: "研发任务看板" });
  assert.equal(card.schema, "2.0");
  const header = card.header as { template: string; title: { content: string }; subtitle?: { content: string } };
  assert.equal(header.template, "blue");
  assert.ok(header.title.content.includes("正在创建任务看板"));
  assert.equal(header.subtitle?.content, "研发任务看板");

  const body = card.body as { elements: Array<{ tag: string; content?: string }> };
  const md = body.elements.find((e) => e.tag === "markdown");
  assert.ok(md?.content?.includes("创建多维表格应用"));
  assert.ok(md?.content?.includes("配置 10 个标准业务字段"));
});

test("任务看板就绪卡片结构合法且含链接、表格ID与直达按钮", () => {
  const card = buildBoardReadyCard({
    name: "研发任务看板",
    url: "https://feishu.cn/base/bascn123456",
    appToken: "bascn123456",
    tableId: "tbl987654",
  });
  assert.equal(card.schema, "2.0");
  const header = card.header as { template: string; title: { content: string }; subtitle?: { content: string } };
  assert.equal(header.template, "green");
  assert.ok(header.title.content.includes("已就绪"));

  const body = card.body as { elements: Array<{ tag: string; content?: string; url?: string }> };
  const mdList = body.elements.filter((e) => e.tag === "markdown");
  const allText = mdList.map((m) => m.content).join("\n");
  assert.ok(allText.includes("tbl987654"));
  assert.ok(allText.includes("https://feishu.cn/base/bascn123456"));
  assert.ok(allText.includes("待处理"));

  const button = body.elements.find(
    (e) => e.tag === "button" && e.url === "https://feishu.cn/base/bascn123456",
  );
  assert.ok(button, "应包含直达多维表格的按钮");
});

test("任务看板错误卡片正确展示错误信息与 403 权限指引", () => {
  const permErrorCard = buildBoardErrorCard({
    error: "403 Forbidden: bitable:app 权限不足",
    isPermissionError: true,
  });
  const header = permErrorCard.header as { template: string };
  assert.equal(header.template, "red");
  const body = permErrorCard.body as { elements: Array<{ tag: string; content?: string }> };
  const content = body.elements.find((e) => e.tag === "markdown")?.content ?? "";
  assert.ok(content.includes("bitable:app"));
  assert.ok(content.includes("open.feishu.cn"));

  const genericErrorCard = buildBoardErrorCard({
    error: "网络超时",
    isPermissionError: false,
  });
  const genericContent = (genericErrorCard.body as { elements: Array<{ tag: string; content?: string }> }).elements.find((e) => e.tag === "markdown")?.content ?? "";
  assert.ok(genericContent.includes("网络超时"));
  assert.ok(!genericContent.includes("open.feishu.cn"));
});

test("任务看板冲突提醒卡片展示已有看板信息与 force 参数提示", () => {
  const card = buildBoardConflictCard({
    name: "已有看板",
    url: "https://feishu.cn/base/bascnExisting",
    tableId: "tblExisting",
  });
  assert.equal(card.schema, "2.0");
  const header = card.header as { template: string };
  assert.equal(header.template, "orange");
  const body = card.body as { elements: Array<{ tag: string; content?: string }> };
  const content = body.elements.find((e) => e.tag === "markdown")?.content ?? "";
  assert.ok(content.includes("已有看板"));
  assert.ok(content.includes("--force"));
});

test("冲突卡片携带用户请求的新名称且确认按钮使用新名称创建", () => {
  const card = buildBoardConflictCard({
    name: "已有看板",
    url: "https://feishu.cn/base/bascnExisting",
    tableId: "tblExisting",
    requestedName: "研发大盘",
    appToken: "bascnExisting",
    confirm: true,
  });
  const body = card.body as { elements: Array<{ tag: string; content?: string; behaviors?: Array<{ value: Record<string, unknown> }> }> };
  const content = body.elements.find((e) => e.tag === "markdown")?.content ?? "";
  assert.ok(content.includes("研发大盘"), "应提示将用新名称覆盖");
  const confirmButton = body.elements.find(
    (e) =>
      e.tag === "button" &&
      (e.behaviors?.[0]?.value as { action?: string } | undefined)?.action ===
        "board_force_init",
  );
  const value = confirmButton?.behaviors?.[0]?.value;
  assert.equal(value?.name, "研发大盘", "确认按钮 value 必须携带用户请求的新名称");
  assert.equal(value?.appToken, "bascnExisting");
});

test("任务看板降级卡片橙色展示同步暂未就绪", () => {
  const card = buildBoardDegradedCard({
    name: "降级看板",
    url: "https://feishu.cn/base/bascnDegraded",
    appToken: "bascnDegraded",
    tableId: "tblDegraded",
  });
  assert.equal(card.schema, "2.0");
  const header = card.header as { template: string };
  assert.equal(header.template, "orange");
  const body = card.body as { elements: Array<{ tag: string; content?: string }> };
  const content = body.elements.find((e) => e.tag === "markdown")?.content ?? "";
  assert.ok(content.includes("tblDegraded"));
  assert.ok(content.includes("同步暂未就绪") || content.includes("自动重试恢复"));
});

test("错误卡片在建表已成功时提示已创建 App Token", () => {
  const card = buildBoardErrorCard({
    error: "挂载失败",
    appToken: "bascnOrphan",
  });
  const body = card.body as { elements: Array<{ tag: string; content?: string }> };
  const content = body.elements.find((e) => e.tag === "markdown")?.content ?? "";
  assert.ok(content.includes("bascnOrphan"), "应提示已创建的 App Token 避免重复建表");
});
