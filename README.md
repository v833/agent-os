# Agent OS

当前阶段支持从飞书话题真实调度 Codex、Claude Code 或 DimAgent，并用同一张卡片实时展示当前动作、工具轨迹、耗时和上下文；成功后答案回到卡片正文，任务也可由发起人随时停止。同一话题会续接 CLI 上下文，会话和恢复指针都可跨进程重启恢复。一个进程可以按注册表启动多台职责不同的 bot，每台 bot 使用独立凭证、默认引擎、接入模式和角色说明，同时保留 `@` 提及、富文本代码以及图片和文件下载能力。

## Cordis 插件架构（一切皆为插件）

插件化设计：运行中的 Agent OS 本质上是一个 Cordis 根 Context，平台、执行引擎、斜杠命令、会话、任务编排和 bot 协作都是挂载在它上面的插件，通过 `ctx.<service>` 与类型化事件协作，而不是互相导入具体实现。

- **插件装配**：`cordis.yml` 声明启用哪些插件及参数。移除一个条目或设置 `disabled: true` 即可下线对应能力；新增能力只需写一个新插件并在 `src/plugins/loader.ts` 的注册表里登记名字。
- **服务**：`ctx.config`（bot 注册表）、`ctx.sessions`（会话模型）、`ctx.cli`（执行引擎与调度）、`ctx.lark`（飞书平台）、`ctx.cards`（卡片渲染）、`ctx.commands`（斜杠命令）、`ctx.tasks`（任务编排）、`ctx.schedule`（定时任务）、`ctx.collaboration`（bot 协作）、`ctx.orchestration`（多话题并行编排）。消费方通过 `inject` 声明依赖，Cordis 按依赖自动决定启动顺序。
- **事件**：lark 插件发出 `bot/message` 与 `bot/card-action`，router 路由插件消费并派发；任务完成后 tasks 服务广播 `task/result`，失败时广播 `task/failed`——collaboration 监听成功事件决定是否自动交接，orchestration 监听两类事件更新子任务状态；orchestration 再广播 `orchestration/update` / `orchestration/evicted`，可选插件 `orchestration/live-panel` 据此挂起并节流刷新实时面板卡片（移除该插件即回退为仅汇总文本），可选插件 `orchestration/actions` 认领面板「重试」按钮回调并重新派发失败子任务（移除即无重试按钮）。协作与编排都是可选插件，移除后任务编排不受影响。
- **引擎与命令都是插件**：`src/plugins/engines/*.ts` 通过 `ctx.cli.register()` 登记 Codex/Claude/DimAgent；`src/plugins/commands/*.ts` 通过 `ctx.commands.register()` 登记 `/help`、`/new`、`/resume`、`/compact`、`/status`、`/team`、`/cd`、`/close`、`/schedule`、`/orchestrate`、`/panel`。新增执行引擎或斜杠命令 = 新增一个插件。

默认 `cordis.yml` 内容：

```yaml
plugins:
  - name: config
    config:
      botsPath: config/bots.json
  - name: sessions
  - name: cli
  - name: engines/claude
  - name: engines/codex
  - name: engines/dimagent
  - name: lark
  - name: cards
  - name: commands
  - name: commands/help
  - name: commands/new
  - name: commands/resume
  - name: commands/compact
  - name: commands/status
  - name: commands/cd
  - name: commands/close
  - name: commands/schedule
  - name: collaboration
  - name: orchestration
    config:
      dispatchMode: topic
      maxRetry: 2
      pendingTimeoutMs: 1800000
  - name: orchestration/live-panel
  - name: orchestration/actions
  - name: commands/orchestrate
  - name: commands/panel
  - name: tasks
  - name: schedule
  - name: router
```

底层纯函数模块（`src/core/*`、`src/cli/*`、`src/im/*`）保持无框架依赖，由服务插件复用；`src/index.ts` 只是创建根 Context 并挂载 loader 的引导入口。

## 飞书开放平台配置

