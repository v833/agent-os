# CLI 流式事件链设计

## 目标

完整实现《看见 Claude Code 的每一步：打通流式事件链》中的底层事件链，并让 Codex 获得同等的真实事件适配能力：

- 一行供应商 JSONL 可以翻译成多个统一事件。
- Runner 在保留最终 Promise 的同时，通过回调实时分发过程事件。
- 高频工具事件汇总为稳定、可测试的任务进度快照。
- 飞书入口实时打印当前动作、完成工具数量和可用的上下文用量。
- 最终卡片、最终回答、多轮续聊、超时和取消行为保持不变。

本节不把过程快照更新到飞书卡片，也不增加可点击停止按钮。这两项属于下一篇文章。

## 统一事件契约

`src/cli/types.ts` 增加 `CliRunStats`，并把 `CliEvent` 扩展为：

- `session`：供应商会话恢复指针。
- `tool_start`：工具调用 ID、原始工具名、中文标签和可选短详情。
- `tool_end`：通过相同 ID 结束一次工具调用，并标记是否失败。
- `context`：供应商明确给出的当前输入或上下文 Token 数。
- `result`：最终回答、可选会话 ID 和可选运行统计。
- `error`：供应商协议级错误。

`CliAdapter.parseEvent()` 的运行时契约升级为 `parseEvents(line): CliEvent[]`。适配器可以保留单事件兼容方法供过渡测试使用，但 Runner 只调用数组接口。

## Claude Code 映射

`ClaudeAdapter` 按文章定义处理四条事件线：

1. `system/init` 产生 `session`。
2. `assistant.message.usage` 产生 `context`；同一条消息中的每个 `tool_use` 都产生独立的 `tool_start`。
3. `user.message.content[].tool_result` 通过 `tool_use_id` 产生 `tool_end`。
4. `result` 产生最终结果或错误，并从 `duration_ms`、`num_turns`、`usage` 与 `modelUsage` 提取统计。

工具详情仅保留适合日志和后续卡片展示的短文本：文件路径截短，命令、搜索词和任务描述压缩空白并限制长度。累计 Token 与当前上下文分开，禁止把最终累计消耗误当成当前窗口占用。

## Codex 映射

映射以本机 `codex exec --json` 的真实事件为依据：

- `thread.started.thread_id` → `session`。
- `item.started` 且 `item.type=command_execution` → `tool_start`，使用 `item.id` 配对，标签为“运行命令”，详情来自截短后的 `item.command`。
- `item.completed` 且 `item.type=command_execution` → `tool_end`；非零 `exit_code` 或失败状态标记为失败。
- `item.completed` 且 `item.type=agent_message` → `result`。
- `turn.completed.usage.input_tokens` → `context`；只使用协议提供的真实字段，不估算上下文窗口。
- `turn.failed` 与 `error` → `error`。

Codex 没有提供 Claude 对应字段时保持缺失，不制造耗时、轮次或窗口大小。未知 item 类型忽略，避免把推理文本误报成工具调用。

## Runner 数据流

`runCli()` 增加可选同步回调 `onEvent(event)`：

```text
CLI stdout line
  -> adapter.parseEvents(line)
  -> 逐个 onEvent(event)
  -> Runner 更新 session/error/result 状态
  -> 子进程关闭后 resolve/reject
```

Runner 必须继续保留现有安全和生命周期边界：

- `shell=false` 与参数数组隔离用户提示词。
- Windows 绕过 npm 包装脚本，直接启动 Node 入口或 exe。
- 默认十分钟超时。
- 取消和超时通过 `taskkill /T /F` 清理整棵 Windows 进程树。
- abort、spawn error、协议错误和 close 只能有一个 Promise 收尾出口。
- 监听器、readline 和定时器必须在收尾时清理。

事件回调或适配器解析抛错时，把异常记录为协议错误并在进程退出后拒绝，不允许未捕获异常冲出事件监听器。

## 任务进度快照

新增 `src/core/task-progress.ts`：

- `TaskProgressTracker` 只处理内存状态，不依赖飞书 SDK。
- `tool_start` 写入 `Map<toolUseId, ActiveTool>`，支持多个并行工具。
- `tool_end` 按 ID 配对，计算非负耗时并移动到完成记录。
- 完成记录按最新优先排列，最多保留 12 条。
- `context` 更新最近一次真实上下文用量。
- 没有工具时显示“正在理解任务”；已有工具但当前无活动工具时显示“正在分析执行结果”。

每次 `accept()` 都返回新的快照，数组使用副本，调用方不能修改 Tracker 内部状态。

## 入口集成

`src/index.ts` 为 `executeCli()` 增加 `onEvent` 参数，并为每次运行创建独立的 `TaskProgressTracker`。入口只订阅 `tool_start`、`tool_end` 和 `context`，输出：

```text
[进度] 读取文件 detail=package.json tools=0/1 context=...
[进度] 正在分析执行结果 tools=1/1 context=...
```

Codex 和 Claude 共用相同日志格式。卡片标题仍按会话持久化的 `cliId` 选择，CLI 会话 ID 保存、多轮续聊、取消竞态检查和最终状态回收保持现有逻辑。

## 测试与文档

自动化测试至少覆盖：

- Claude 一行同时产生 context 和多个 tool_start。
- Claude tool_result、错误与最终统计。
- Codex 真实 command_execution 开始/结束、失败状态、context、结果和错误。
- Runner 按顺序分发多个事件，保留最终 stats，并隔离回调异常。
- Tracker 的初始状态、并行工具配对、耗时、失败、上下文和 12 条上限。
- 原有续聊、取消、超时、Windows 进程树与最终结果测试继续通过。

同步更新 `package.json` 测试入口、`README.md`、`AGENTS.md` 和 `CLAUDE.md` 模块地图及流式事件验收说明。

最终验证命令：

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm test
git diff --check
```

实机验收分别用 Claude Code 和 Codex 执行会触发文件读取或命令调用的只读任务，确认终端持续出现进度、最终飞书回答正常、同一话题仍可续聊。
