# Agent OS

当前阶段支持“一个飞书话题对应一个 Agent OS 会话”，会话可跨进程重启恢复，并保留任务卡片、`@` 提及解析以及图片和文件下载能力。

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

`text` 消息正文中的 `@_user_N` 会被还原为显示名；`post` 消息中的 `at` 标签不会混入正文，此时以 `mentions` 日志中的身份和 `open_id` 为准。

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

## 会自动刷新的任务卡片

在话题里发送：

```text
@机器人 帮我执行一个模拟任务
```

预期过程：

- 当前话题出现一张蓝色共享卡片，初始进度为 `0%`
- 八个模拟步骤每隔约 `700ms` 产生一次进度
- 两秒窗口内只提交最新状态，因此通常有约两次中间刷新，再立即提交一次最终状态
- 更新始终修改原卡片，不会连续发送新消息
- 运行中进度最多到 `90%`
- 完成时卡片立即变绿、进度为 `100%`、按钮显示“已完成”

对应终端日志：

```text
[卡片] 已发送 message_id=om_xxx inThread=true
[进度] 11% 读取项目结构
...
[卡片] 已刷新
...
[卡片] 任务完成
```

卡片使用 JSON 2.0，并设置 `config.update_multi=true`，确保后续更新同步给所有查看者。蓝色、绿色和红色分别表示运行中、已完成和执行失败；按钮目前禁用，卡片点击与审批回调留到后续实现。

正常进度只刷新卡片，不发送 `@` 通知。只有异常、权限不足或等待人工审批时，后续流程才使用 `OWNER_OPEN_ID` 点名提醒。

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
- `active`：模拟任务正在运行
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

每次创建会话或切换状态时，`SessionManager` 都会保存完整快照。保存成功后内存和磁盘一起前进；首次创建保存失败会删除刚建立的内存会话，状态切换保存失败则回滚到原状态。

磁盘存储遵循以下规则：

- 每条记录先经过 Zod 校验，坏记录会被过滤并从清理后的文件中移除。
- 重启时仍为 `creating` 或 `active` 的会话恢复成 `idle`，因为旧任务进程已经不存在。
- Codex 和 Claude 两种 `cliId` 都可以恢复。
- 并发保存通过写入队列串行执行，确保后触发的状态不会被旧快照覆盖。
- 数据先完整写入 `sessions.json.tmp`，再用 `rename` 替换正式文件，避免留下半截 JSON。

PowerShell 中可以检查当前快照：

```powershell
Get-Content -LiteralPath .\data\sessions.json -Encoding utf8
```

重启验收步骤：

1. 在飞书新话题发送任务，等待卡片完成。
2. 在原话题发送 `@机器人 /status`，记下会话 ID；磁盘状态应为 `idle`。
3. 在终端按 `Ctrl+C`，然后重新运行 `pnpm start`。
4. 启动日志应显示 `[会话] 已恢复 1 个会话`，数量以实际已有话题为准。
5. 在原话题再次发送 `@机器人 /status`，会话 ID 应与重启前相同，状态为“空闲”。
6. 新开话题发送消息，应创建不同的会话 ID。

## 会话命令

命令可以直接发送，也可以带机器人提及：

```text
/status
@机器人 /status
/help
/close
```

- `/status`：返回会话 ID、状态、执行引擎、话题 ID 和更新时间
- `/help`：列出三条命令
- `/close`：关闭当前话题会话

如果任务仍在执行，`/close` 会通过 `AbortController` 取消后台模拟任务，停止卡片刷新，并且不会写入绿色的成功终态。关闭后在同一话题发送普通消息，只会收到“请新开一个话题”的提醒。

建议按以下顺序验证：

1. 新话题发送任务，日志显示 `[会话] 新建 ... status=creating`
2. 任务完成后日志显示相同 ID 的 `status=idle`
3. 同一话题继续发送任务，日志显示 `[会话] 复用`
4. 执行中发送普通消息，收到忙碌提示
5. 发送 `/status` 和 `/help` 检查命令回复
6. 新任务执行中发送 `/close`，日志出现 `[卡片] 任务已取消`
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
