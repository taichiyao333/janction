# 🚀 GPU Rental Platform - 起動ガイド

## ✅ 現在の動作状況

| コンポーネント | 状態 |
|---|---|
| サーバー (localhost:3000) | ✅ **稼働中** |
| SQLite DB (sql.js) | ✅ **正常** |
| RTX A4500 登録済み | ✅ **provider_id=1** |
| GPU Monitor (nvidia-smi) | ✅ **5秒ポーリング** |
| スケジューラー | ✅ **稼働中** |
| 認証API | ✅ **14/14テスト合格** |

## 🌐 アクセスURL

```
http://localhost:3000/portal/      ← 予約ポータル
http://localhost:3000/admin/       ← 管理ダッシュボード
http://localhost:3000/workspace/   ← ユーザーワークスペース
http://localhost:3000/provider/    ← GPUプロバイダー登録
```

## 🔐 ログイン情報

```
メール:    taichi.yao@gmail.com
パスワード: admin123
ロール:    admin
```

## 💻 サーバー再起動方法

PowerShellで：
```powershell
$nodeDir = "C:\Program Files\nodejs"
$env:Path = "$nodeDir;" + $env:Path
Remove-Item -Force "F:\janction\db\platform.db" -ErrorAction SilentlyContinue
& "$nodeDir\node.exe" server/index.js
```

または `start.bat` を実行（Node.jsがPATHに通っていれば）。

## 🌍 外部公開 (Cloudflare Tunnel)

cloudflaredインストール後：
```bat
cloudflared tunnel --url http://localhost:3000
```
→ 自動で `https://xxxx.trycloudflare.com` のURLが発行されます。

## 📁 プロジェクト構成

```
gpu-platform/
├── server/
│   ├── index.js              🚀 メインサーバー
│   ├── config.js             ⚙  設定
│   ├── db/
│   │   ├── database.js       🗄 sql.js DB wrapper
│   │   └── migrations.js     📋 テーブル定義 + シード
│   ├── middleware/auth.js    🔐 JWT認証
│   ├── routes/
│   │   ├── auth.js           ← /api/auth
│   │   ├── gpus.js           ← /api/gpus
│   │   ├── reservations.js   ← /api/reservations
│   │   ├── pods.js           ← /api/pods
│   │   ├── files.js          ← /api/files
│   │   ├── payments.js       ← /api/payments (Stripe)
│   │   ├── providers.js      ← /api/providers
│   │   └── admin.js          ← /api/admin
│   └── services/
│       ├── gpuManager.js     📊 nvidia-smi監視
│       ├── podManager.js     🖥  Pod管理・報酬計算
│       └── scheduler.js      ⏰ 自動start/stop
└── public/
    ├── portal/               🌐 予約ポータル
    ├── workspace/            💻 ユーザーワークスペース
    ├── admin/                🛡  管理ダッシュボード
    └── provider/             🏭 プロバイダー登録
```

## 💰 収益モデル

- RTX A4500: **¥800/時間**
- プロバイダー取り分: **80% = ¥640/時間**
- 8h稼働 × 30日 = **¥153,600/月**

## 🔮 次のステップ (Phase 5+)

1. **Stripe決済** `.env`に`STRIPE_SECRET_KEY`を設定
2. **カスタムドメイン** Cloudflare Dashboardでドメイン設定
3. **node-pty** Visual Studio Build Toolsインストール後にリアルターミナル実装
4. **Enterprise GPU** 別サーバーのGPUをAPIで追加登録
