# 执行引擎接入指南

ThreadPilot 本身**不重复造 Agent 轮子**，而是将你本地已经安装、配置好并信任的 AI 编程 CLI 接入飞书。

通过「一切皆为插件」的架构，ThreadPilot 现已原生支持 5 种执行引擎与标准接入协议：

| 引擎名称 | 引擎 ID (`defaultCli`) | 调度命令 | 支持模式 | 认证与运行特性 |
| :--- | :--- | :---: | :---: | :--- |
| **OpenAI Codex** | `codex` | `/codex` | `headless` | 主路径，支持 app-server 协议、原生 compact 与代码审查 |
| **Claude Code** | `claude` | `/claude` | `headless` / `acp` | Anthropic 官方 CLI，工具调用解析细腻，支持原生 compact |
| **DimAgent** | `dimagent` | `/dimagent` | `headless` / `acp` | 支持独立工作区 `.mcp.json`，支持设备码认证 |
| **Antigravity** | `agy` | `/agy` | `headless` | Google 官方 CLI，支持飞书卡片直接引导 OAuth 登录 |
| **通用 ACP 引擎** | 自定义 | - | `acp` | 基于标准 Agent Client Protocol 接入任何 CLI |

---

## 一、OpenAI Codex

### 1. 本机安装与登录
确保开发机已安装 Codex CLI 并在终端中完成首次登录：
```bash
# 验证安装
codex --version

# 验证本地登录与连通性
codex exec --sandbox workspace-write "1加1等于几？只回答数字本身"
```

### 2. 在 ThreadPilot 中配置
在 `config/bots.json` 中，将成员的 `defaultCli` 设置为 `codex`：
```json
{
  "id": "developer",
  "defaultCli": "codex",
  "accessMode": "headless"
}
```

---

## 二、Anthropic Claude Code

### 1. 本机安装与登录
确保开发机已安装 Claude Code：
```bash
# 验证安装
claude --version

# 验证认证状态
claude -p "1加1等于几？只回答数字本身" --output-format stream-json
```

### 2. 在 ThreadPilot 中配置
在 `config/bots.json` 中配置：
```json
{
  "id": "reviewer",
  "defaultCli": "claude",
  "accessMode": "headless"
}
```

---

## 三、Google Antigravity (agy)

### 1. 本机安装与配置
Antigravity CLI 通常位于系统路径中，可直接执行：
```bash
agy --version
```

### 2. 飞书卡片引导登录（免开终端）
agy 支持无头（headless）模式与卡片登录协议。如果尚未登录或凭据失效，直接在飞书话题中发送：
```text
@机器人 /agy login
```
机器人会弹出登录交互卡片，提供浏览器授权 URL。你在浏览器完成授权后将授权码粘贴回卡片，ThreadPilot 会自动完成认证并写入 `~/.gemini/antigravity-cli`，后续运行完全免密。

在 `config/bots.json` 中配置：
```json
{
  "id": "developer",
  "defaultCli": "agy",
  "accessMode": "headless"
}
```

---

## 四、DimAgent

DimAgent 支持两种接入方式：
1. **headless 模式**：通过项目工作区的 `.mcp.json` 自动挂载应用工具；
2. **标准 acp 模式**：通过 `dim acp` 以通用常驻进程方式连接。

在 `config/bots.json` 中配置：
```json
{
  "id": "developer",
  "defaultCli": "dimagent",
  "accessMode": "acp"
}
```

---

## 五、标准 ACP（Agent Client Protocol）接入

除了针对特定 CLI 的适配器，ThreadPilot 还实现了标准的 **Agent Client Protocol (ACP)** 通信协议。

这意味着：**任何提供 ACP Server 能力的命令行工具，无需为它编写一行专用适配代码，即可直接接入 ThreadPilot。**

### 配置方式
在 `cordis.yml` 中的 `engines/acp` 插件中声明引擎参数：
```yaml
plugins:
  - name: engines/acp
    config:
      engines:
        - id: my-agent
          displayName: "我的定制 Agent"
          command: "my-agent-cli"
          args: ["acp", "--server"]
```
然后在 `config/bots.json` 中将 bot 的 `defaultCli` 设为 `my-agent`，`accessMode` 设为 `acp` 即可。

---

## 六、国内网络代理配置

对于使用境外大模型（如 Claude 或 Gemini）的引擎，如果开发机需要走 HTTP/SOCKS 代理：

1. **全局代理（推荐）**：在 `.env` 中设置：
   ```dotenv
   HTTP_PROXY=http://127.0.0.1:10808
   HTTPS_PROXY=http://127.0.0.1:10808
   ALL_PROXY=http://127.0.0.1:10808
   NO_PROXY=localhost,127.0.0.1,::1
   ```
   所有无头 CLI 启动时都会自动注入该代理环境变量。

2. **单 Bot 独立代理**：如果不同 Bot 走不同网络线路，在 `config/bots.json` 中指定：
   ```json
   {
     "id": "claude-bot",
     "defaultCli": "claude",
     "proxy": "http://127.0.0.1:7890"
   }
   ```

---

## 七、显式切换引擎运行

即便某台 Bot 配置了默认的 `defaultCli: "codex"`，你依然可以在飞书话题中临时指定其他引擎执行单次任务：

- `@机器人 /claude 分析当前组件的渲染性能并重构`
- `@机器人 /codex 检查并补全所有缺失的单元测试`
- `@机器人 /agy 修复构建脚本中的语法错误`

ThreadPilot 会使用该命令指定的 CLI 引擎启动全新会话，执行完毕后结果原样返回卡片。
