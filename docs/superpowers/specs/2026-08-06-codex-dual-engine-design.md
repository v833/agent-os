# Codex 双引擎接入设计

## 目标

按照《接入 Codex：让 Agent OS 支持双引擎》的逻辑改造现有执行引擎：新话题默认交给 Codex，也允许通过 `/codex <任务>` 或 `/claude <任务>` 显式选择。一个飞书话题在创建会话时确定执行引擎，后续追问和重启恢复始终沿用该引擎及其 CLI 会话 ID。

改造必须保留当前已经实现的实时任务卡片、工具轨迹、停止按钮、运行实例隔离、长答案续发、持久化和多轮对话，不能使用文章中的早期入口示例覆盖这些后续能力。

## 配置与注册表

新增 `src/cli/registry.ts`，集中注册 `ClaudeAdapter` 与 `CodexAdapter`，提供按 ID 获取适配器、列出适配器和解析默认引擎三个入口。业务入口不再直接实例化适配器，也不再维护重复的显示名称映射。

运行配置改为文章定义的变量：

- `DEFAULT_CLI`：新话题的默认执行引擎，只接受 `claude` 或 `codex`。
- `CLI_WORKDIR`：两个 CLI 共用的执行目录。
- `CLAUDE_WORKDIR`：仅作为旧配置的工作目录回退值。

用户明确要求默认使用 Codex，因此 `DEFAULT_CLI` 未配置时返回 `codex`，`.env` 与 `.env.example` 的示例值也使用 `codex`。现有 `CLI_ENGINE`、`CODEX_WORKDIR` 和双工作目录路由从代码与文档中移除，避免存在两套配置语义。

启动时打印默认引擎，并逐个打印已注册适配器的 ID、命令和统一工作目录，以便确认两个执行入口都已加载。

## Codex 适配器

Codex 首轮使用：

```text
codex exec --json --sandbox workspace-write --skip-git-repo-check <prompt>
```

续聊使用：

```text
codex exec resume --json --skip-git-repo-check <thread_id> <prompt>
```

适配器把 Codex JSONL 翻译为公共 `CliEvent`：

- `thread.started` 保存 Codex `thread_id`。
- `command_execution` 映射为命令工具事件。
- `file_change` 映射为文件修改工具事件。
- `web_search` 映射为搜索工具事件。
- `mcp_tool_call` 映射为 MCP 工具事件。
- `agent_message` 提供最终回答。
- `turn.completed` 提供输入、输出、缓存输入和总 Token 统计。
- `turn.failed` 与 `error` 提供统一错误信息。

文章中的统计结果事件与现有实时卡片的上下文事件需要同时保留。因此 `turn.completed` 会先发出 `context` 事件供进度卡片更新，再发出带 `CliRunStats` 的空回答 `result` 事件供 Runner 合并。缺失的 Codex 上下文窗口、轮次或耗时数据不估算。

## Runner 合并规则

Codex 的最终回答和统计可能来自不同 JSONL 行。Runner 分别保存最近的非空回答和统计；收到任一 `result` 事件时更新对应字段，进程正常退出后返回合并结果。

该规则同时支持以下顺序：

- 回答先到，统计后到。
- 统计先到，回答后到。
- Claude Code 在同一个结果事件中同时返回回答和统计。

空回答统计事件不能覆盖已经收到的最终回答，缺少统计的后续结果也不能清除已收到的统计。

## 会话与命令路由

`SessionManager.resolve()` 接收本次新建会话应使用的 `CliId`，默认值为 `codex`。只有创建新会话时使用传入值；已存在的话题直接返回持久化会话，不改变 `cliId`。

命令解析器继续处理 `/status`、`/close`、`/help`，并新增独立的 CLI 请求解析：

- `/codex 检查项目` 返回 Codex 和任务正文。
- `/claude 修复类型错误` 返回 Claude Code 和任务正文。
- 单独发送 `/codex` 或 `/claude` 时返回空任务，由入口提示补充任务，不启动 CLI，也不创建会话。
- 普通正文中偶然出现 `/codex` 或 `/claude` 不应被识别为引擎指令。

消息入口按以下顺序处理：

1. 还原飞书提及并解析 CLI 请求。
2. 空 CLI 请求直接回复用法。
3. 使用显式引擎或 `DEFAULT_CLI` 解析会话。
4. 从会话的 `cliId` 获取适配器和显示名称。
5. 已存在话题若显式请求其他引擎，提示新开话题并停止处理。
6. 控制命令和会话状态检查沿用现有逻辑。
7. 使用去掉 `/claude` 或 `/codex` 前缀后的任务正文启动 CLI。

所有运行中、成功、失败和取消卡片都使用适配器的 `displayName`。`/status` 展示显示名称而不是内部 ID，`/help` 增加两条引擎选择命令。

## 错误与安全边界

- 非法 `DEFAULT_CLI` 在启动阶段立即失败，并明确提示只允许 `claude` 或 `codex`。
- 同一话题不能切换引擎，防止把 Claude Code 会话 ID 传给 Codex，或反向混用。
- CLI 参数继续通过 `spawn` 的独立参数数组传递，不拼接 shell 命令。
- Codex 使用 `workspace-write` 沙箱，不把第三方模型密钥写入项目配置。
- 现有任务取消、Windows 进程树清理、卡片节流和 `runId` 隔离保持不变。

## 文档与验证

更新 `.env.example`、README、AGENTS.md 和 CLAUDE.md 的配置、模块地图与验收说明。实际 `.env` 只增加非敏感的 `DEFAULT_CLI=codex` 和空 `CLI_WORKDIR`，保留现有飞书凭证且不提交。

自动测试覆盖：

- 注册表获取、列表和默认值/非法值解析。
- `/claude`、`/codex`、带提及、空任务和误识别边界。
- 新会话使用传入引擎，旧话题保持原引擎，持久化恢复不变。
- Codex 四类工具、首次与续聊参数、错误、答案、上下文和 Token 统计。
- Runner 在回答与统计两种到达顺序下都返回完整结果。
- 现有卡片、停止、会话和 Claude Code 测试全部继续通过。

最终执行 `pnpm build`、`pnpm test` 和 `git diff --check`。随后用本机 Codex CLI 验证文章规定的无头命令，并启动飞书机器人检查日志是否同时列出两个适配器且默认值为 Codex。

## 非目标

- 不增加第三种执行引擎。
- 不允许同一话题中途迁移引擎或转换 CLI 会话。
- 不引入不同引擎的独立工作目录。
- 不修改飞书卡片视觉结构或会话状态机的既有语义。
