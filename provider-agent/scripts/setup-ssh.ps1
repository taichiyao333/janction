# GPU Provider SSH Setup Script (bundled with agent)
# Automatically sets up OpenSSH Server for GPU rental

$ErrorActionPreference = 'SilentlyContinue'

Write-Host "[SSH Setup] Checking OpenSSH Server..." -ForegroundColor Cyan

# Check if already running
$svc = Get-Service sshd -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') {
    Write-Host "[SSH Setup] OpenSSH Server is already running." -ForegroundColor Green
    exit 0
}

# Try to install
$cap = Get-WindowsCapability -Online | Where-Object { $_.Name -like 'OpenSSH.Server*' }
if ($cap -and $cap.State -ne 'Installed') {
    Write-Host "[SSH Setup] Installing OpenSSH Server..."
    Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null
}

# Configure
$configPath = "C:\ProgramData\ssh\sshd_config"
Start-Service sshd -ErrorAction SilentlyContinue
Stop-Service sshd -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

if (Test-Path $configPath) {
    $config = Get-Content $configPath -Raw
    if ($config -notmatch "^Port\s+22\s*$") {
        # Keep default port 22 for provider agent
    }
    $config = $config -replace "^#?PasswordAuthentication\s+\w+", "PasswordAuthentication yes"
    $config = $config -replace "(?m)^(Match Group administrators.*)$", "# `$1"
    $config = $config -replace "(?m)^(\s*AuthorizedKeysFile\s+__PROGRAMDATA__/ssh/administrators_authorized_keys.*)$", "# `$1"
    Set-Content $configPath $config -Force
}

# Firewall
$rule = Get-NetFirewallRule -DisplayName "OpenSSH Server (sshd)" -ErrorAction SilentlyContinue
if (-not $rule) {
    New-NetFirewallRule -Name sshd -DisplayName "OpenSSH Server (sshd)" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
}

# Start service
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd

Write-Host "[SSH Setup] OpenSSH Server ready on port 22" -ForegroundColor Green
