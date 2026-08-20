<#
.SYNOPSIS
  ERP PostgreSQL 数据库备份脚本。
.DESCRIPTION
  使用 pg_dump 将 erp 数据库备份到 D:\erp-backups\，文件名 erp-YYYYMMDD-HHMMSS.sql，
  保留最近 30 份（自动删除更旧的），日志写入 D:\erp-backups\backup.log。

  pg_dump 定位优先级：
    1. -PgBin 参数（目录或 pg_dump.exe 完整路径）
    2. 环境变量 $env:PGBIN
    3. 常见 PostgreSQL 安装路径（16/15/14 标准安装、D:\pg16 便携版）
    4. PATH 中的 pg_dump

.EXAMPLE
  .\scripts\backup.ps1
  .\scripts\backup.ps1 -DbName erp -BackupDir D:\erp-backups -User postgres -Retention 30
#>

[CmdletBinding()]
param(
  [string]$DbName = 'erp',
  [string]$BackupDir = 'D:\erp-backups',
  [string]$PgBin = $env:PGBIN,
  [string]$DbHost = 'localhost',
  [int]$Port = 5432,
  [string]$User = 'postgres',
  [int]$Retention = 30
)

$ErrorActionPreference = 'Stop'
$script:LogPath = $null

function Write-Log {
  param([string]$Message)
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Write-Host $line
  if ($script:LogPath) {
    try {
      $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
      [System.IO.File]::AppendAllText($script:LogPath, $line + [Environment]::NewLine, $utf8NoBom)
    } catch {
      Write-Host "警告：写入日志失败 - $($_.Exception.Message)"
    }
  }
}

# 1. 创建备份目录
if (-not (Test-Path $BackupDir)) {
  New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
}
$script:LogPath = Join-Path $BackupDir 'backup.log'
Write-Log '===== 开始备份 ====='

# 2. 定位 pg_dump
$pgDump = $null
if ($PgBin) {
  if ((Test-Path $PgBin) -and ($PgBin -like '*.exe')) {
    $pgDump = $PgBin
  } elseif (Test-Path (Join-Path $PgBin 'pg_dump.exe')) {
    $pgDump = Join-Path $PgBin 'pg_dump.exe'
  } else {
    Write-Log "警告：-PgBin/PGBIN 指定的路径下未找到 pg_dump.exe: $PgBin"
  }
}
if (-not $pgDump) {
  $candidates = @(
    'C:\Program Files\PostgreSQL\16\bin\pg_dump.exe',
    'C:\Program Files\PostgreSQL\15\bin\pg_dump.exe',
    'C:\Program Files\PostgreSQL\14\bin\pg_dump.exe',
    'D:\pg16\pgsql\bin\pg_dump.exe',
    'D:\pg16\bin\pg_dump.exe'
  )
  foreach ($c in $candidates) {
    if (Test-Path $c) { $pgDump = $c; break }
  }
}
if (-not $pgDump) {
  $cmd = Get-Command pg_dump -ErrorAction SilentlyContinue
  if ($cmd) { $pgDump = $cmd.Source }
}
if (-not $pgDump) {
  Write-Log '错误：未找到 pg_dump。请用 -PgBin 或环境变量 PGBIN 指定 PostgreSQL 的 bin 目录。'
  exit 1
}
Write-Log "pg_dump 路径: $pgDump"

# 3. 生成带时间戳的文件名
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outFile = Join-Path $BackupDir "erp-$stamp.sql"

# 4. 执行备份（-w/--no-password：无人值守时不弹密码提示）
#    计划任务运行时请设置环境变量 PGPASSWORD，或使用 pg_hba.conf trust / %APPDATA%\postgresql\pgpass.conf。
$pgArgs = @('-h', $DbHost, '-p', "$Port", '-U', $User, '-w', '--no-owner', '-f', $outFile, $DbName)
Write-Log "执行: $pgDump -h $DbHost -p $Port -U $User -w --no-owner -f $outFile $DbName"
try {
  $output = & $pgDump @pgArgs 2>&1
  $exitCode = $LASTEXITCODE
  foreach ($line in $output) {
    Write-Log "pg_dump: $line"
  }
  if ($exitCode -ne 0) {
    Write-Log "错误：pg_dump 退出码 $exitCode，备份失败。"
    if (Test-Path $outFile) { Remove-Item $outFile -Force }
    exit 1
  }
} catch {
  Write-Log "错误：备份失败 - $($_.Exception.Message)"
  if (Test-Path $outFile) { Remove-Item $outFile -Force }
  exit 1
}

if (-not (Test-Path $outFile)) {
  Write-Log '错误：备份文件未生成。'
  exit 1
}
$sizeMb = [Math]::Round((Get-Item $outFile).Length / 1MB, 2)
Write-Log "备份完成: $outFile ($sizeMb MB)"

# 5. 保留最近 Retention 份，删除更旧的备份
$backups = @(Get-ChildItem -Path $BackupDir -Filter 'erp-*.sql' -File | Sort-Object Name -Descending)
if ($backups.Count -gt $Retention) {
  $old = $backups | Select-Object -Skip $Retention
  foreach ($f in $old) {
    Remove-Item $f.FullName -Force
    Write-Log "删除旧备份: $($f.Name)"
  }
}
$keep = [Math]::Min($backups.Count, $Retention)
Write-Log "保留最近 $keep 份（共 $($backups.Count) 份，阈值 $Retention）。"
Write-Log '===== 备份结束 ====='
