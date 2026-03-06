# ⚡ GPU Rental Platform

**RTX A4500を個人・企業・第三者に時間貸しするGPUクラウドプラットフォーム**

> RUNPOD ライクなGPUレンタルシステム。自宅のGPUをそのまま外部に貸し出し、報酬を受け取れます。

---

## 📸 スクリーン概要

| 画面 | URL | 説明 |
|------|-----|------|
| 🌐 予約ポータル | `/portal/` | GPU一覧・予約カレンダー・リアルタイム状況 |
| 💻 ワークスペース | `/workspace/` | ターミナル・ファイル管理・GPUモニター |
| 🛡 管理ダッシュボード | `/admin/` | KPI・GPU管理・ユーザー管理・報酬管理 |

---

## 🏗 アーキテクチャ

```
┌─────────────────────────────────────────────────────────┐
│                 インターネット                            │
│  Cloudflare Tunnel → localhost:3000                      │
└─────────────────────────────────────────────────────────┘
                          │
              ┌───────────▼───────────┐
              │   Express + Socket.io  │
              │    Node.js サーバー     │
              └─┬──────┬──────┬──────┘
                │      │      │
         ┌──────▼─┐ ┌──▼──┐ ┌▼──────────┐
         │SQLite DB│ │GPU  │ │ Scheduler │
         │(F:ドライブ)│ │Manager│ │ (Cron)    │
         └─────────┘ └─────┘ └───────────┘
```

### 技術スタック
- **Backend**: Node.js + Express 4 + Socket.io
- **Database**: SQLite (better-sqlite3) — F:\gpu-rental\db\
- **GPU Monitor**: nvidia-smi polling (5秒ごと)
- **Auth**: JWT (24h有効) + bcrypt
- **外部公開**: Cloudflare Tunnel
- **Frontend**: Vanilla HTML/CSS/JS (no framework)

---

## 🚀 クイックスタート

### 前提条件
- Windows 10/11
- NVIDIA GPU (RTX A4500推奨)
- F:ドライブ (専用ストレージ) またはCドライブ

### 1. セットアップ (初回のみ)

```bat
setup.bat
```

自動でインストールされるもの:
- Node.js v24.14.0
- npm パッケージ (100+ packages)
- Cloudflare cloudflared
- F:\gpu-rental\ ストレージフォルダ

### 2. 起動

```bat
start.bat
```

選択肢:
1. ローカルのみ起動 (`http://localhost:3000`)
2. Cloudflare Tunnel付き起動 (外部公開URL自動発行)

### 3. アクセス

```
ポータル:    http://localhost:3000/portal/
管理画面:    http://localhost:3000/admin/
ワークスペース: http://localhost:3000/workspace/
```

**管理者ログイン**: `taichi.yao@gmail.com` / `admin123`

---

## 📁 ディレクトリ構成

```
gpu-platform/
├── server/
│   ├── index.js              # メインサーバー
│   ├── config.js             # 設定
│   ├── db/
│   │   ├── database.js       # SQLite接続
│   │   └── migrations.js     # DBスキーマ + シードデータ
│   ├── middleware/
│   │   └── auth.js           # JWT認証
│   ├── routes/
│   │   ├── auth.js           # 登録/ログイン/me
│   │   ├── gpus.js           # GPU一覧・空き確認
│   │   ├── reservations.js   # 予約CRUD
│   │   ├── pods.js           # Pod起動/停止
│   │   ├── files.js          # ファイル管理
│   │   └── admin.js          # 管理API
│   └── services/
│       ├── gpuManager.js     # nvidia-smi監視
│       ├── podManager.js     # Pod管理・報酬計算
│       └── scheduler.js      # 自動start/stop・通知
├── public/
│   ├── portal/               # 予約ポータル
│   ├── workspace/            # ユーザーワークスペース
│   └── admin/                # 管理ダッシュボード
├── .env                      # 環境変数
├── package.json
├── setup.bat                 # セットアップ
├── start.bat                 # 起動ランチャー
└── tunnel.bat                # Cloudflare Tunnel単体起動
```

---

## 💰 料金・報酬モデル

| 項目 | 内容 |
|------|------|
| RTX A4500 基本料金 | ¥800/時間 |
| プロバイダー取り分 | **80%** (= ¥640/時間) |
| プラットフォーム手数料 | 20% (= ¥160/時間) |
| 最短レンタル | 1時間 |

---

## 🗄 データベース設計

| テーブル | 説明 |
|---------|------|
| `users` | ユーザー (user/admin/provider) |
| `gpu_nodes` | GPU一覧 (Home/Enterprise/DataCenter) |
| `reservations` | 予約 |
| `pods` | アクティブセッション |
| `usage_logs` | 利用ログ・料金記録 |
| `alerts` | 温度・エラーアラート |
| `payouts` | プロバイダー報酬管理 |

---

## 📊 実装フェーズ

| フェーズ | 内容 | 状態 |
|---------|------|------|
| Phase 0 | 環境構築・ドキュメント | ✅ 完了 |
| Phase 1 | バックエンド基盤 | ✅ 完了 |
| Phase 2 | 予約ポータル (Web UI) | ✅ 完了 |
| Phase 3 | ワークスペース + 管理画面 | ✅ 完了 |
| Phase 4 | Stripe決済 + 本番環境 | 🔜 予定 |
| Phase 5 | Enterprise/DC対応 | 🔜 予定 |

---

## 🔧 開発コマンド

```bash
npm start       # 本番起動
npm run dev     # 開発モード (nodemon)
npm run setup   # DBマイグレーション単体実行
```

---

## 🌐 外部公開 (Cloudflare Tunnel)

```bat
# 簡単な方法 (アカウント不要・一時URL)
tunnel.bat

# カスタムドメイン設定済みの場合
cloudflared tunnel run --config cloudflared-config.yml gpu-rental-platform
```

---

## ⚠️ セキュリティ注意事項

- 本番環境では `.env` の `JWT_SECRET` と `ADMIN_PASSWORD` を必ず変更してください
- Cloudflare TunnelでIPアドレスが直接公開されることはありません
- ファイルアップロードはPodごとの専用ディレクトリに隔離されています

---

© 2026 GPU Rental Platform · RTX A4500 · 20GB VRAM
