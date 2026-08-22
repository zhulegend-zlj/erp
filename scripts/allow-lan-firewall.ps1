# 允许局域网访问 ERP（需以管理员身份运行 PowerShell）
# 用法：右键"以管理员身份运行 Windows PowerShell"，然后执行：
#   Set-ExecutionPolicy -Scope Process Bypass
#   .\allow-lan-firewall.ps1

New-NetFirewallRule -DisplayName "ERP Frontend 5173" -Direction Inbound -Protocol TCP -LocalPort 5173 -Action Allow
New-NetFirewallRule -DisplayName "ERP Backend 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
Write-Output "已放行 TCP 3000 和 5173。"
Write-Output "其他电脑访问：http://192.168.1.114:5173"
