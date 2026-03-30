# Janction Windows Startup Registration
# 管理者として実行してください

$user = $env:USERNAME

# ── 1. GPU Platform Server (port 3000) ─────────────────────────────────
$action1 = New-ScheduledTaskAction `
    -Execute "cmd.exe" `
    -Argument "/c `"F:\antigravity\gpu-platform\start-server.bat`""

$trigger1 = New-ScheduledTaskTrigger -AtLogOn -User $user

$settings1 = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
    -RestartCount 5 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable `
    -Hidden

Register-ScheduledTask `
    -TaskName "Janction-Server" `
    -Action $action1 `
    -Trigger $trigger1 `
    -Settings $settings1 `
    -RunLevel Highest `
    -Description "Janction Node.js Server (port 3000) - Auto start on login" `
    -Force

Write-Host "✅ Janction-Server 登録完了"

# ── 2. GPU Monitor (port 4000) ─────────────────────────────────────────
$action2 = New-ScheduledTaskAction `
    -Execute "cmd.exe" `
    -Argument "/c `"F:\antigravity\gpu-monitor\start-monitor.bat`""

$trigger2 = New-ScheduledTaskTrigger -AtLogOn -User $user

$settings2 = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
    -RestartCount 5 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable `
    -Hidden

Register-ScheduledTask `
    -TaskName "Janction-Monitor" `
    -Action $action2 `
    -Trigger $trigger2 `
    -Settings $settings2 `
    -RunLevel Highest `
    -Description "Janction Monitor Server (port 4000) - Auto start on login" `
    -Force

Write-Host "✅ Janction-Monitor 登録完了"

# ── 確認 ──────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=== 登録済みタスク ==="
Get-ScheduledTask | Where-Object { $_.TaskName -match "Janction" } | 
    Select-Object TaskName, State | Format-Table

Write-Host "✅ 完了！次回ログイン時から自動起動します。"
