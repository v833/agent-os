# 5 分钟快速上手

本篇帮助你在 **5 分钟内** 将第一台 AI 编程 Bot 接入飞书话题群并跑通第一轮代码任务。

---

## 准备工作

在开始之前，请确认你的开发机满足以下基本环境：
1. **Node.js**：版本 `>= 22.0.0`。
2. **已就绪的编程 CLI**：确保本机终端已安装并登录了至少一个支持的编程 CLI（如 `codex`、`claude`、`dim` 或 `agy`），可以在终端直接执行 `codex --version` 或 `claude --version`。

---

## 步骤 1：安装 ThreadPilot

你可以选择全局安装或从源码运行：

::: code-group
```bash [全局安装（推荐）]
npm install -g threadpilot@latest

# 验证安装（提供 tpl 与 threadpilot 两个命令别名）
tpl -v
```

```bash [源码克隆]
git clone https://github.com/v833/threadpilot.git
cd threadpilot
pnpm install
```
:::

---

## 步骤 2：在飞书开放平台极速建应用（1分钟）

1. 登录 [飞书开放平台](https://open.feishu.cn/)，点击「创建企业自建应用」，填写应用名称（如 `代码开发助手`）。
2. **开启机器人**：在左侧导航点击「添加应用能力」→ 选择「机器人」并确认。
3. **开启长连接**：在左侧导航点击「事件与回调」→ 接收方式选择 **「使用长连接接收事件」**（无需公网 IP 和 Webhook）。
4. **订阅消息事件**：在同一页面点击「添加事件」→ 搜索并添加 `im.message.receive_v1`（接收群聊/私聊消息）。
5. **申请权限**：在左侧「权限管理」中开通：
   - `im:message`（获取与发送单聊/群聊消息）
   - `im:message:send_as_bot`（以应用身份发消息）
6. **创建版本并发布**：在左侧「版本管理与发布」点击「创建版本」，填写版本号并申请发布（企业内部自建应用通常可秒级通过）。
7. **获取凭证**：在左侧「凭证与基础信息」中复制 **App ID** 和 **App Secret**。

> 详细配置与权限说明可查看 [飞书应用创建与配置指南](/guide/feishu-setup)。

---

## 步骤 3：准备本地配置文件

新建一个空目录用于存放你的机器人配置（如果使用源码，直接在项目根目录操作）：

### 1. 配置 `.env`
在工作目录中创建 `.env` 文件，填入刚才复制的飞书应用凭证：

```dotenv
FEISHU_DEVELOPER_APP_ID=cli_a1b2c3d4e5f6
FEISHU_DEVELOPER_APP_SECRET=xxxxxxxxxxxxxxxxxxxx
```

> 如果访问 Claude / Gemini / OpenAI 需要代理，可以在 `.env` 中添加 `HTTPS_PROXY=http://127.0.0.1:10808`。

### 2. 配置 `config/bots.json`
在工作目录创建 `config/bots.json`。初次体验只需配置一台 Bot：

```json
{
  "teamLeader": "developer",
  "bots": [
    {
      "id": "developer",
      "appIdEnv": "FEISHU_DEVELOPER_APP_ID",
      "appSecretEnv": "FEISHU_DEVELOPER_APP_SECRET",
      "defaultCli": "codex",
      "accessMode": "headless",
      "workspace": ".",
      "role": "开发工程师，负责理解需求并编写代码",
      "systemPrompt": "你是核心开发工程师，请务必直接、务实地解决问题。"
    }
  ]
}
```
- `defaultCli`：改为你本地已安装好的 CLI 名称（`codex`、`claude`、`dimagent` 或 `agy`）。
- `workspace`：机器人默认操作的代码库目录，`.` 表示当前目录，也可以填绝对路径如 `C:/projects/my-web-app`。

---

## 步骤 4：启动服务

在包含 `.env` 与 `config/bots.json` 的目录下启动服务：

::: code-group
```bash [全局命令]
tpl
```

```bash [源码方式]
pnpm start
```
:::

当控制台打印出：
```text
[飞书] developer 长连接建立成功
[ThreadPilot] 服务已就绪
```
即代表你的本地开发环境已与飞书开放平台打通！

---

## 步骤 5：在飞书话题群中执行任务

1. **拉机器人进群**：在飞书群聊设置中，点击「添加群机器人」→ 选择你刚刚创建的 `代码开发助手`。
2. **在群内发起任务**：在群里新建一个话题，`@代码开发助手` 发出第一条指令：
   ```text
   @代码开发助手 请检查当前目录下的 package.json，告诉我这个项目的名称和核心依赖
   ```
3. **观察卡片实时流式反馈**：
   - 飞书会立即推送一张**蓝色执行卡片**，动态展示 CLI 正在调用的工具（如查看文件 `package.json`）、运行耗时和 Token 消耗。
   - 任务成功后，卡片自动变为**绿色完成卡片**，给出结构化回答。
   - 遇到死循环或耗时过长，发起人可随时点击卡片右下角的「停止」按钮强制中断。
4. **同话题追问**：
   在刚才产生的话题下方直接回复：
   ```text
   依赖里有哪些是 build 构建相关的依赖？
   ```
   ThreadPilot 会自动带上上一轮对话上下文，精准回答你的追问，无需重新交代背景。

---

## 下一步

- **需要组建多角色团队？** 阅读 [团队 Bot 协同工作流](/guide/team-agents)，配置产品经理、架构师与 QA 工程师多模型审查。
- **需要周期性自动化巡检？** 阅读 [定时任务](/guide/schedule)，用一句话创建每小时或每日自动任务。
- **需要任务可视化？** 阅读 [飞书多维表格看板](/guide/board)，一键初始化双向同步的任务大盘。

