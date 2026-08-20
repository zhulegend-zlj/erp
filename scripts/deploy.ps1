<#
.SYNOPSIS
  ERP 一键部署脚本。
.DESCRIPTION
  依次执行：
    a. 前端：npm install + npm run build（产物 frontend\dist）
    b. 后端：npm install + npx prisma migrate deploy + npx prisma generate
  最后输出启动命令与说明。

  参数：
    -SkipFrontend  跳过前端安装与构建
    -SkipBackend   跳过后端安装与迁移/生成

.EXAMPLE
  .\scripts\deploy.ps1
  .\scripts\deploy.ps1 -SkipFrontend
#>

[CmdletBinding()]
param(
  [switch]$SkipFrontend,
  [switch]$SkipBackend
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$frontendDir = Join-Path $Root 'frontend'
$backendDir = Join-Path $Root 'backend'

Write-Host ''
Write-Host 'ERP 一键部署' -ForegroundColor Cyan
Write-Host "项目根目录: $Root"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '错误：未找到 node，请先安装 Node.js 22+ 并加入 PATH。' -ForegroundColor Red
  exit 1
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Host '错误：未找到 npm，请先安装 Node.js 22+。' -ForegroundColor Red
  exit 1
}

# ---------- 前端 ----------
if (-not $SkipFrontend) {
  Write-Host ''
  Write-Host '==> 前端：npm install' -ForegroundColor Yellow
  Push-Location $frontendDir
  try {
    npm install
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($code -ne 0) { Write-Host "错误：前端 npm install 失败（退出码 $code）。" -ForegroundColor Red; exit 1 }
  Write-Host '完成：前端 npm install' -ForegroundColor Green

  Write-Host ''
  Write-Host '==> 前端：npm run build' -ForegroundColor Yellow
  Push-Location $frontendDir
  try {
    npm run build
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($code -ne 0) { Write-Host "错误：前端 npm run build 失败（退出码 $code）。" -ForegroundColor Red; exit 1 }
  Write-Host '完成：前端 npm run build（产物 frontend\dist）' -ForegroundColor Green
}

# ---------- 后端 ----------
if (-not $SkipBackend) {
  $envFile = Join-Path $backendDir '.env'
  if (-not (Test-Path $envFile)) {
    Write-Host '错误：backend\.env 不存在。请先按 README.md 配置 DATABASE_URL / JWT_SECRET / PORT。' -ForegroundColor Red
    exit 1
  }

  Write-Host ''
  Write-Host '==> 后端：npm install' -ForegroundColor Yellow
  Push-Location $backendDir
  try {
    npm install
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($code -ne 0) { Write-Host "错误：后端 npm install 失败（退出码 $code）。" -ForegroundColor Red; exit 1 }
  Write-Host '完成：后端 npm install' -ForegroundColor Green

  Write-Host ''
  Write-Host '==> 后端：npx prisma migrate deploy' -ForegroundColor Yellow
  Push-Location $backendDir
  try {
    npx prisma migrate deploy
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($code -ne 0) { Write-Host "错误：npx prisma migrate deploy 失败（退出码 $code）。请确认 PostgreSQL 已启动、backend\.env 的 DATABASE_URL 正确。" -ForegroundColor Red; exit 1 }
  Write-Host '完成：npx prisma migrate deploy' -ForegroundColor Green

  Write-Host ''
  Write-Host '==> 后端：npx prisma generate' -ForegroundColor Yellow
  Push-Location $backendDir
  try {
    npx prisma generate
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($code -ne 0) { Write-Host "错误：npx prisma generate 失败（退出码 $code）。" -ForegroundColor Red; exit 1 }
  Write-Host '完成：npx prisma generate' -ForegroundColor Green
}

# ---------- 启动说明 ----------
Write-Host ''
Write-Host '================ 部署完成 ================' -ForegroundColor Cyan
Write-Host ''
Write-Host '1) 启动后端（监听 3000，读取 backend\.env）：' -ForegroundColor White
Write-Host '   cd backend' -ForegroundColor Gray
Write-Host '   npm run start' -ForegroundColor Gray
Write-Host ''
Write-Host '2) 前端产物 frontend\dist 的托管方式（二选一）：' -ForegroundColor White
Write-Host '   A. 简单方式（本机测试）:  cd frontend; npx serve -s dist -l 5173' -ForegroundColor Gray
Write-Host '   B. 生产方式: 用 Nginx 等反向代理托管 dist，并把 /api 转发到 127.0.0.1:3000' -ForegroundColor Gray
Write-Host ''
Write-Host '   注意：前端请求 /api，npx serve 本身不代理接口；' -ForegroundColor Yellow
Write-Host '   快速联调也可用开发服务器:  cd frontend; npm run dev  (已内置 /api 代理到 127.0.0.1:3000)' -ForegroundColor Yellow
Write-Host ''
Write-Host '3) 浏览器访问：http://localhost:5173' -ForegroundColor White
Write-Host ''
Write-Host '   更多说明（建库、初始账号、开机自启、每日备份）见项目根 README.md。' -ForegroundColor Gray
Write-Host ''
