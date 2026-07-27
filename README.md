# Agent OS

当前阶段支持飞书话题内回复、`@` 提及解析，以及图片和文件下载。

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
[已回] message_id=om_xxx inThread=true
```

根消息的 `rootId` 可能为空，但话题消息会带 `threadId`；已有话题内的回复通常同时带 `threadId` 和 `rootId`。机器人回复应留在当前话题。

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
