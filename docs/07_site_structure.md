# Janction — サイト構造ドキュメント (Site Map & Architecture)

> **最終更新**: 2026-03-15  
> **開発元**: METADATALAB.INC  
> **リポジトリ**: [github.com/taichiyao333/janction](https://github.com/taichiyao333/janction)

---

## 📋 目次

1. [全体ディレクトリ構造](#全体ディレクトリ構造)
2. [公開ページ マップ (URL → ファイル対応)](#公開ページ-マップ)
3. [APIエンドポイント一覧](#apiエンドポイント一覧)
4. [サーバー構成](#サーバー構成)
5. [データベーステーブル一覧](#データベーステーブル一覧)
6. [外部サービス連携](#外部サービス連携)

---

## 全体ディレクトリ構造

```
janction/
├── 📄 README.md                    プロジェクト概要
├── 📄 QUICKSTART.md                クイックスタートガイド
├── 📄 package.json                 Node.js 依存関係
├── 📄 .env                         環境変数 (開発用)
├── 📄 .env.production              環境変数 (本番用)
├── 📄 ecosystem.config.js          PM2 設定
├── 📄 cloudflared-config.yml       Cloudflare Tunnel 設定
├── 📄 start.bat                    Windows 起動スクリプト
├── 📄 setup.bat                    初回セットアップスクリプト
├── 📄 tunnel.bat                   Cloudflare Tunnel 起動
│
├── 📁 public/                      ─── フロントエンド（静的ファイル）
│   ├── 📁 landing/                 ランディングページ
│   │   ├── index.html             トップ (LP)
│   │   ├── pricing.html           料金表
│   │   ├── terms.html             利用規約
│   │   └── privacy.html           プライバシーポリシー
│   │
│   ├── 📁 portal/                  ユーザーポータル (メイン)
│   │   ├── index.html             ポータル画面
│   │   ├── app.js                 フロントロジック (81KB)
│   │   └── style.css              スタイル (52KB)
│   │
│   ├── 📁 workspace/               GPU 利用ワークスペース
│   │   ├── index.html             ターミナル + モニター画面
│   │   ├── app.js                 xterm.js + Chart.js ロジック
│   │   └── style.css              ワークスペーススタイル
│   │
│   ├── 📁 admin/                   管理パネル (管理者専用)
│   │   ├── index.html             管理ダッシュボード
│   │   ├── app.js                 管理ロジック
│   │   ├── bonus.js               ボーナスポイント管理
│   │   └── style.css              管理画面スタイル
│   │
│   ├── 📁 mypage/                  マイページ (ユーザー設定)
│   │   └── index.html             プロフィール・API キー管理
│   │
│   ├── 📁 provider/                GPU プロバイダーポータル
│   │   ├── index.html             GPU 登録・収益管理
│   │   └── diagnose.html          🔧 GPU 接続診断ツール (NEW)
│   │
│   ├── 📁 epsilon_mock/            GMO イプシロン決済モック
│   │   └── index.html             テスト決済画面
│   │
│   ├── 📄 index.html              / ルート → /landing/ へリダイレクト
│   ├── 📄 maintenance.html        メンテナンスページ
│   ├── 📄 password-gate.js        サイト全体パスワード保護
│   ├── 📄 pricing.html            料金 (ルート)
│   ├── 📄 terms.html              利用規約 (ルート)
│   ├── 📄 privacy.html            プライバシー (ルート)
│   ├── 📄 demo.html               デモページ
│   └── 📄 epsilon_callback.php    決済コールバック
│
├── 📁 server/                      ─── バックエンド (Node.js / Express)
│   ├── 📄 index.js                メインサーバー + WebSocket
│   ├── 📄 config.js               設定・定数
│   │
│   ├── 📁 db/
│   │   ├── database.js            SQLite 接続 (sql.js)
│   │   └── migrations.js          DBマイグレーション定義
│   │
│   ├── 📁 middleware/
│   │   └── auth.js                JWT 認証ミドルウェア
│   │
│   ├── 📁 routes/                  APIルート群
│   │   ├── auth.js                /api/auth/*
│   │   ├── gpus.js                /api/gpus/*
│   │   ├── pods.js                /api/pods/*
│   │   ├── reservations.js        /api/reservations/*
│   │   ├── points.js              /api/points/*
│   │   ├── payments.js            /api/payments/*
│   │   ├── prices.js              /api/prices/*
│   │   ├── coupons.js             /api/coupons/*
│   │   ├── apikeys.js             /api/user/apikeys/*
│   │   ├── diagnostics.js         /api/diagnose/*  🔧 (NEW)
│   │   ├── providers.js           /api/providers/*
│   │   ├── bankAccounts.js        /api/bank-accounts/*
│   │   ├── outage.js              /api/outage/*
│   │   ├── files.js               /api/files/*
│   │   └── admin.js               /api/admin/*
│   │
│   └── 📁 services/               バックグラウンドサービス
│       ├── gpuManager.js          GPU 状態管理
│       ├── podManager.js          Pod ライフサイクル管理
│       ├── terminal.js            SSH ターミナル (xterm.js)
│       ├── email.js               メール送信 (Nodemailer)
│       ├── pricingMonitor.js      RunPod 価格監視
│       └── scheduler.js           定期タスク (node-cron)
│
└── 📁 docs/                        ─── プロジェクトドキュメント
    ├── 01_project_overview.md     プロジェクト概要
    ├── 02_implementation_phases.md 実装フェーズ計画
    ├── 03_effort_estimation.md    工数見積もり
    ├── 04_user_flow_sequence.md   ユーザーフロー
    ├── 05_system_development_flow.md システム開発フロー
    └── 06_remote_connection_guide.md リモート接続ガイド
```

---

## 公開ページ マップ

| URL パス | ファイル | 説明 | 対象ユーザー |
|---|---|---|---|
| `/` | public/index.html | `/landing/` へリダイレクト | 全員 |
| `/landing/` | public/landing/index.html | LP・機能紹介・RunPod比較 | 未登録訪問者 |
| `/landing/pricing.html` | public/landing/pricing.html | GPU料金一覧 | 全員 |
| `/landing/terms.html` | public/landing/terms.html | 利用規約 | 全員 |
| `/landing/privacy.html` | public/landing/privacy.html | プライバシーポリシー | 全員 |
| `/portal/` | public/portal/index.html | GPU予約・チケット購入・ポイント | ログイン済みユーザー |
| `/workspace/` | public/workspace/index.html | GPUターミナル・モニター | 予約済みユーザー |
| `/admin/` | public/admin/index.html | 管理ダッシュボード | 管理者のみ |
| `/mypage/` | public/mypage/index.html | プロフィール・APIキー・出金申請 | ログイン済みユーザー |
| `/provider/` | public/provider/index.html | GPU登録・収益管理 | GPU プロバイダー |
| `/provider/diagnose.html` | public/provider/diagnose.html | GPU接続診断ツール 🔧 | GPU プロバイダー |
| `/epsilon_mock/` | public/epsilon_mock/index.html | テスト決済画面 | 開発・テスト用 |
| `/maintenance.html` | public/maintenance.html | メンテナンス中ページ | 全員 |

---

## APIエンドポイント一覧

### 🔓 認証不要

| メソッド | パス | 説明 |
|---|---|---|
| `GET` | `/api/health` | ヘルスチェック |
| `POST` | `/api/auth/login` | ログイン |
| `POST` | `/api/auth/register` | 新規登録 |
| `GET` | `/api/prices` | GPU料金一覧 |
| `POST` | `/api/diagnose/gpu` | GPU診断 (nvidia-smi) |
| `GET` | `/api/diagnose/server` | サーバー接続診断 |
| `POST` | `/api/coupons/validate` | クーポン検証 |

### 🔐 JWT認証必須 (一般ユーザー)

| メソッド | パス | 説明 |
|---|---|---|
| `GET` | `/api/points/balance` | ポイント残高 |
| `GET` | `/api/points/logs` | ポイント履歴 |
| `POST` | `/api/points/purchase` | チケット購入 |
| `GET` | `/api/reservations` | 予約一覧 |
| `POST` | `/api/reservations` | 予約作成 |
| `DELETE` | `/api/reservations/:id` | 予約キャンセル |
| `GET` | `/api/gpus` | GPU一覧 |
| `GET` | `/api/pods/active` | 有効Pod確認 |
| `GET` | `/api/user/apikeys` | APIキー一覧 |
| `POST` | `/api/user/apikeys` | APIキー発行 |
| `DELETE` | `/api/user/apikeys/:id` | APIキー削除 |
| `PATCH` | `/api/user/apikeys/:id/toggle` | APIキー有効/無効 |
| `GET` | `/api/files/list` | ファイル一覧 |
| `POST` | `/api/files/upload` | ファイルアップロード |

### 🔐 JWT認証必須 (プロバイダー)

| メソッド | パス | 説明 |
|---|---|---|
| `GET` | `/api/providers/my-gpus` | マイGPU一覧 |
| `POST` | `/api/providers/register-gpu` | GPU登録 |
| `GET` | `/api/providers/earnings` | 収益情報 |
| `GET` | `/api/bank-accounts` | 振込先口座一覧 |
| `POST` | `/api/bank-accounts` | 口座追加 |

### 🔒 管理者専用

| メソッド | パス | 説明 |
|---|---|---|
| `GET` | `/api/admin/stats` | ダッシュボード統計 |
| `GET` | `/api/admin/gpus` | 全GPU管理 |
| `GET` | `/api/admin/users` | ユーザー管理 |
| `GET` | `/api/admin/reservations` | 全予約管理 |
| `GET` | `/api/admin/coupons` | クーポン管理 |
| `POST` | `/api/admin/coupons` | クーポン作成 |
| `GET` | `/api/admin/pricing/compare` | RunPod価格比較 |
| `POST` | `/api/admin/pricing/fetch` | RunPod価格取得 |
| `POST` | `/api/admin/pricing/apply` | 価格を一括適用 |
| `GET` | `/api/admin/outage` | 障害情報管理 |
| `POST` | `/api/admin/bonus-points` | ボーナスポイント付与 |

---

## サーバー構成

```
Express (port 3000)
  │
  ├── Static files → /public/**
  ├── Socket.IO  → リアルタイム GPU モニタリング
  │     ├── gpu:stats     GPU使用率・温度・VRAM
  │     ├── terminal:data SSHターミナルデータ
  │     └── pod:status    Pod状態変更通知
  │
  └── REST API → /api/**
        └── SQLite (sql.js) — data/gpu_rental.db
```

### 環境変数 (.env)

| 変数名 | 説明 |
|---|---|
| `PORT` | サーバーポート (デフォルト: 3000) |
| `JWT_SECRET` | JWT署名シークレット |
| `ADMIN_EMAIL` | 管理者メールアドレス |
| `ADMIN_PASSWORD` | 管理者パスワード |
| `SITE_URL` | 本番サイトURL |
| `EPSILON_CONTRACT_CODE` | GMOイプシロン 契約番号 |
| `EPSILON_MERCHANT_ID` | GMOイプシロン マーチャントID |
| `SITE_PASSWORD` | サイト全体パスワード (審査対応) |

---

## データベーステーブル一覧

| テーブル名 | 説明 | 主なカラム |
|---|---|---|
| `users` | ユーザー情報 | id, username, email, role, point_balance |
| `gpus` | GPU登録情報 | id, name, vram_total, status, price_per_hour |
| `pods` | 実行Pod | id, gpu_id, user_id, status, started_at |
| `reservations` | 予約情報 | id, gpu_id, user_id, start_time, end_time, docker_template |
| `point_purchases` | ポイント購入 | id, user_id, amount_yen, points_granted, coupon_code |
| `point_logs` | ポイント増減ログ | id, user_id, type, points, description |
| `user_api_keys` | APIキー | id, user_id, key_hash, key_prefix, is_active |
| `coupons` | クーポン | id, code, discount_type, discount_value, is_active |
| `coupon_usages` | クーポン使用履歴 | id, coupon_id, user_id, used_at |
| `runpod_pricing_snapshots` | RunPod価格スナップショット | id, gpu_name, runpod_price_jpy, suggested_price_jpy |
| `payout_requests` | 出金申請 | id, user_id, amount_yen, status |
| `bank_accounts` | 振込先口座 | id, user_id, bank_name, account_number |
| `outage_events` | 障害情報 | id, title, status, started_at |
| `password_resets` | パスワードリセット | id, user_id, token, expires_at |
| `bonus_logs` | ボーナスポイントログ | id, user_id, points, reason |

---

## 外部サービス連携

| サービス | 用途 | 設定場所 |
|---|---|---|
| **GMOイプシロン** | クレジットカード決済 | `.env` EPSILON_* |
| **Cloudflare Tunnel** | HTTPSトンネル・外部公開 | `cloudflared-config.yml` |
| **RunPod GraphQL API** | GPU料金監視 | `server/services/pricingMonitor.js` |
| **Nodemailer** | メール送信 (パスワードリセット等) | `server/services/email.js` |
| **nvidia-smi** | GPU情報取得 | `server/routes/diagnostics.js` |

---

## 関連リポジトリ

| リポジトリ | URL | 説明 |
|---|---|---|
| **janction** (本体) | [github.com/taichiyao333/janction](https://github.com/taichiyao333/janction) | メインプラットフォーム |
| **janction-saas-kit** | [github.com/taichiyao333/janction-saas-kit](https://github.com/taichiyao333/janction-saas-kit) | ホワイトラベルパッケージ |
| **janction-docker-templates** | [github.com/taichiyao333/janction-docker-templates](https://github.com/taichiyao333/janction-docker-templates) | GPU環境Dockerファイル集 |

---

*このドキュメントは `docs/07_site_structure.md` として管理されています。*
