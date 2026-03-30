---
description: Add a new API endpoint to the backend
---

# 新API追加手順

## 1. ルートファイル作成 or 既存に追加
```
server/routes/[name].js
```

## 2. server/index.js に登録
```js
const nameRoutes = require('./routes/name');
app.use('/api/name', nameRoutes);
```

## 3. DBカラム追加が必要な場合
`server/db/migrations.js` の `alterList` 配列に追加：
```js
"ALTER TABLE users ADD COLUMN new_field TEXT",
```
※ `try { db.exec(sql); } catch (_) {}` で重複エラーを無視している

## 4. テスト
// turbo
```powershell
$r = Invoke-RestMethod -Uri "http://localhost:3000/api/[name]" -Method GET -Headers @{Authorization="Bearer [token]"}
$r | ConvertTo-Json
```

## 5. コミット・デプロイ
```powershell
git -C "f:\antigravity\gpu-platform" add server/
git -C "f:\antigravity\gpu-platform" commit -m "feat(api): Add [name] endpoint"
git -C "f:\antigravity\gpu-platform" push origin main
# サーバー再起動
Get-Process -Name "node" | Stop-Process -Force
Start-Sleep 2
Start-Process node -ArgumentList "server/index.js" -WorkingDirectory "F:\antigravity\gpu-platform" -WindowStyle Minimized
```
