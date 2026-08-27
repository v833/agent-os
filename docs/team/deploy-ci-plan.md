# Agent OS 文档公网部署与 CI/CD 自动化方案

本文档由 **CEO 助理（Team Leader）** 统筹，记录 Agent OS VitePress 文档中心的公网部署拓扑、服务器环境、Cloudflare 接入以及自动化 CI/CD 机制。

---

## 1. 公网访问与服务器架构

### 1.1 访问入口
- **公网 HTTPS URL**：`https://agent-os.wq1115.com/`
- **DNS 记录**：`agent-os.wq1115.com`（CNAME 指向 Cloudflare Tunnel，开启 Proxied 保护与自动 SSL 证书）
- **路由拓扑**：
  `Client HTTPS` ──► `Cloudflare Edge` ──► `Cloudflare Tunnel` ──► `172.22.0.1:5860` ──► `Nginx 容器 (agent-os-docs)`

### 1.2 服务器端基础设施
- **目标服务器**：`103.240.199.204`
- **静态资源根目录**：`/opt/agent-os-docs/dist`
- **容器服务**：`agent-os-docs`（基于 `nginx:alpine`，自动重启策略 `unless-stopped`，监听内部端口 `5860`）

---

## 2. CI/CD 自动化流水线

### 2.1 GitHub Actions 工作流
- **工作流文件**：`.github/workflows/deploy-docs.yml`
- **触发条件**：代码推送到 `main` 分支，且命中 `docs/**` 或依赖文件改动。
- **构建执行**：自动化执行 `pnpm install` 与 `pnpm docs:build`。
- **自动部署**：通过 SSH / rsync 自动将生成的静态文件同步更新至服务器 `/opt/agent-os-docs/dist/`，即刻在公网生效。

### 2.2 仓库 Secrets 配置要求
在 GitHub 仓库 Settings -> Secrets and variables -> Actions 中配置以下参数：
- `SERVER_HOST`：`103.240.199.204`（选填，工作流已设为默认值）
- `SERVER_USER`：`root`
- `SERVER_SSH_KEY`：部署私钥（对应机器公钥已配置在服务器 `~/.ssh/authorized_keys` 中）

---

## 3. 本地与服务器快速运维

- **本地一键部署更新**：执行 `pwsh scripts/deploy-docs.ps1`，即可一键完成“本地构建 -> 上传服务器 -> 公网健康检查”。
- **服务器端自动化脚本**：`scripts/deploy-docs-server.sh`。
