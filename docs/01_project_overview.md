# GPU レンタルプラットフォーム - プロジェクト概要

## ドキュメント情報

| 項目 | 内容 |
|------|------|
| プロジェクト名 | GPU Rental Platform (RUNPOD型) |
| 作成日 | 2026-02-26 |
| バージョン | 1.0 |
| ステータス | 計画段階 |

---

## 1. プロジェクト概要

### 1.1 目的
ローカルマシンに搭載された複数のGPUリソースを、外部ユーザーに対してRUNPODのようなクラウドGPUサービスとして提供するプラットフォームを構築する。

### 1.2 主要機能
1. **GPUレンタル**: ユーザーが利用したいGPUを選択し、時間単位でレンタル
2. **WEB予約システム**: カレンダーベースの予約管理
3. **ユーザーワークスペース**: レンタル中のGPU環境をWebブラウザから操作
4. **管理者監視ダッシュボード**: 全GPU・ユーザー・予約のリアルタイム監視
5. **外部公開**: Cloudflare Tunnelによる安全な外部アクセス

### 1.3 対象ユーザー
- **エンドユーザー**: GPU計算リソースを必要とする開発者・クリエイター
- **管理者**: プラットフォーム運営者

---

## 2. システムアーキテクチャ

### 2.1 全体構成図

```
外部ユーザー (HTTPS)
       │
       ▼
Cloudflare Tunnel (安全な外部公開)
       │
       ├──► WEB予約ポータル (:3000)
       ├──► ユーザーワークスペース (:各Pod固有ポート)
       └──► 管理者ダッシュボード (:3001)
              │
              ▼
       Node.js Backend (Express)
       ├── Auth Service (JWT認証)
       ├── Reservation Service (予約管理)
       ├── Pod Manager (環境管理)
       ├── GPU Manager (GPU検出・監視)
       ├── Monitoring Service (監視)
       ├── WebSocket Server (リアルタイム通信)
       └── REST API Gateway
              │
       ┌──────┼──────┐
       ▼      ▼      ▼
    SQLite  GPU Pool  F:ストレージ
```

### 2.2 3つの主要画面

| 画面 | 対象 | 説明 |
|------|------|------|
| WEB予約ポータル | ユーザー | GPU閲覧・予約・マイページ |
| ワークスペース | ユーザー | GPU環境操作 (ターミナル・ファイル管理) |
| 管理者ダッシュボード | 管理者 | 全体監視・GPU管理・ユーザー管理 |

---

## 3. 技術スタック

| レイヤー | 技術 | 用途 |
|---------|------|------|
| フロントエンド | HTML5 + CSS + JavaScript | 全3画面 |
| バックエンド | Node.js + Express | APIサーバー |
| データベース | SQLite (better-sqlite3) | ユーザー・予約・履歴 |
| リアルタイム通信 | Socket.io | GPU監視・通知 |
| Webターミナル | xterm.js + node-pty | ターミナルエミュレータ |
| GPU管理 | nvidia-smi CLI | GPU検出・監視 |
| レンダリング | FFmpeg (NVENC) | 動画エンコード |
| 認証 | JWT + bcrypt | ユーザー認証 |
| スケジューラ | node-cron | 予約自動実行 |
| 外部公開 | Cloudflare Tunnel | セキュア公開 |
| ストレージ | F:/janction/ | ユーザーデータ |

---

## 4. ディレクトリ構成

```
f:/antigravity/gpu-platform/
├── server/
│   ├── index.js                  # メインサーバー
│   ├── config.js                 # 設定
│   ├── db/
│   │   ├── database.js           # SQLite接続
│   │   └── migrations.js         # テーブル作成
│   ├── middleware/
│   │   ├── auth.js               # JWT認証
│   │   └── rateLimit.js          # レート制限
│   ├── routes/
│   │   ├── auth.js               # 認証API
│   │   ├── gpus.js               # GPU管理API
│   │   ├── reservations.js       # 予約API
│   │   ├── pods.js               # Pod管理API
│   │   ├── files.js              # ファイル管理API
│   │   ├── render.js             # レンダリングAPI
│   │   ├── monitoring.js         # 監視API
│   │   └── admin.js              # 管理者API
│   ├── services/
│   │   ├── gpuManager.js         # GPU検出・監視
│   │   ├── podManager.js         # Pod作成・管理
│   │   ├── reservationService.js # 予約管理ロジック
│   │   ├── scheduler.js          # 自動開始/終了
│   │   ├── renderEngine.js       # FFmpegレンダリング
│   │   ├── alertService.js       # アラート管理
│   │   └── statsService.js       # 統計・レポート
│   └── websocket/
│       ├── gpuMonitor.js         # GPUリアルタイム監視
│       ├── podTerminal.js        # Webターミナル接続
│       └── notifications.js     # 通知配信
├── public/
│   ├── portal/                   # WEB予約ポータル
│   │   ├── index.html
│   │   ├── style.css
│   │   └── app.js
│   ├── workspace/                # ユーザーワークスペース
│   │   ├── index.html
│   │   ├── style.css
│   │   └── app.js
│   └── admin/                    # 管理者ダッシュボード
│       ├── index.html
│       ├── style.css
│       └── app.js
├── docs/                         # ドキュメント
├── package.json
├── .env
└── start.bat

F:/janction/                    # ストレージ
├── users/{userId}/
│   ├── workspace/
│   ├── uploads/
│   └── outputs/
├── shared/templates/
└── db/platform.db
```

