# 双 CLI 实时任务卡片设计

## 目标

完整实现《深入流式渲染：打造 Claude Code 实时任务卡片》中的任务停止、上下文增量、流式卡片、按钮回调、长答案和入口编排，并让 Claude Code 与 Codex 共用同一套飞书任务生命周期。

完成后，飞书中的一张卡片从“正在理解任务”持续更新到成功、失败或取消终态。卡片每秒最多更新一次，按钮只能停止发起人自己的当前任务，同一话题仍按原 CLI 会话继续多轮对话。

## 范围

本次包含：

- `ActiveRun` 与停止权限判断，区分按钮停止和 `/close`。
- 进度快照记录本轮第一次与最新一次上下文事件。
- 运行、成功、失败、取消四种卡片状态。
- 当前动作、最近轨迹、耗时、工具次数、上下文和本轮变化展示。
- 一秒节流、卡片更新串行化和唯一终态。
- 飞书 `card.action.trigger` 解析与 Toast 响应。
- 短答案直显、长答案折叠、超出卡片上限后的分段续发。
- Claude Code 与 Codex 的动态标题、工具信息和真实统计适配。

本次不新增 CLI 类型，也不改变会话寻址、持久化格式或资源下载规则。

## 方案选择

采用共享卡片链路方案。Claude Code 与 Codex 只在现有适配器层翻译不同 JSONL 协议，入口之后统一使用 `CliEvent`、`TaskProgressTracker`、`buildTaskCard()`、`ThrottledCardUpdater` 和任务停止逻辑。

不为两个引擎复制卡片流程，也不新增通用视图状态机。前者会产生重复和行为漂移，后者超出当前单一飞书视图的实际需要。

## 模块设计

### 任务停止

新增 `src/core/task-abort.ts`：

- `ActiveRun` 保存 `AbortController`、发起人 `ownerOpenId` 和可选 `cancelMode`。
- `requestTaskAbort()` 只接受会话 ID 与飞书回调中的真实操作者 ID。
- 返回 `stopped`、`already_stopping`、`not_found`、`forbidden` 四种稳定结果。
- 只有发起人且任务仍在运行时才调用 `abort()`；旧卡片不会影响后来启动的任务。
- 卡片按钮设置 `cancelMode="stop"`，`/close` 设置 `cancelMode="close"` 并关闭会话。

### 进度快照

扩展 `TaskProgressSnapshot`：

- `contextStartTokens` 保存本轮第一次 `context` 事件。
- `contextUsedTokens` 保存最新事件。
- `startedNewSession` 表示本轮开始时没有 CLI 恢复指针。

`TaskProgressTracker` 仍按工具 ID 配对并发调用，只增加上下文起点和新会话标记，不改变最近 12 条活动的上限。

### 卡片视图

`src/im/card.ts` 由百分比卡片升级为任务生命周期视图：

- 运行中：蓝色标题、当前动作和详情、耗时、工具次数、上下文、本轮变化、最近 3 条完成轨迹和停止按钮。
- 成功：绿色标题，答案位于正文顶部；执行统计和最近 8 条轨迹放入折叠面板；底部标明结果接收人。
- 失败：红色标题，正文展示可行动的重试提示，原始错误放入折叠面板。
- 取消：灰色标题，根据 `cancelMode` 说明本轮可继续或会话已关闭。

答案不超过 900 个字符时直接展示；更长时展示预览和折叠全文。卡片最多保留 6000 个字符，剩余内容按不超过 4000 个字符的文本消息继续发送。Markdown 预览优先在段落或换行处切分，并补齐未关闭的代码围栏。疑似飞书标签的原始回答需要转义，接收人 `at` 标签由系统单独生成。

`ThrottledCardUpdater` 在一秒窗口内只保留最新卡片，所有更新通过 Promise 链串行执行。`finish()` 清除待发送中间态、等待在途更新结束，再写入唯一终态；`cancel()` 只停止后续更新。

### 飞书回调

`src/im/lark.ts` 增加：

