# Mastra Agent 第三执行引擎接入设计

## 目标

在 Agent OS 中加入第三种执行引擎：Mastra Agent。用户可以把某个 bot 的 `defaultCli` 配为 `mastra`，或在新话题用 `/mastra <任务>` 显式选择；任务由 Mastra 框架在独立子进程中运行，直接调用各家 LLM API，不依赖本机安装 Codex / Claude Code。

必须完整保留现有能力：实时任务卡片、工具轨迹、停止按钮、运行实例隔离、长答案续发、持久化、多 bot 协作，且不引入第二套调度链路。

## 核心决策：子进程包装

Mastra Agent 是进程内库（`agent.stream()` 直接调 LLM API），与现有 `CliAdapter` 契约（spawn 子进程 + 逐行解析 JSONL）形态不同。没有改写 Runner / 会话状态机 / 卡片链路，而是新增 `src/agents/mastra-runner.ts` 子进程入口，由 `MastraAdapter` 以 `node + tsx` 方式拉起：

```text
node <tsx-cli> <src/agents/mastra-runner.ts> <prompt>
```

子进程把工具调用、文本流、用量翻译成与 Codex 同构的 JSONL `CliEvent` 写到 stdout。这样超时、取消、Windows 进程树清理、`/close` 停止按钮全部复用现有 Runner，改动面收敛为新增 3 个模块 + 若干枚举扩展。

Windows 下 `MastraAdapter.command` 直接使用 `process.execPath`，避免 npm 的 `.cmd` 包装器破坏 `spawn(shell=false)` 安全边界；tsx 入口与 runner 路径通过 `import.meta.resolve` / `import.meta.url` 在源码模式定位。

## 模型路由与配置

只引入 `@mastra/core` 一个依赖。模型使用 Mastra 模型路由的 `"provider/model"` 字符串（如 `openai/gpt-5.6-sol`、`deepseek/deepseek-chat`、`anthropic/claude-sonnet-4-6`），API Key 从对应 provider 的标准环境变量读取，无需为每家服务商安装 provider 包。

`.env` 新增：

- `MASTRA_MODEL`：模型路由，必填；缺失时 runner 输出清晰错误并退出（错误会显示在飞书卡片上）。
- `MASTRA_SYSTEM_PROMPT`：Agent 系统提示词，可选，留空使用内置默认角色。

runner 的 cwd 是话题工作目录，未必是项目根，因此启动时显式加载项目根 `.env`（`quiet: true` 防止横幅日志污染 JSONL 流）。

## 工具与安全边界

Agent 内置三个工具：

- `read_file` / `write_file`：只能访问话题工作目录（runner cwd）内的路径；绝对路径与 `..` 逃逸在 `resolveInsideWorkspace` 统一拒绝。这是飞书消息 → Agent → 文件系统的最后一道防线。
- `run_command`：在工作目录执行 shell 命令，默认 5 分钟超时，超时即终止整个进程树（Windows 用 `taskkill /T`），stdout/stderr 各自截断 200K 避免撑爆上下文。

工具导出为独立常量，安全边界可直接单测。

## 事件协议

runner → adapter 的 JSONL 事件（与 `CliEvent` 同构）：

- `tool_start`（toolUseId / toolName / label / detail）← fullStream 的 `tool-call` chunk
- `tool_end`（toolUseId / failed）← `tool-result` chunk，`isError` 映射失败
- `result`（answer / stats.inputTokens / stats.outputTokens）← 流结束后的 `totalUsage`
- `error`（message）← 任何未捕获异常，进程退出码 1

`pnpm probe:cli`（`src/cli-events.ts`）同步支持这些事件，便于无飞书环境直接调试 runner。

## 能力边界

- 不保存原生会话：runner 永不发出 `session` 事件，`cliSessionId` 保持未设置，同一话题追问不会自动续接上下文。
- `/resume`：`listNativeCliSessions` 对 mastra 返回空列表。
- `/compact`：不进入整理流程，直接回复"引擎不支持"。
- `buildResumeArgs` / `buildCompactPlan` 直接抛错，防止被意外调用。

## 改动清单

- 新增 `src/agents/mastra-agent.ts`、`src/agents/mastra-runner.ts`、`src/cli/mastra-adapter.ts`（含 `mastra-adapter.test.ts`、`mastra-agent.test.ts`）
- `src/cli/types.ts`：`CliId` 增加 `mastra`
- `src/cli/registry.ts` / `src/core/bot-registry.ts` / `src/core/command-parser.ts` / `src/core/session-store.ts`：引擎枚举与 `/mastra` 前缀
- `src/cli/native-sessions.ts`：mastra 返回空列表
- `src/index.ts`：`/help` 增加 mastra 行；`/compact` 对 mastra 提示不支持
- `src/cli-events.ts`：probe 时间线支持 mastra 事件
- 配置与文档：`.env.example`、`config/bots.example.json`（新增 disabled 示例 bot）、README、AGENTS.md

## 验证

- `pnpm build` + `pnpm test`（131 用例，含路径逃逸、命令超时、事件翻译、时间线、注册表、`/mastra` 解析）
- 无 key 链路探测：runner 输出单条 JSONL error + 退出码 1
- 已知边界：真实 LLM 调用与飞书端到端需要真实 `MASTRA_MODEL` + API Key 后才可验证；fullStream chunk 字段以 `@mastra/core@1.59.0` 类型定义为准