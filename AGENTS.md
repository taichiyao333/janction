# GPU レンタルプラットフォーム — AI エージェント向け設計図

> **AIが最初に読むファイル。** これを読めばコードベース全体を把握できる。

---

## 🏗 プロジェクト構造

```
f:\antigravity\
├── gpu-platform/          ← メインプロジェクト（★作業はここ）
│   ├── server/            ← Node.js バックエンド
│   │   ├── index.js       ← Expressサーバー本体（ポート3000）
│   │   ├── config.js      ← 設定（JWT,SMTP等）
│   │   ├── routes/        ← APIルート群
│   │   └── db/
│   │       ├── database.js  ← sql.js wrapper（SQLite）
│   │       └── migrations.js← DBスキーマ定義（ここでテーブル確認）
│   ├── public/            ← フロントエンド（静的ファイル）
│   │   ├── landing/       ← ランディングページ（index.html単体）
│   │   ├── portal/        ← ユーザーポータル（app.js 85KB, style.css）
│   │   ├── admin/         ← 管理者パネル
│   │   ├── workspace/     ← GPU利用画面
│   │   ├── provider/      ← プロバイダー向け
│   │   │   ├── index.html ← プロバイダーポータル
│   │   │   ├── diagnose.html← GPU診断ツール（★重要, 70KB）
│   │   │   └── download.html← エージェントDL Case
│   │   ├── mypage/        ← マイページ
│   │   └── downloads/     ← janction-agent.exe（38MB, git除外）
│   ├── agent/             ← Node.jsエージェント（プロバイダーPC用）
│   │   └── src/index.js   ← エージェント本体
│   ├── deploy_ftp.ps1     ← ★デプロイスクリプト（さくらFTP）
│   ├── .env               ← 環境変数（git除外）
│   └── AGENTS.md          ← このファイル
├── gpu-monitor/           ← 監視サーバー（port 4000）
│   └── monitor.js         ← アップタイム監視
└── janction-ai-kit/      ← Pythonエージェント（EXE化）
    └── agent/             ← PyInstaller ビルド
```

---

## 🔑 環境・サーバー情報

| 項目 | 値 |
|---|---|
| **本番URL** | `https://janction.net` |
| **ローカルサーバー** | `http://localhost:3000` |
| **Cloudflare Tunnel** | localhost:3000 → janction.net |
| **FTPホスト** | `mdl-japan.sakura.ne.jp` |
| **FTPパス** | `/www/janction/` |
| **DBファイル** | `./data/janction.db` (sql.js, SQLite) |
| **監視サーバー** | `http://localhost:4000` |

---

## 🛣 主要APIルート早見表

| ファイル | プレフィックス | 主な機能 |
|---|---|---|
| `auth.js` | `/api/auth` | ログイン・登録・パスワードリセット |
| `gpus.js` | `/api/gpus` | GPU一覧・レンタル |
| `reservations.js` | `/api/reservations` | 予約管理 |
| `pods.js` | `/api/pods` | Podライフサイクル |
| `providers.js` | `/api/providers` | プロバイダー管理 |
| `agent.js` | `/api/agent` | エージェント登録・ハートビート |
| `diagnostics.js` | `/api/diagnose` | GPU診断API |
| `payments.js` | `/api/payments` | GMO Epsilon決済 |
| `points.js` | `/api/points` | ポイント管理 |
| `admin.js` | `/api/admin` | 管理者専用 |
| `files.js` | `/api/files` | ファイルAPI |
| `outage.js` | `/api/outage` | メンテナンス管理 |

---

## 🗄 DBテーブル一覧（migrations.js で定義）

| テーブル名 | 用途 |
|---|---|
| `users` | ユーザー（role: user/admin/provider） |
| `gpu_nodes` | GPUノード情報 |
| `reservations` | 予約 |
| `pods` | Podインスタンス |
| `providers` | エージェント接続情報 |
| `point_purchases` | ポイント購入履歴 |
| `coupons` | クーポン |
| `jobs` / `render_jobs` | レンダリングジョブ |

---

## 🚀 よく使う操作

### デプロイ（FTP + git push）
```powershell
git add . && git commit -m "fix: XXX" && git push origin main
powershell -ExecutionPolicy Bypass -File "f:\antigravity\gpu-platform\deploy_ftp.ps1"
```

