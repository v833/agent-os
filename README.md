# Agent OS

当前阶段是飞书 echo bot：通过 WebSocket 长连接接收消息，再通过 REST API 原样回复。

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

看到 `ws client ready` 后，在测试群里 `@机器人` 发送消息。终端应输出：

```text
[收到] chat=oc_xxx type=group sender=ou_xxx 内容: @_user_1 你好
[已回] message_id=om_xxx
```

群里会收到机器人回复。群聊中不带 `@机器人` 的普通消息默认不会推送给应用。

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
