#!/usr/bin/env bash
set -e

# 服务器端自动化拉取代码与构建部署脚本
PROJECT_DIR="/opt/agent-os"
DOCS_DIST="/opt/agent-os-docs/dist"

echo "===> Pulling latest code..."
cd "$PROJECT_DIR"
git pull origin main

echo "===> Building documentation..."
pnpm install --frozen-lockfile
pnpm docs:build

echo "===> Syncing to static directory..."
rsync -av --delete docs/.vitepress/dist/ "$DOCS_DIST/"

echo "===> Docs updated successfully!"
