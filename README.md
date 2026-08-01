# Agent OS

当前阶段支持从飞书话题真实调度 Codex 或 Claude Code，完成后更新任务卡片并把最终回答送回原话题。同一话题会续接 CLI 上下文，会话和恢复指针都可跨进程重启恢复，同时保留 `@` 提及、富文本代码以及图片和文件下载能力。

## 飞书开放平台配置

1. 在[飞书开放平台](https://open.feishu.cn/)创建“飞书智能体应用”。
2. 确认应用已启用机器人能力，并订阅 `im.message.receive_v1` 事件。
3. 事件接收方式选择“使用长连接接收事件”。
4. 创建一个话题群，在群设置的“群机器人”中加入该应用。
5. 将 App ID 和 App Secret 写入本地 `.env`：

```dotenv
BOT_A_APP_ID=cli_你的AppID
BOT_A_APP_SECRET=你的AppSecret
```

`.env` 已被 Git 忽略，禁止提交真实凭证。

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

Claude Code 尚未安装时执行：

```powershell
npm install -g @anthropic-ai/claude-code
claude
```

首次运行 `claude` 时完成 Anthropic 登录。使用 DeepSeek 等兼容后端时，把供应商地址、认证令牌和模型配置保存在用户级 `~/.claude/settings.json`，不要写入项目或提交仓库。

在 `.env` 中选择新话题默认使用的引擎和工作目录：

```dotenv
CLI_ENGINE=codex
CODEX_WORKDIR=C:\你的\项目\绝对路径
CLAUDE_WORKDIR=C:\你的\项目\绝对路径
```

- `CLI_ENGINE` 只能是 `codex` 或 `claude`，留空时默认使用 Codex。
- 对应工作目录留空时使用 Agent OS 的启动目录。
- 工作目录决定 CLI 读取、修改和执行命令的项目，启动前必须确认路径正确。
- CLI 的本地会话与工作目录绑定；建立会话后不要修改对应 `CODEX_WORKDIR` 或 `CLAUDE_WORKDIR`，否则恢复指针可能失效。
- 已持久化话题继续使用自己的 `cliId`；切换 `CLI_ENGINE` 只影响之后创建的新话题。

Codex 通过 `codex exec --json --full-auto --skip-git-repo-check` 运行，允许在配置的工作目录内修改文件。Claude Code 通过 `claude -p --output-format stream-json --verbose` 运行，权限和模型后端沿用用户级 Claude Code 配置。

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
2. 在原话题发送蓝色的“Codex 任务”或“Claude Code 任务”卡片。
3. 后台启动真实 CLI 子进程，飞书长连接仍可处理 `/status` 和 `/close`。
4. 按行解析 stdout 中的 JSONL；普通诊断噪音会被忽略。
5. 成功时把原卡片更新为绿色 `100%`，再把最终回答回复到同一话题。
6. 失败时把卡片更新为红色，并在同一话题回复具体错误。
7. 最后清理运行记录，把未关闭的会话持久化为 `idle`。

终端会输出实际引擎和工作目录：

```text
[CLI] command=codex cwd=C:\你的\项目
[CLI] 启动 engine=codex cwd=C:\你的\项目
[CLI] 完成 engine=codex session_id=019f...
```

Claude Code 的 `session_id` 来自 `system/init` 或最终 `result` 事件；Codex 的会话标识来自 `thread.started.thread_id`，最终回答取最后一个 `item.completed` 的 `agent_message`。供应商事件先由各自适配器翻译，再交给通用 Runner 处理。

子进程使用参数数组且不启用 shell。飞书消息中的引号、换行、反引号或 `$()` 都只会成为提示词内容，不能拼接成额外系统命令。Windows 下会绕过 npm 的 `.cmd`/无扩展名包装器，直接启动真实 Node 入口或 exe，仍然保持 `shell=false`。每轮默认最多执行 10 分钟；超时或 `/close` 取消时会终止 CLI 及其整棵子进程树。

### 双引擎首通验收

Codex：

1. 设置 `CLI_ENGINE=codex` 并运行 `pnpm start`。
2. 新开飞书话题发送只读任务。
3. 确认出现“Codex 任务”卡片，完成后变绿并收到真实回答。
4. 终端应打印 Codex `session_id`。

Claude Code：

1. 先在同一终端手动执行一次 `claude -p "只回答 2" --output-format stream-json --verbose`，确认认证和模型后端可用。
2. 设置 `CLI_ENGINE=claude`；watch 模式会因 `.env` 变化自动重启。
3. 新开飞书话题发送只读任务，旧话题仍保留原执行引擎。
4. 确认出现“Claude Code 任务”卡片，完成后变绿并收到真实回答。
5. 终端应打印 Claude Code `session_id`。

真实任务运行期间发送 `/close`，`AbortController` 会终止对应子进程。会话保持 `closed`，不会再发送绿色成功卡片或最终回答。

CLI 返回的会话标识会保存为 `Session.cliSessionId`。同一话题下一轮会自动调用 Claude Code 的 `--resume <session_id>` 或 Codex 的 `exec resume <thread_id>`；新话题没有恢复指针，会从干净上下文开始。

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

再与 `chatId` 组合为查找键。因此同一群聊、同一话题里的追问会复用相同会话；不同话题或不同群会创建新会话。普通群和单聊没有话题 ID 时，每条消息使用自身 `messageId` 创建会话。

会话状态流转：

```text
creating → active → idle → active
    └──────────────→ closed
```

- `creating`：刚创建，尚未执行
- `active`：Codex 或 Claude Code 子进程正在运行
- `idle`：上一轮完成，可以继续追问
- `closed`：话题会话已关闭，不再接受任务

执行中的普通消息会收到“当前会话还在执行”的提示，不会启动第二段任务。

当前默认执行引擎为 `codex`，会话类型同时支持 `claude`。内存中的会话映射会同步保存到 `data/sessions.json`，程序重启后按原群聊和话题恢复。

## 会话持久化与重启恢复

程序启动时会先读取：

```text
data/sessions.json
```

文件不存在时按首次启动处理，日志会显示：

```text
[会话] 已恢复 0 个会话
```

每次创建会话、切换状态或更新 CLI 恢复指针时，`SessionManager` 都会保存完整快照。保存成功后内存和磁盘一起前进；首次创建保存失败会删除刚建立的内存会话，状态或恢复指针保存失败则回滚到原值。

磁盘存储遵循以下规则：

- 每条记录先经过 Zod 校验，坏记录会被过滤并从清理后的文件中移除。
- 重启时仍为 `creating` 或 `active` 的会话恢复成 `idle`，因为旧任务进程已经不存在。
- Codex 和 Claude 两种 `cliId` 都可以恢复。
- 旧记录可以没有 `cliSessionId`；首次任务成功后写入，新记录的空字符串会被视为坏数据。
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
```

- `/status`：返回 Agent OS 会话 ID、状态、执行引擎、CLI 会话 ID、话题 ID 和更新时间
- `/help`：列出三条命令
- `/close`：关闭当前话题会话

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
