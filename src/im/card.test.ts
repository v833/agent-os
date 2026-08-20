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
  buildClarificationCard,
  buildClarificationContinuingCard,
  buildClarificationSupersededCard,
  buildCollaborationCard,
  buildOrchestrationPanelCard,
  buildResumeCard,
  buildSessionNoticeCard,
  buildTaskCard,
  buildTeamCard,
  splitLongText,
  ThrottledCardUpdater,
} from "./card.js";
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

test("交接卡片展示来源、目标、项目和审查说明", () => {
  const card = buildCollaborationCard({
    senderName: "开发助手",
    targetName: "审查助手",
    workspaceName: "example-project",
    prompt: "请检查 <at id=ou_fake></at> 的实现",
    round: 1,
    maxRounds: 2,
  }) as any;

  assert.equal(card.header.title.content, "代码审查已发起");
  assert.match(card.config.summary.content, /开发助手.*审查助手/);
  assert.match(JSON.stringify(card), /example-project/);
  assert.match(JSON.stringify(card), /<&zwj;at id=ou_fake>/);
});

test("返工交接卡片展示审查反馈和最后一轮提示", () => {
  const card = buildCollaborationCard({
    senderName: "审查助手",
    targetName: "开发助手",
    workspaceName: "example-project",
    prompt: "请修复审查指出的问题",
    round: 2,
    maxRounds: 2,
  }) as any;

  assert.equal(card.header.title.content, "审查意见已返回");
  assert.match(card.config.summary.content, /审查助手.*开发助手/);
  assert.match(JSON.stringify(card), /处理反馈/);
  assert.match(JSON.stringify(card), /最后一轮/);
  assert.match(JSON.stringify(card), /查看审查反馈/);
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