---

## 5. データベース設計

```sql
-- ユーザー管理
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'user',        -- 'user' | 'admin'
    status TEXT DEFAULT 'active',    -- 'active' | 'suspended'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME
);

-- GPU登録
CREATE TABLE gpus (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_index INTEGER NOT NULL,
    name TEXT NOT NULL,
    vram_total INTEGER NOT NULL,     -- MB単位
    driver_version TEXT,
    price_per_hour REAL DEFAULT 0,   -- 円/時間
    status TEXT DEFAULT 'available', -- 'available' | 'rented' | 'maintenance'
    max_temp_threshold INTEGER DEFAULT 85,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 予約管理
CREATE TABLE reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    gpu_id INTEGER NOT NULL,
    start_time DATETIME NOT NULL,
    end_time DATETIME NOT NULL,
    status TEXT DEFAULT 'pending',   -- 'pending' | 'confirmed' | 'active' | 'completed' | 'cancelled'
    total_price REAL,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (gpu_id) REFERENCES gpus(id)
);

-- アクティブPod
CREATE TABLE pods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reservation_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    gpu_id INTEGER NOT NULL,
    workspace_path TEXT NOT NULL,
    cuda_device TEXT NOT NULL,
    port INTEGER,
    status TEXT DEFAULT 'creating',  -- 'creating' | 'running' | 'stopping' | 'stopped'
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    FOREIGN KEY (reservation_id) REFERENCES reservations(id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (gpu_id) REFERENCES gpus(id)
);

-- 利用ログ
CREATE TABLE usage_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pod_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    gpu_id INTEGER NOT NULL,
    gpu_util_avg REAL,
    vram_usage_avg REAL,
    max_temperature REAL,
    duration_minutes INTEGER,
    cost REAL,
    logged_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pod_id) REFERENCES pods(id)
);

-- アラート
CREATE TABLE alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,               -- 'temperature' | 'timeout' | 'error' | 'system'
    severity TEXT DEFAULT 'info',     -- 'info' | 'warning' | 'critical'
    message TEXT NOT NULL,
    gpu_id INTEGER,
    pod_id INTEGER,
    resolved BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME
);
```

---

## 6. API設計概要

### 認証 API
| Method | Endpoint | 説明 |
|--------|----------|------|
| POST | /api/auth/register | ユーザー登録 |
| POST | /api/auth/login | ログイン |
| POST | /api/auth/logout | ログアウト |
| GET | /api/auth/me | 自分の情報取得 |

### GPU API
| Method | Endpoint | 説明 |
|--------|----------|------|
| GET | /api/gpus | GPU一覧 |
| GET | /api/gpus/:id | GPU詳細 |
| GET | /api/gpus/:id/status | GPUリアルタイム状態 |
| PUT | /api/gpus/:id | GPU設定変更 (admin) |

### 予約 API
| Method | Endpoint | 説明 |
|--------|----------|------|
| GET | /api/reservations | 予約一覧 |
| POST | /api/reservations | 新規予約 |
| PUT | /api/reservations/:id | 予約変更 |
| DELETE | /api/reservations/:id | 予約キャンセル |
| GET | /api/reservations/calendar | カレンダーデータ |

### Pod API
| Method | Endpoint | 説明 |
|--------|----------|------|
| GET | /api/pods | アクティブPod一覧 |
| GET | /api/pods/:id | Pod詳細 |
| POST | /api/pods/:id/extend | 利用延長 |
| DELETE | /api/pods/:id | Pod強制終了 |

### ファイル API
| Method | Endpoint | 説明 |
|--------|----------|------|
| GET | /api/files/:podId | ファイル一覧 |
| POST | /api/files/:podId/upload | アップロード |
| GET | /api/files/:podId/download/:path | ダウンロード |
| DELETE | /api/files/:podId/:path | 削除 |

### 監視 API (admin)
| Method | Endpoint | 説明 |
|--------|----------|------|
| GET | /api/monitoring/overview | 全体概要 |
| GET | /api/monitoring/gpus | GPU監視データ |
| GET | /api/monitoring/alerts | アラート一覧 |
| GET | /api/monitoring/stats | 統計データ |

### WebSocket イベント
| イベント | 方向 | 説明 |
|---------|------|------|
| gpu:status | Server→Client | GPU状態更新 (5秒間隔) |
| pod:status | Server→Client | Pod状態変更通知 |
| alert:new | Server→Client | 新規アラート |
| reservation:remind | Server→Client | 予約リマインダー |
| terminal:data | 双方向 | ターミナル入出力 |
