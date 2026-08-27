# Agent OS Docs 一键构建并部署至服务器
param(
    [string]$Server = "103.240.199.204",
    [string]$User = "root",
    [string]$KeyPath = "$HOME\.ssh\id_ed25519_codex_103_240_199_204",
    [string]$RemoteDir = "/opt/agent-os-docs/dist/"
)

$ErrorActionPreference = "Stop"

Write-Host "===> 1. 正在执行本地文档构建 (pnpm docs:build)..." -ForegroundColor Cyan
pnpm docs:build

Write-Host "===> 2. 正在上传构建产物至目标服务器 $Server..." -ForegroundColor Cyan
scp -i $KeyPath -r docs/.vitepress/dist/* "${User}@${Server}:${RemoteDir}"

Write-Host "===> 3. 正在验证公网服务响应 (https://agent-os.wq1115.com/)..." -ForegroundColor Cyan
$res = Invoke-WebRequest -Uri "https://agent-os.wq1115.com/" -UseBasicParsing
if ($res.StatusCode -eq 200) {
    Write-Host "===> 部署成功！公网访问正常: https://agent-os.wq1115.com/" -ForegroundColor Green
} else {
    Write-Warning "公网响应状态码: $($res.StatusCode)"
}
