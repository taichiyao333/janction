# PM2 Auto-startup Registration Script for Windows
# Janction.jp - janction service
# Registers a Task Scheduler task to start PM2 on system startup

$taskName = "PM2-Janction"
$pm2Cmd   = "C:\Users\taich\AppData\Roaming\npm\pm2.cmd"
$nodeExe  = "C:\Program Files\nodejs\node.exe"
$workDir  = "F:\antigravity\gpu-platform"

# Remove existing task if present
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "[INFO] Removed existing task: $taskName"
}

# Build action: cmd /c pm2 resurrect
$action = New-ScheduledTaskAction `
    -Execute "cmd.exe" `
    -Argument "/c `"$pm2Cmd`" resurrect" `
    -WorkingDirectory $workDir

# Trigger: At system startup (requires SYSTEM or admin)
$trigger = New-ScheduledTaskTrigger -AtStartup

# Settings
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

# Run as current user with highest privileges
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Highest

# Register
Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Starts PM2 and resurrects janction service on system boot (Janction.jp)" `
    -Force

Write-Host ""
Write-Host "====================================="
Write-Host " Task Registered: $taskName"
Write-Host " Trigger: At system startup"
Write-Host " Command: pm2 resurrect"
Write-Host "====================================="
Write-Host ""

# Verify
$task = Get-ScheduledTask -TaskName $taskName
Write-Host "[OK] Status: $($task.State)"
