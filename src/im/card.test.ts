/**
 * 飞书任务卡片测试：覆盖四种生命周期视图、双 CLI 工具信息、
 * 上下文口径、长答案拆分，以及节流更新的串行与唯一终态。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { TaskProgressSnapshot } from "../core/task-progress.js";
import {
  answerContinuation,
  answerNeedsContinuation,
  buildCollaborationCard,
  buildResumeCard,
  buildSessionNoticeCard,
  buildTaskCard,
  splitLongText,
  ThrottledCardUpdater,
} from "./card.js";

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