### サーバー再起動
```powershell
# PIDを確認して停止
$pid3000 = (netstat -ano | Select-String ":3000 .*LISTEN").ToString().Trim().Split()[-1]
Stop-Process -Id $pid3000 -Force
# 再起動
Start-Process node -ArgumentList "server/index.js" -WorkingDirectory "F:\antigravity\gpu-platform" -WindowStyle Minimized
```

### 監視サーバー起動
```powershell
Start-Process node -ArgumentList "monitor.js" -WorkingDirectory "F:\antigravity\gpu-monitor" -WindowStyle Minimized
```

### 診断API手動テスト
```powershell
Invoke-RestMethod -Uri "http://localhost:3000/api/diagnose/gpu" -Method POST -ContentType "application/json"
```

---

## 📦 デプロイフロー詳細

`deploy_ftp.ps1` が以下を実行：
1. **JS パッチ**: `const API = ''` → `https://janction.net`
2. **tmp_deploy にコピー** → メンテナンス注入スクリプトをHTMLに追加
3. **FTPアップロード**: 30ファイル（provider/, landing/, portal/, admin/, etc.）
4. **tmp_deploy削除**

> ⚠️ EXE（janction-agent.exe, 38MB）は FTP管理。gitには含まない。

---

## 🧩 フロントエンド構成

各フロントエンドは**バニラHTML/CSS/JS**（フレームワークなし）。

| ページ | 主なJS | 特記事項 |
|---|---|---|
| `landing/` | inline script | CPU vs GPU デモ（シミュレーション） |
| `portal/` | `app.js` 85KB | Socket.IO リアルタイム |
| `admin/` | `app.js` 78KB | JWT認証必須 |
| `workspace/` | `app.js` 49KB | GPU作業環境 |
| `provider/diagnose.html` | inline script | GPU診断ツール（独立動作） |

---

## ⚙️ 重要な設定・注意事項

### CSP (Content Security Policy)
`server/index.js` の helmet設定：
```js
scriptSrcAttr: ["'unsafe-hashes'", "'unsafe-inline'"]  // onclick許可
```
> ⚠️ これがないと onclick/onfocus が全部ブロックされる

### diagnose.html の構造
`pane-start` → `pane-running` → `pane-results` の3ステップUI。
結果は `id="checkList"` div に JavaScript で動的に生成される。

### エージェント接続フロー
1. プロバイダーが `janction-agent.exe` を起動
2. `POST /api/agent/register` でトークン取得
3. `POST /api/agent/heartbeat` を60秒ごとに送信
4. 5分間ハートビートなし → `offline` に自動変更

---

## 🏷 git コミット規約

```
feat: 新機能追加
fix:  バグ修正
chore: 設定・依存関係
docs: ドキュメントのみ
refactor: リファクタリング
```

**ファイル単位でコミットを分ける推奨パターン：**
- サーバー変更 → `fix(server): XXX`
- フロント変更 → `fix(ui): XXX`
- デプロイ必要な変更は必ず `deploy_ftp.ps1` も実行

---

## 🔧 よくある問題と解決

| 問題 | 原因 | 解決 |
|---|---|---|
| onclick が動かない | CSP `script-src-attr: none` | server/index.js の scriptSrcAttr を確認 |
| 診断カードが表示されない | `<div id="checkList">` タグ破損 | HTMLの checkList div を確認 |
| 比較スタートが動かない | 外部API呼び出し失敗 | landing/index.html の runGpuReal はシミュレーション |
| サーバー起動しない | ポート3000競合 | `netstat -ano \| findstr 3000` で確認 |
| FTPデプロイ後に古いUIが表示 | ブラウザキャッシュ | Ctrl+Shift+R でハードリロード |
| エージェントsetupでGPU表示されない | `/gpu` エンドポイント未実装 | ✅ agent/src/index.js で修正済み |
| エージェント登録が失敗する | APIパスが `/api/provider/register-agent` だった | ✅ `/api/agent/register` に修正済み |
| 決済後にポイントが付与されない | Stripe Webhook が localhost に届かない | 本番: Stripe DashboardでWebhook URL を `https://janction.net/api/payments/webhook` に設定 |
