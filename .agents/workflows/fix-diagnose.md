---
description: Fix a bug in diagnose.html (the provider GPU diagnosis page)
---

# diagnose.html 修正手順

## 事前知識（必読）
- ファイル: `f:\antigravity\gpu-platform\public\provider\diagnose.html`（約70KB）
- 診断ロジック: `server/routes/diagnostics.js`
- UI構造: `pane-start` → `pane-running` → `pane-results` の3ペイン
- 結果表示: `id="checkList"` div に動的生成
- ⚠️ `<div id="checkList">` タグが破損するとカード全非表示になる

## 修正時の注意
HTMLを文字列操作で編集する場合は必ずNodeスクリプト経由で行う。
直接replace_file_contentで日本語マーカーを使うと文字化けで失敗する。

## 診断APIテスト
// turbo
```powershell
$r = Invoke-RestMethod -Uri "http://localhost:3000/api/diagnose/gpu" -Method POST -ContentType "application/json" -TimeoutSec 15
$r.checks | ForEach-Object { Write-Host $_.id, "|", $_.status, "|", $_.message }
```

## デプロイ
```powershell
git -C "f:\antigravity\gpu-platform" add public/provider/diagnose.html server/routes/diagnostics.js
git -C "f:\antigravity\gpu-platform" commit -m "fix(diagnose): [変更内容]"
git -C "f:\antigravity\gpu-platform" push origin main
powershell -ExecutionPolicy Bypass -File "f:\antigravity\gpu-platform\deploy_ftp.ps1"
```

## 確認
// turbo
```powershell
$r = Invoke-WebRequest -Uri "https://janction.net/provider/diagnose.html" -UseBasicParsing
$ok = $r.Content.Contains('checkList')
Write-Host "checkList div:", if($ok){"✅ OK"}else{"❌ BROKEN"}
```
