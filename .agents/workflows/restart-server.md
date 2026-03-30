---
description: Restart the local Node.js server (port 3000)
---

# サーバー再起動手順

// turbo-all

## 1. 既存プロセスを停止
```powershell
Get-Process -Name "node" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
```

## 2. サーバーを起動
```powershell
Start-Process -FilePath "node" -ArgumentList "server/index.js" -WorkingDirectory "F:\antigravity\gpu-platform" -WindowStyle Minimized
Start-Sleep -Seconds 5
```

## 3. 起動確認
```powershell
$r = Invoke-RestMethod -Uri "http://localhost:3000/api/health" -TimeoutSec 8
Write-Host "✅ 起動成功 uptime:", $r.uptime, "sec"
```
