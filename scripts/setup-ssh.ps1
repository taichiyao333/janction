# SSH Setup Script for GPU Rental Platform
# Run this script as Administrator!

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  GPU Rental - SSH Server Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Step 1: Install OpenSSH Server
Write-Host "[1/5] Installing OpenSSH Server..." -ForegroundColor Yellow
$sshServer = Get-WindowsCapability -Online | Where-Object { $_.Name -like 'OpenSSH.Server*' }
if ($sshServer.State -eq 'Installed') {
    Write-Host "  -> OpenSSH Server is already installed." -ForegroundColor Green
} else {
    Write-Host "  -> Installing OpenSSH Server..."
    Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
    Write-Host "  -> OpenSSH Server installed!" -ForegroundColor Green
}

# Step 2: Configure sshd_config for port 2222
Write-Host "`n[2/5] Configuring SSHD on port 2222..." -ForegroundColor Yellow
$configPath = "C:\ProgramData\ssh\sshd_config"

# First start sshd to generate default config if it doesn't exist
Start-Service sshd -ErrorAction SilentlyContinue
Stop-Service sshd -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

if (Test-Path $configPath) {
    $config = Get-Content $configPath -Raw
    
    # Change port to 2222
    if ($config -match "^#?Port\s+\d+") {
        $config = $config -replace "^#?Port\s+\d+", "Port 2222"
    } else {
        $config = "Port 2222`r`n" + $config
    }
    
    # Enable password authentication
    $config = $config -replace "^#?PasswordAuthentication\s+\w+", "PasswordAuthentication yes"
    
    # Allow all users (remove administrators_authorized_keys override)
    $config = $config -replace "(?m)^(Match Group administrators.*)$", "# `$1"
    $config = $config -replace "(?m)^(\s*AuthorizedKeysFile\s+__PROGRAMDATA__/ssh/administrators_authorized_keys.*)$", "# `$1"
    
    Set-Content $configPath $config -Force
    Write-Host "  -> sshd_config updated: Port 2222, PasswordAuthentication yes" -ForegroundColor Green
} else {
    Write-Host "  -> ERROR: sshd_config not found at $configPath" -ForegroundColor Red
    Write-Host "  -> Trying to create default config..."
    
    # Create minimal config
    @"
Port 2222
PasswordAuthentication yes
PubkeyAuthentication yes
Subsystem sftp sftp-server.exe
"@ | Set-Content $configPath -Force
    Write-Host "  -> Created minimal sshd_config" -ForegroundColor Green
}

# Step 3: Create GPU user account for SSH
Write-Host "`n[3/5] Creating SSH user account..." -ForegroundColor Yellow
$username = "gpu-user-15"
$password = "GpuRental2026!"

$userExists = Get-LocalUser -Name $username -ErrorAction SilentlyContinue
if ($userExists) {
    Write-Host "  -> User '$username' already exists." -ForegroundColor Green
    # Reset password
    $securePass = ConvertTo-SecureString $password -AsPlainText -Force
    Set-LocalUser -Name $username -Password $securePass
    Write-Host "  -> Password reset." -ForegroundColor Green
} else {
    $securePass = ConvertTo-SecureString $password -AsPlainText -Force
    New-LocalUser -Name $username -Password $securePass -FullName "GPU Rental User 15" -Description "GPU Rental SSH Access" -PasswordNeverExpires
    Write-Host "  -> User '$username' created." -ForegroundColor Green
}

# Ensure user's workspace directory exists
$workDir = "F:\janction\users\15\workspace"
if (-not (Test-Path $workDir)) {
    New-Item -ItemType Directory -Path $workDir -Force | Out-Null
}
Write-Host "  -> Workspace: $workDir" -ForegroundColor Green

# Step 4: Firewall rule
Write-Host "`n[4/5] Configuring firewall..." -ForegroundColor Yellow
$rule = Get-NetFirewallRule -DisplayName "OpenSSH Server (sshd) Port 2222" -ErrorAction SilentlyContinue
if ($rule) {
    Write-Host "  -> Firewall rule already exists." -ForegroundColor Green
} else {
    New-NetFirewallRule -Name sshd_2222 -DisplayName "OpenSSH Server (sshd) Port 2222" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 2222
    Write-Host "  -> Firewall rule created for port 2222." -ForegroundColor Green
}

# Step 5: Start and set SSHD service to automatic
Write-Host "`n[5/5] Starting SSHD service..." -ForegroundColor Yellow
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
$svc = Get-Service sshd
Write-Host "  -> SSHD service: $($svc.Status) (StartType: Automatic)" -ForegroundColor Green

# Verify
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Setup Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "SSH Connection Info:" -ForegroundColor Yellow
Write-Host "  Host:     janction.net" 
Write-Host "  Port:     2222"
Write-Host "  User:     $username"
Write-Host "  Password: $password"
Write-Host "  Command:  ssh -p 2222 $username@janction.net"
Write-Host ""

# Test that port is listening
Start-Sleep -Seconds 2
$listener = Get-NetTCPConnection -LocalPort 2222 -ErrorAction SilentlyContinue
if ($listener) {
    Write-Host "  -> Port 2222 is LISTENING. Ready for connections!" -ForegroundColor Green
} else {
    Write-Host "  -> WARNING: Port 2222 is NOT listening. Check sshd service." -ForegroundColor Red
}
