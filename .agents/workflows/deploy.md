---
description: Deploy to production (FTP + git push)
---

# デプロイ手順

// turbo-all

## 1. 変更をコミット
```powershell
git -C "f:\antigravity\gpu-platform" add .
git -C "f:\antigravity\gpu-platform" commit -m "fix: [変更内容]"
git -C "f:\antigravity\gpu-platform" push origin main
```

## 2. FTPアップロード
```powershell
powershell -ExecutionPolicy Bypass -File "f:\antigravity\gpu-platform\deploy_ftp.ps1"
```

## 3. 確認（オプション）
```powershell
$r = Invoke-WebRequest -Uri "https://janction.net/provider/diagnose.html" -UseBasicParsing
Write-Host "Status:", $r.StatusCode, "| Size:", $r.RawContentLength, "bytes"
```