1. 在[飞书开放平台](https://open.feishu.cn/)创建“飞书智能体应用”。
2. 确认应用已启用机器人能力，并订阅 `im.message.receive_v1` 事件。
3. 事件接收方式选择“使用长连接接收事件”。
4. 创建一个话题群，在群设置的“群机器人”中加入该应用。
5. 为每台 bot 创建应用并把 App ID、App Secret 写入本地 `.env`。bot 的对应关系在 `config/bots.json` 中维护。

`.env` 已被 Git 忽略，禁止提交真实凭证。

## 多 bot 注册表

先复制配置模板，再按本机 bot 填写配置：

```powershell
Copy-Item config/bots.example.json config/bots.json
```

`config/bots.json` 的顶层 `teamLeader` 声明团队负责人（稳定 ID，必须指向启用成员，否则在建立飞书连接前拒绝启动）；`bots` 的每一项包含稳定的 `id`、凭证环境变量名、`defaultCli`、`workspace`、`role`、`systemPrompt` 和可选的 `skills`、`accessMode`、`enabled`、`reviewBy`、`collaborationMaxRounds`。`role` 是一句话职责说明，飞书 `/team` 团队卡片与成员提示词都会用到；`skills` 声明该成员处理任务时必须遵守的项目 Skill（如 `grill-me`，需安装在成员工作目录的 `.agents/skills` 或 `.claude/skills`）。`accessMode` 可填写 `headless` 或 `acp`，未填写时默认 `headless`；`acp` 是标准接入能力，由 `engines/acp` 插件提供，任何 defaultCli 都可声明（前提是该引擎注册了对应接入模式，运行时由 CLI 注册表校验）。`collaborationMaxRounds` 默认是 `16`，可设置为 `1` 到 `32`，防止协作失控循环。示例文件可以提交，实际配置已被 Git 忽略：

```json
{
  "teamLeader": "developer",
  "bots": [
    {
      "id": "developer",
      "appIdEnv": "FEISHU_DEVELOPER_APP_ID",
      "appSecretEnv": "FEISHU_DEVELOPER_APP_SECRET",
      "defaultCli": "dimagent",
      "accessMode": "acp",
      "workspace": ".",
      "role": "开发工程师，负责完成实现，并组织内部审查与测试",
      "systemPrompt": "你是主力开发助手，负责理解需求并完成实现。",
      "reviewBy": "reviewer",
      "collaborationMaxRounds": 16
    },
    {
      "id": "reviewer",
      "appIdEnv": "FEISHU_REVIEWER_APP_ID",
      "appSecretEnv": "FEISHU_REVIEWER_APP_SECRET",
      "defaultCli": "codex",
      "workspace": ".",
      "role": "代码审查工程师，负责检查实现、发现风险并给出修改建议",
      "systemPrompt": "你是审查助手，负责检查实现、发现风险并给出修改建议。",
      "enabled": true
    },
    {
      "id": "assistant",
      "appIdEnv": "FEISHU_ASSISTANT_APP_ID",
      "appSecretEnv": "FEISHU_ASSISTANT_APP_SECRET",
      "defaultCli": "codex",
      "workspace": ".",
      "role": "个人助理，负责协助用户处理日常事务、信息整理、计划安排和执行跟进",
      "systemPrompt": "你是个人助理，负责协助用户处理日常事务、信息整理、计划安排和执行跟进。",
      "enabled": true
    }
  ]
}
```

`appIdEnv` 和 `appSecretEnv` 指向 `.env` 中的真实凭证变量。停用 bot 时设置 `enabled: false`，它不会读取凭证或建立长连接；全部停用或配置字段错误时程序会在启动阶段退出。修改 `.env` 或 `config/*.json` 会触发 `pnpm start` 自动重启。群里 @哪台 bot，就由哪台 bot 接手，程序无需再次判断目标应用。

个人助理使用独立的飞书应用凭证和 `assistant` bot ID，不参与开发 bot 的自动代码审查链。启用前请在 `.env` 中填写 `FEISHU_ASSISTANT_APP_ID` 和 `FEISHU_ASSISTANT_APP_SECRET`，并把本地 `config/bots.json` 中的 `assistant.enabled` 设置为 `true`。

`reviewBy` 填另一台已启用 bot 的 ID。开发 bot 的普通任务成功后，会在原话题发送审查卡片，再发送一条真正提及审查 bot 的富文本消息；审查 bot 会继承来源 bot 的工作目录并建立独立 CLI 会话。审查完成后，最终回答会登记为下一项协作任务，沿用同一个 `taskId` 并把 `round` 加一，再自动交回来源 bot。达到 `collaborationMaxRounds` 后只发送完成通知，不再继续派活，避免两个 bot 无限循环。目标不存在、未启用或指向自己时，程序会在启动阶段拒绝配置。

在飞书群中 @任意成员发送 `/team`，会返回一张团队卡片，展示每位成员的职责、默认执行引擎、项目 Skill 与连接状态。

## 启动与验证

```powershell
pnpm build
pnpm test
pnpm start
```

看到 `ws client ready` 后，在测试话题群里 `@机器人` 发送消息。

## CLI 引擎配置

先确认本机终端可以找到两个 CLI：

```powershell
codex --version
claude --version
```

Codex 尚未安装时执行：

```powershell
npm install -g @openai/codex
codex
```

完成登录后，在项目目录验证非交互模式：

```powershell
codex exec --json --sandbox danger-full-access --skip-git-repo-check "只回复：Codex 已就绪"
```

Claude Code 尚未安装时执行：

```powershell
npm install -g @anthropic-ai/claude-code
claude
```

首次运行 `claude` 时完成 Anthropic 登录。使用兼容模型服务时，把供应商地址、认证令牌和模型配置保存在各 CLI 的用户级配置中，也可以使用 CC Switch 切换服务；不要把模型密钥写入项目或提交仓库。

飞书无法展示 Claude Code 的交互式权限确认，因此 Agent OS 会以 `--dangerously-skip-permissions` 无人值守运行 Claude。只应把 bot 指向明确可信、可随时回退的工作目录。

每台 bot 的默认工作目录和新话题默认引擎由 `config/bots.json` 决定：

```json
{
  "id": "developer",
  "defaultCli": "claude",
  "workspace": "C:\\你的\\项目\\绝对路径"
}
```

- `workspace` 可以填写相对路径或绝对路径；相对路径从 Agent OS 启动目录解析，未填写时兼容读取 `CLI_WORKDIR`、`CLAUDE_WORKDIR`，最后回退当前目录。
- 工作目录决定 CLI 读取、修改和执行命令的项目，启动时会检查路径存在且是文件夹。
- 话题创建时复制 bot 的默认目录；同一 bot 的不同话题可以分别使用不同项目。
- 在话题中发送 `/cd` 查看目录，发送 `/cd <目录>` 切换目录。相对路径以当前话题目录为基准，目录变化会清除旧 CLI 会话，下一条任务重新建立上下文。
- 已持久化话题继续使用自己的 `cliId`；修改 bot 的 `defaultCli` 只影响之后创建的新话题。

Codex 通过 `codex exec --json --sandbox danger-full-access --skip-git-repo-check` 运行，拥有完整系统访问权限；同一话题追问使用带 `--sandbox danger-full-access` 的 `codex exec resume`。Claude Code 通过 `claude -p --output-format stream-json --verbose` 运行，权限和模型后端沿用用户级 Claude Code 配置。

### DimAgent（headless / ACP）

安装并先在交互界面完成 provider、模型和 MCP 配置：

```powershell
npm install -g dimcode
dim
```

DimAgent 的官方 CLI 入口是 `dim`；如果使用自定义命令名，可在 `.env` 中通过 `DIMAGENT_COMMAND` 覆盖。

bot 通过 `accessMode` 选择接入方式，未填写时默认 `headless`：

```json
{
  "id": "developer",
  "defaultCli": "dimagent",
  "accessMode": "acp",
  "workspace": "."
}
```

- `headless`：每轮调用 `dim exec --json --policy full-access`，续聊使用 `dim exec resume <session-id>`。
- `acp`：由 `engines/acp` 插件以标准 ACP 协议接入——维护单个常驻 `dim acp` 进程，任务在同一进程上并发执行，新建或恢复 session 后把消息分片、工具状态与 token 用量映射到实时卡片；空闲自动回收、崩溃自动重连。
- ACP 和 headless 都复用 `~/.dimcode/v2/` 中的 provider、模型、MCP 与凭据配置。
- 飞书没有同步权限确认界面；ACP 遇到权限请求时会自动选择 `allow_always` 或 `allow_once`，与 headless 的 `full-access` 行为保持一致。只应配置可信且可回退的工作目录。
- 同一话题会自动续接 DimAgent session；当前 `/resume` 不枚举 DimAgent 自身数据库中的历史会话，`/compact` 也暂不调用 DimAgent 原生整理协议。

新话题可发送 `/dimagent <任务>` 显式选择 DimAgent；接入模式仍取该 bot 的 `accessMode` 配置。`engines/acp` 插件通过 `cordis.yml` 的 `engines` 列表声明 ACP 引擎（`id`/`command`/`args`），因此任何提供 ACP server 的 CLI 都能以相同方式接入；未注册的引擎与接入模式组合会在运行时明确报错。

## 话题与提及验证

分别在话题根消息和已有话题中 `@机器人`。终端应输出：

```text
[收到] chat=oc_xxx threadId=omt_xxx rootId=om_xxx sender=ou_xxx
  原文: @_user_1 帮我看看 @_user_2 的代码
  还原: @MyBot 帮我看看 @运营专家 的代码
  mentions: @_user_1=MyBot(ou_xxx), @_user_2=运营专家(ou_xxx)
[卡片] 已发送 message_id=om_xxx inThread=true
```

根消息的 `rootId` 可能为空，但话题消息会带 `threadId`；已有话题内的回复通常同时带 `threadId` 和 `rootId`。任务卡片应留在当前话题。

`text` 消息正文中的 `@_user_N` 会被还原为显示名；`post` 消息会保留 `at` 占位符，并在后续统一还原提及。富文本中的 `text`、链接、行内代码、代码块、Markdown 和换行也会进入 CLI 提示词，图片仍由资源下载链路单独处理。

## 图片和文件下载

不要只发送裸图片。在话题编辑器中输入 `@机器人 帮我看看这张图`，再把文字和图片作为同一条消息发送，以覆盖 `post` 内嵌图片分支。

资源会保存到：

```text
data/downloads/
```

图片根据响应 `Content-Type` 保存为 `jpg`、`png`、`gif`、`webp`、`bmp` 或 `ico`；无法识别时使用 `.img`。普通文件优先保留原文件扩展名，无法识别时使用 `.bin`。

PowerShell 中可以检查下载结果：

```powershell
Get-ChildItem -LiteralPath .\data\downloads
```

验证范围：

- `@机器人 + 文字 + JPEG/PNG/WebP`：扩展名应与真实格式一致
- `@机器人 + 文字 + 普通文件`：应保留原文件扩展名
- 日志应出现 `  [下载] image|file → data\downloads\...`

下载失败时：

- `234003`：检查 `message_id` 和资源 key 是否来自同一条消息
- `234004`：检查机器人是否仍在当前群里
- 权限错误：确认应用已获得读取消息资源所需的消息权限
- 日志成功但找不到文件：确认从项目根目录运行 `pnpm start`

群聊中不带 `@机器人` 的普通消息默认不会推送给应用。

## 飞书到 CLI 的真实执行链路

在新话题发送一个容易核对的只读任务：

```text
@机器人 请读取 package.json，告诉我项目名称和主要依赖，不要修改文件
```

系统会依次执行：

1. 创建或复用当前话题的 Agent OS 会话，并切换为 `active`。
2. 在原话题发送蓝色的“Codex · 执行中”或“Claude Code · 执行中”卡片。
3. 后台启动真实 CLI 子进程，飞书长连接仍可处理 `/status` 和 `/close`。
4. 按行解析 stdout 中的 JSONL；一行可产生多个统一事件，普通诊断噪音会被忽略。
5. 工具、上下文事件实时汇总成稳定快照，打印到终端并以一秒上限刷新原卡片。
6. 成功时把原卡片更新为绿色，答案置于正文；超出卡片上限的剩余内容继续回复到同一话题。
7. 失败时卡片变红并折叠技术详情；停止时卡片变灰，不会写入迟到的成功状态。
8. 最后清理运行记录，把未关闭的会话持久化为 `idle`。

终端会输出实际引擎和工作目录：

```text
[CLI] id=claude command=claude
[CLI] id=codex command=codex
[Bot DEVELOPER] default_cli=claude access_mode=headless workspace=C:\你的\项目
[CLI] 启动 engine=codex access_mode=headless cwd=C:\你的\项目
[CLI] codex 完成 session_id=019f...
```

Claude Code 的 `session_id` 来自 `system/init` 或最终 `result` 事件；Codex 的会话标识来自 `thread.started.thread_id`，最终回答取最后一个 `item.completed` 的 `agent_message`。供应商事件先由各自适配器翻译，再交给通用 Runner 处理。

### CLI 流式事件与实时任务卡片

适配器会把供应商 JSONL 统一为会话、工具开始、工具结束、上下文、最终结果和错误事件。Claude Code 同一条 `assistant` 消息中的上下文用量及多个 `tool_use` 都会保留；`tool_result` 通过调用 ID 与开始事件配对。最终结果还会保留耗时、轮次、输入/输出/缓存 Token 和模型上下文窗口等真实统计。

Codex 使用 `item.started/item.completed` 中的 `command_execution`、`file_change`、`web_search` 和 `mcp_tool_call` 展示命令、文件修改、搜索与外部工具轨迹，并用 `item.id` 配对。最终回答来自 `agent_message`，输入、输出、缓存输入和总 Token 来自随后到达的 `turn.completed`；Runner 会合并两条事件。Codex 没有提供的 Claude 对应字段保持为空，不进行估算。

高频事件由 `TaskProgressTracker` 汇总：它支持并行工具调用，记录耗时、失败状态、本轮第一次和最新一次上下文，最多保留最近 12 条完成活动。快照仍会打印到终端，例如：

```text
[进度] 读取文件 detail=package.json tools=0/1 context=18432
[进度] 正在分析执行结果 tools=1/1 context=18432
```

同一份快照还会进入飞书卡片。`ThrottledCardUpdater` 在一秒窗口内只保留最新状态，并串行提交更新，避免高频工具事件触发限流或让画面来回跳动。没有新事件时，每秒心跳仍会推进耗时。

运行中卡片把当前动作放在顶部，只显示最近 3 条轨迹和“停止任务”按钮。成功后答案回到正文顶部，执行统计与最近 8 条轨迹收进折叠面板；失败显示可重试提示并折叠技术错误；取消使用灰色终态。

回答不超过 900 个字符时直接展示，更长时显示预览和折叠全文。超过卡片 6000 字符上限的剩余部分会按不超过 4000 字符的文本消息继续发送，并尽量在换行处切分。

停止按钮通过 `card.action.trigger` 回调。操作者身份只读取飞书平台回传的 `open_id`，并与任务发起人比较；按钮同时携带会话 ID 和每轮唯一运行 ID，因此旧卡片不能停止同一话题后来启动的新任务。按钮只停止本轮，`/close` 会停止本轮并关闭整个会话。

运行 `pnpm start` 后，在飞书新话题发送：

```text
@机器人 请读取 package.json 和 src/index.ts，总结项目的启动流程
```

终端应持续出现 `[进度]`，飞书卡片应每秒最多更新一次，完成后答案出现在绿色卡片正文。同一话题继续追问仍会续接原 CLI 会话。再发送一个长任务并点击“停止任务”，发起人会收到成功 Toast，卡片随后变灰，同一话题仍可继续提问；其他群成员点击时只会收到权限警告。

子进程使用参数数组且不启用 shell。飞书消息中的引号、换行、反引号或 `$()` 都只会成为提示词内容，不能拼接成额外系统命令。Windows 下会绕过 npm 的 `.cmd`/无扩展名包装器，直接启动真实 Node 入口或 exe，仍然保持 `shell=false`。每轮默认不设执行时限；调用方显式传入 `timeoutMs` 时才会自动超时，或由 `/close` 取消并终止 CLI 及其整棵子进程树。

Codex 的 `app-server` 默认通过 stdio 通信，不需要额外的 `--stdio` 参数。首次 `codex exec` 使用 `--sandbox danger-full-access`；`codex exec resume` 使用 `--dangerously-bypass-approvals-and-sandbox`，因为续聊子命令不接受 `--sandbox`。Codex 返回 `stream disconnected before completion: Upstream request failed` 时，Runner 会把它视为瞬时流式断开，最多自动重试 5 次，依次等待 1 秒、1.5 秒、2 秒、2.5 秒、3 秒；已经建立 CLI 会话时优先使用续聊参数，没有会话 ID 时重新发起同一任务。Claude、认证、权限、会话失效和其他普通错误不会自动重试；用户在等待期间发送 `/close` 也会立即取消重试。

### 多 bot 与多引擎首通验收

插件按 cordis.yml 依次装配，启动日志先显示注册数量和会话恢复，再打印 CLI 引擎与每台 bot 的默认配置，随后出现连接成功：

```text
[配置] 已加载 3 个 bot 注册表
[会话] 已恢复 0 个会话
[Bot DEVELOPER] 已连接 name=开发助手 open_id=ou_developer
[Bot REVIEWER] 已连接 name=审查助手 open_id=ou_reviewer
[Bot ASSISTANT] 已连接 name=个人助理 open_id=ou_assistant
[CLI] id=claude command=claude
[CLI] id=codex command=codex
[Bot DEVELOPER] default_cli=claude access_mode=headless workspace=C:\你的\项目
[Bot REVIEWER] default_cli=codex access_mode=headless workspace=C:\审查\项目
[Bot ASSISTANT] default_cli=codex access_mode=headless workspace=C:\你的\项目
Agent OS 启动完成
```

分别新开三个话题，向开发助手、审查助手和个人助理各发一条任务。开发助手应使用 Claude Code，审查助手和个人助理应使用 Codex；同一话题分别 @ 三台 bot 时，`/status` 返回的机器人 ID、执行引擎和 CLI 会话 ID 也应各自独立。

单独发送 `/codex`、`/claude` 或 `/dimagent` 会提示补充任务，不会启动进程；在已建立的话题发送与原引擎不同的前缀，系统会要求新开话题，避免混用不同引擎的会话 ID。新话题可用对应的 `/<引擎> <任务>` 前缀显式选择执行引擎。

真实任务运行期间发送 `/close`，`AbortController` 会终止对应子进程。会话保持 `closed`，不会再发送绿色成功卡片或最终回答。

CLI 返回的会话标识会保存为 `Session.cliSessionId`。同一话题下一轮会自动调用 Claude Code 的 `--resume <session_id>` 或 Codex 的 `exec resume <thread_id>`；新话题没有恢复指针，会从干净上下文开始。

## 同话题任务交接

配置 `reviewBy` 后，普通开发任务成功会按以下顺序交接：

1. 开发 bot 更新原任务卡片为成功状态。
2. Agent OS 在内存收件箱登记 `dispatchId`、来源/目标 bot、原话题 `taskId`、当前 `round`、`maxRounds`、完整审查提示词和工作目录。
3. 开发 bot 回复一张“代码审查已发起”卡片，再回复一条带任务编号的 `post` 消息，真实 `@` 审查 bot。
4. 只有被提及且匹配任务编号的目标 bot 会领取交接单；领取后立即删除，重复事件不会再次执行。
5. 审查 bot 在来源工作目录中启动自己的 CLI 会话，完成后把最终回答作为下一项任务交回开发 bot；开发 bot 会在同一项目中处理反馈。达到轮次上限后，原话题只收到“本轮协作已完成”通知。

卡片只负责展示项目、角色和审查说明，不能替代真实提及。交接单当前保存在内存中，服务在投递后重启会丢失尚未领取的任务；验证交接链路时不要重启服务。

### 多轮协作验收

1. 将开发 bot 的 `reviewBy` 配为 `reviewer`，并让两台 bot 的 `workspace` 都指向同一个真实项目。
2. 运行 `pnpm build`、`pnpm test` 后启动 `pnpm start`，日志应打印两台 bot 的 `name` 和 `open_id`。
3. 在新话题发送 `@开发助手 阅读 TASK.md，完成里面的功能并运行验证。`。
4. 开发任务完成后，应看到“代码审查已发起”卡片和一条新的 `@审查助手` 富文本消息。
5. 审查 bot 应在同一项目中独立检查改动，完成后看到“审查意见已返回”卡片和一条新的 `@开发助手` 富文本消息。
6. 开发 bot 应在同一项目中处理审查反馈；达到 `collaborationMaxRounds` 后停止自动交接。
7. 向非目标 bot 转发这条通知、删除任务编号或重复投递时，目标 bot 都不应启动 CLI。

### 多轮对话验收

1. 新开话题发送“请记住暗号‘Agent 操作系统’，只回复‘记住了’”。
2. 等待完成后，在同一话题追问“我刚才让你记住的暗号是什么？”，回答应包含“Agent 操作系统”。
3. 发送 `/status`，应同时看到 Agent OS 的“会话”和执行引擎的“CLI 会话”。
4. 打开 `data/sessions.json`，对应记录应包含非空 `cliSessionId`。
5. 重启机器人并在原话题继续追问，上下文仍应保留。
6. 新开另一个话题询问暗号，它不应继承上一话题的上下文。

## 会话模型

会话地址按以下优先级确定：

```text
threadId || rootId || messageId
```

再与 `chatId` 和当前 `botId` 组合为查找键。因此同一 bot 在同一群聊、同一话题里的追问会复用相同会话；不同 bot、不同话题或不同群会创建独立会话。普通群和单聊没有话题 ID 时，每条消息使用自身 `messageId` 创建会话。

会话状态流转：

```text
creating → active → idle → active
    └────→ idle（命令）
    └──────────────→ closed
```

- `creating`：刚创建，尚未执行
- `active`：Codex 或 Claude Code 子进程正在运行
- `idle`：上一轮完成，可以继续追问
- `closed`：话题会话已关闭，不再接受任务

执行中的普通消息会收到“当前会话还在执行”的提示，不会启动第二段任务。

每台 bot 的默认执行引擎和接入模式由注册表决定，会话类型支持 `claude`、`codex` 和 `dimagent`。引擎与接入模式只在话题首次创建会话时确定，之后的普通追问、显式引擎前缀和重启恢复都不能改变它。内存中的会话映射会同步保存到 `data/sessions.json`，程序重启后按原 bot、群聊和话题恢复；旧快照没有 `accessMode` 时按 `headless` 恢复。

## 会话持久化与重启恢复

程序启动时会先读取：

```text
data/sessions.json
```

文件不存在时按首次启动处理，日志会显示：

```text
[配置] 已加载 2 个 bot 注册表
[会话] 已恢复 0 个会话
```

每次创建会话、切换状态、更新 CLI 恢复指针或记录待重试任务时，`SessionManager` 都会保存完整快照。保存成功后内存和磁盘一起前进；首次创建保存失败会删除刚建立的内存会话，状态或恢复信息保存失败则回滚到原值。

磁盘存储遵循以下规则：

- 每条记录先经过 Zod 校验，坏记录会被过滤并从清理后的文件中移除。
- 每条记录包含 `botId` 和绝对 `workspaceDir`；升级前缺少 `botId` 或 `workspaceDir` 的旧记录会按 bot 默认目录补齐，并在加载后自动重写为新结构。
- 重启时仍为 `creating` 或 `active` 的会话恢复成 `idle`，因为旧任务进程已经不存在。
- Codex、Claude 和 DimAgent 都可以保存恢复指针。
- 旧记录可以没有 `cliSessionId`；首次任务成功后写入，新记录的空字符串会被视为坏数据。
- CLI 首次返回会话 ID 时会立即写入快照；即使任务随后被停止、超时或进程重启，下一条消息仍会优先尝试续接原会话。
- 若 CLI 明确返回会话不存在或已失效，Agent OS 会清除旧指针；下一次“继续执行”会用原始任务重新建立会话，避免无限重试坏 ID。
- 任务启动前会临时写入 `retryPrompt`，成功后立即删除；若失败发生在 CLI 返回会话 ID 之前，发送“继续执行”等明确重试指令会重放原任务。
- 并发保存通过写入队列串行执行，确保后触发的状态不会被旧快照覆盖。
- 数据先完整写入 `sessions.json.tmp`，再用 `rename` 替换正式文件，避免留下半截 JSON。

PowerShell 中可以检查当前快照：

```powershell
Get-Content -LiteralPath .\data\sessions.json -Encoding utf8
```

重启验收步骤：

1. 在飞书新话题发送任务，等待卡片完成。
2. 在原话题发送 `@机器人 /status`，记下“会话”和“CLI 会话”两个 ID；磁盘状态应为 `idle`。
3. 在终端按 `Ctrl+C`，然后重新运行 `pnpm start`。
4. 启动日志应显示 `[会话] 已恢复 1 个会话`，数量以实际已有话题为准。
5. 在原话题再次发送 `@机器人 /status`，两个会话 ID 都应与重启前相同，状态为“空闲”。
6. 新开话题发送消息，应创建不同的会话 ID。

## 会话命令

命令可以直接发送，也可以带机器人提及：

```text
/status
@机器人 /status
/help
/close
/new
/resume
/compact 保留接口约定，省略排查过程
/claude 检查 package.json
/codex 查看当前目录结构
```

- `/status`：返回 Agent OS 会话 ID、状态、执行引擎、CLI 会话 ID、工作目录、话题 ID 和更新时间
- `/new`：清空当前话题绑定的 CLI 会话；旧会话仍由引擎保留
- `/resume`：读取当前工作目录中的 Claude/Codex 原生会话并用卡片选择恢复
- `/compact [要求]`：在当前 CLI 会话内调用引擎原生上下文整理；Claude 支持附加要求，Codex 使用默认策略
- `/cd`：查看当前工作目录
- `/cd <目录>`：切换当前话题的工作目录
- `/help`：列出会话控制和引擎选择命令
- `/close`：关闭当前话题会话
- `/schedule add "每 30 分钟" <任务>`：创建周期定时任务
- `/schedule list`：查看当前 bot 的定时任务
- `/schedule remove <id>`：删除定时任务
- `/orchestrate <大任务>`：拆解成多个子任务并行派发给团队成员（默认 `topic` 模式：同群多话题并行派发，同一 bot 可跨话题承接多个子任务；`same-topic` 为兼容降级）
- `/panel`：查看当前群聊、当前 bot 创建的编排运行进度（按 chatId + botId 隔离）
- `/claude <任务>`：新话题使用 Claude Code
- `/codex <任务>`：新话题使用 Codex
- `/dimagent <任务>`：新话题使用 DimAgent（接入模式取 bot 的 `accessMode`）

## 定时任务

Agent OS 可以把飞书从“被动响应”升级为“主动指挥”：用 `/schedule` 创建周期任务，到点后由 daemon 自动触发一轮 CLI 执行，并把结果发回配置所在的飞书话题。定时任务复用现有 `tasks` 流水线（任务卡片、进度、停止、结果回传），不重造执行链路。

```text
/schedule add "每 30 分钟" 读取 data/logs/error.log 并总结最新错误
→ 已创建定时任务 #sched-001（每 30 分钟）
  下次触发：14:30
/schedule list
→ #sched-001  每 30 分钟  读取 data/logs/error.log …  下次触发 14:30
/schedule remove sched-001
→ 已删除 #sched-001
```

支持的周期语法（`schedule` 服务插件，`src/plugins/schedule.ts` + `src/plugins/commands/schedule.ts`）：

- **cron 表达式**（5 段）：`0 9 * * *` 表示每天 9 点；由 `croner` 解析与调度。
- **自然语言**：
  - `每 N 分钟`（N 1-59）、`每 N 小时`（N 1-24）、`每 N 天`（N 1-30）
  - `每小时`
  - `每天`、`每天 9:00`、`每天早上9点`

触发语义：

- 到点时先主动发一条“⏰ 定时任务”锚点消息，任务卡片与结果作为它的回复出现在话题中；结果通过现有卡片与通知链路回传。
- 定时任务复用配置话题的会话：目标话题正在执行（`active`）或已关闭（`closed`）时到点触发会跳过并记录 `lastSkippedAt`，不会并发启动。
- 任务配置持久化到 `data/schedules.json`（原子写、Zod 校验、重启恢复），重启后自动重新注册定时器；时区跟随本机（可用 `cordis.yml` 的 `schedule.timezone` 覆盖）。
- 任务卡片上的“停止任务”按钮按配置者的 `openId` 鉴权，配置者可以随时停止定时触发的执行。
- 在 `cordis.yml` 中移除 `schedule` 或 `commands/schedule` 即可整体下线定时能力。

## 多话题并行编排

Agent OS 可以把一个大目标拆成多个可并行的子任务，派发给不同 bot 独立执行，再用一张面板汇总进度——`orchestration` 服务插件 + `/orchestrate`、`/panel` 命令插件。

```text
/orchestrate 检查 TASK.md 里的 A、B、C 三个模块，分别让开发、审查、助理 bot 分析
→ ⏳ 正在拆解任务并派发子任务，请稍候…
→ 已创建 run-001：3 个子任务，已派发给对应成员。
  用 /panel 查看进度。
/panel
→ 编排面板：1 个运行
  run-001 · 1/3 完成
  ✅ 完成 #t1［developer］  分析模块 A …
  ⏳ 等待 #t2［product］    审查模块 B …
  ❌ 失败 #t3［assistant］  整理结论 …
```

流程与语义：

- **拆解**：编排 bot 用自己绑定的 CLI 跑一次独立规划（不复用用户会话上下文），只输出结构化子任务 JSON（`{"tasks":[{"id","prompt","bot"}]}`）；解析容错、字段经 Zod 校验，2 分钟内未返回视为拆解失败。
- **派发方式（默认 `topic`，`same-topic` 为兼容降级）**：`cordis.yml` 的 `orchestration.dispatchMode` 决定。默认 `topic`：每个子任务构造协作交接单（`round=1`/`maxRounds=1`）经 `ctx.collaboration` 注册，再在编排所在群内发一条独立根消息（独立话题）`@` 目标 bot——同一 bot 可跨话题并行承接多个子任务，两个子任务各走各的话题、互不阻塞。`same-topic` 为兼容降级：改在当前话题 `@` 目标 bot，此时同一 bot 的多个子任务会被整轮拒绝。`reviewBy` 交接链不受影响。
- **收集**：子任务成功由 `task/result` 事件驱动为 `done` 并保存回答摘要，失败由 `task/failed` 事件驱动为 `failed`；面板通过 `/panel` 实时查看。
- **生命周期边界**：子任务 ID 会 trim 后校验唯一性；派发接口未返回 `message_id` 会立即将子任务标记为失败并撤销交接单。同一派发尝试的重复 `task/result`/`task/failed` 事件只接受首个终态；run 默认等待结果 30 分钟，超时后未完成子任务自动标记为失败并清理交接单。
- **失败重试**：面板卡片上为 `failed` 子任务渲染「重试」按钮（可选插件 `orchestration/actions` 提供，点击重新派发、带发起人鉴权/防重复/次数上限 `maxRetry`）；也可在话题中直接 `@` 目标 bot 发送“继续执行”让目标 bot 基于已保存的原始子任务重试。移除 `orchestration/actions` 即下线一键重试（无按钮），保留手动「继续执行」。
- **插件化**：`orchestration`（服务）与 `commands/orchestrate`、`commands/panel`（命令）是独立插件，都在 `cordis.yml` 声明；移除 `orchestration` 即整体下线编排，`task/failed` 事件无监听者时自动退化为普通失败收尾。
- 拆解的目标 bot 必须已就绪（运行时存在），否则整轮拒绝并提示。

### 并行编排验收

1. 确认团队中至少两台 bot 在线（`/team` 查看连接状态）。
2. 发送 `/orchestrate 检查 package.json 和 src/index.ts，分别让开发、审查 bot 分析`。
3. 日志应出现 `[编排] run-001 创建，共 2 个子任务`，编排所在群内出现两条独立根消息（各带任务编号、独立话题，默认 `topic` 模式）。
4. 两台目标 bot 各自独立执行（可同时运行，不互相等待）。
5. 完成后发送 `/panel`，卡片显示 `2/2 完成`，各子任务带回答摘要。
6. 在 `cordis.yml` 中移除 `commands/orchestrate`、`commands/panel`、`orchestration` 后重启，现有任务与协作链路仍正常。

### 会话整理与历史恢复验收

在一个已经完成过任务的话题中依次发送：

1. `/new`：收到绿色“新会话已就绪”卡片；下一条任务会建立新 CLI 会话，旧记录仍可恢复。
2. `/resume`：卡片只列出当前 `workspaceDir` 的原生会话，显示标题、更新时间和短 ID；点击“恢复”后当前记录标记为当前会话。
3. `/compact 保留架构决定和待办事项`：蓝色卡片显示整理进度，完成后变为绿色；CLI 会话 ID 保持不变。短 Claude 会话会显示“暂时无需整理”。

按钮回调会重新读取当前工作目录并校验 CLI 会话 ID，历史记录被删除或移出目录后不会被恢复。整理和恢复期间仍遵守单话题单任务状态，发起人可以使用停止按钮取消 compact。

### 工作目录验收

启动 `pnpm start` 后，在 bot 的新话题依次发送：

```text
@机器人 /cd
@机器人 /cd ../another-project
@机器人 /status
```

`/status` 应显示新的绝对工作目录，CLI 会话应为“尚未建立”；下一条任务会在新目录启动。另一个话题或另一台 bot 的 `/status` 应继续显示各自目录。对不存在的目录执行 `/cd` 时会提示错误，原目录不会改变；执行中的任务切换会被拒绝。

如果任务仍在执行，`/close` 会通过 `AbortController` 终止后台 CLI 子进程，并且不会写入绿色成功终态或回复最终答案。关闭后在同一话题发送普通消息，只会收到“请新开一个话题”的提醒。

建议按以下顺序验证：

1. 新话题发送任务，日志显示 `[会话] 新建 ... status=creating`
2. 任务完成后日志显示相同 ID 的 `status=idle`
3. 同一话题继续发送任务，日志显示 `[会话] 复用`
4. 执行中发送普通消息，收到忙碌提示
5. 发送 `/status` 和 `/help` 检查命令回复
6. 新任务执行中发送 `/close`，日志出现 `[CLI] 任务已取消 engine=...`
7. 关闭的话题继续发送消息，收到新开话题提示
8. 新开话题后应得到不同的会话 ID，并能正常完成任务

## OWNER_OPEN_ID

自己发送一条消息后，把日志中 `sender=` 后面的 `ou_` 值写入 `.env`：

```dotenv
OWNER_OPEN_ID=ou_你的OpenID
```

后续需要点名提醒真人时，可以发送飞书的 `at` 标签：

```typescript
await bot.reply(
  message.messageId,
  `<at user_id="${process.env.OWNER_OPEN_ID}"></at> 收到，这条是点名回复`,
);
```

暂时不需要申请“获取群信息”权限；等需要枚举群成员时，再使用群成员列表接口。