- `CardAction`、`CardActionResponse` 和 `BotOptions.onCardAction`。
- `parseCardAction()` 兼容 SDK 中两种操作者和消息 ID 字段形态，并把非对象按钮值收敛为空对象。
- `card.action.trigger` 注册在现有长连接分发器中，回调结果直接返回飞书。

权限判断不能相信按钮 value 中的用户字段，只使用平台回调提供的操作者 `open_id`。

### 入口编排

`src/index.ts` 保留双引擎、会话、资源下载和取消竞态保护，并完成以下编排：

1. 会话进入 `active` 后登记带发起人的 `ActiveRun`。
2. CLI 启动前发送带停止按钮的初始卡片；拿不到卡片 ID 时回滚为空闲。
3. 用会话 ID 记忆上次真实上下文窗口；创建进度跟踪器时传入窗口和是否为新 CLI 会话。
4. 工具或上下文事件更新快照并推送节流器；每秒心跳刷新耗时。
5. 成功时保存 CLI 恢复指针和真实上下文窗口，写入答案、统计、接收人，并续发超长剩余内容。
6. 取消时按 `cancelMode` 写入灰色终态；失败时写入用户提示和折叠技术详情。
7. 所有出口停止心跳、只清理自己登记的运行实例，并把未关闭会话恢复为 `idle`。

成功回调必须再次检查取消信号，防止 CLI 退出与用户停止同时发生时写入绿色终态。

## Codex 适配

- 卡片标题使用会话实际引擎：`Codex` 或 `Claude Code`。
- Codex 的 `command_execution` 使用命令图标和真实命令摘要，工具开始/结束继续按 `item.id` 配对。
- Codex 的 `turn.completed.usage.input_tokens` 作为真实当前输入上下文。
- Codex 未提供的上下文窗口、轮次、累计缓存统计保持不显示，不估算或伪造。
- 任务耗时可以使用 `TaskProgressTracker` 的本地执行时段；Claude 最终提供 `durationMs` 时优先使用供应商统计。

## 错误与并发边界

- 非发起人点击停止只收到警告 Toast，不改变任务。
- 重复点击停止只返回“正在停止”，不会再次中止进程。
- 任务结束后点击旧卡片只返回“已经结束”。
- 更新失败不能阻止 `finally` 清理运行记录和恢复会话状态。
- 取消、失败和成功只能产生一个最终卡片；待发送的运行中卡片不得覆盖终态。
- `/close` 关闭会话后，迟到的后台清理不得把状态改回 `idle`。

## 测试与验收

自动化测试覆盖：

- 停止成功、重复停止、任务不存在和无权限四种结果。
- 上下文起点、最新值、新会话标记、并发工具和活动上限。
- 四种卡片样式、工具图标、上下文口径、长答案预览、代码围栏、标签转义、续发切分和接收人。
- 节流窗口只提交最新值、更新严格串行、`finish()` 丢弃中间态、`cancel()` 停止后续写入。
- 飞书卡片动作的操作者、消息 ID 和按钮 value 解析。
- 动态 Claude/Codex 标题，以及 Codex 缺失统计不显示。

最终执行：

```powershell
rg -n 'progress:\s*(0|100)' src/index.ts
pnpm build
pnpm test
git diff --check
```

飞书人工验收应确认：运行卡片每秒最多更新一次；成功答案置顶；失败和取消终态正确；只有发起人可停止；按钮停止后同一话题可继续；`/close` 后会话保持关闭；Claude 与 Codex 均使用相同卡片生命周期。

## 预计修改文件

- 新增 `src/core/task-abort.ts`、`src/core/task-abort.test.ts`
- 修改 `src/core/task-progress.ts`、`src/core/task-progress.test.ts`
- 修改 `src/im/card.ts`、`src/im/card.test.ts`
- 修改 `src/im/lark.ts`、`src/im/lark.test.ts`
- 修改 `src/index.ts`、`package.json`
- 同步 `README.md`、`AGENTS.md`、`CLAUDE.md`
