# 🚀 GPU Rental Platform

> RUNPODライクな、ローカルGPUリソースを外部ユーザーへ貸し出すプラットフォーム

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-v18+-green.svg)](https://nodejs.org/)
[![Status](https://img.shields.io/badge/Status-Planning-blue.svg)]()

---

## 📋 概要

ローカルマシンに搭載された複数のGPUリソースを、外部ユーザーに対してクラウドGPUサービスとして提供するプラットフォームです。

### 主要機能

| 機能 | 説明 |
|------|------|
| 🖥 **GPUレンタル** | ユーザーが利用したいGPUを選択し時間単位でレンタル |
| 📅 **WEB予約システム** | カレンダーベースの予約管理・競合チェック |
| 💻 **ユーザーワークスペース** | Webブラウザからターミナル・ファイル管理・GPUモニター |
| 🛡 **管理者ダッシュボード** | リアルタイム監視・アラート・レポート機能 |
| 🌐 **外部公開** | Cloudflare Tunnelによる安全な外部アクセス |

---

## 🏗 システムアーキテクチャ

```
外部ユーザー (HTTPS)
       │
       ▼
Cloudflare Tunnel
       │
       ├──► WEB予約ポータル      (Port: 3000)
       ├──► ユーザーワークスペース (Port: 動的割当)
       └──► 管理者ダッシュボード   (Port: 3001)
              │
              ▼
       Node.js + Express Backend
       ├── 認証 (JWT)
       ├── 予約管理 (SQLite)
       ├── Pod管理 (ユーザー環境隔離)
       ├── GPU管理 (nvidia-smi)
       └── WebSocket (リアルタイム通信)
              │
       ┌──────┼──────┐
       ▼      ▼      ▼
    SQLite  GPU Pool  F:/gpu-rental/ (ストレージ)
```

---

## 🛠 技術スタック

| レイヤー | 技術 |
|---------|------|
| フロントエンド | HTML5 + Vanilla CSS + JavaScript |
| バックエンド | Node.js + Express |
| データベース | SQLite (better-sqlite3) |
| リアルタイム通信 | Socket.io |
| Webターミナル | xterm.js + node-pty |
| GPU管理 | nvidia-smi CLI |
| レンダリング | FFmpeg (NVENC) |
| 認証 | JWT + bcrypt |
| スケジューラ | node-cron |
| 外部公開 | Cloudflare Tunnel |

---

## 📁 ディレクトリ構成

```
gpu-platform/
├── docs/                         # ドキュメント
│   ├── 01_project_overview.md    # プロジェクト概要・アーキテクチャ
│   ├── 02_implementation_phases.md # 実装フェーズ詳細
│   ├── 03_effort_estimation.md   # 工数見積もり
│   └── 04_user_flow_sequence.md  # ユーザーフロー・シーケンス
├── server/                       # バックエンド (実装予定)
├── public/                       # フロントエンド (実装予定)
│   ├── portal/                   # WEB予約ポータル
│   ├── workspace/                # ユーザーワークスペース
│   └── admin/                    # 管理者ダッシュボード
├── .gitignore
└── README.md
```

---

## 📊 開発工数見積もり

| 体制 | 期間 | 人月 |
|------|------|------|
| 1名開発 | 約 3.5ヶ月 | 3.75人月 |
| 2名開発 | 約 2ヶ月 | 3.75人月 |
| 3名開発 | 約 1.5ヶ月 | 3.75人月 |

詳細は [`docs/03_effort_estimation.md`](docs/03_effort_estimation.md) を参照。

---

## 📅 実装フェーズ

| # | フェーズ | 工数 | 難易度 |
|---|---------|------|--------|
| 0 | 環境確認・準備 | 1日 | ★☆☆☆☆ |
| 1 | 基盤構築 (サーバー/DB/認証/GPU検出) | 10日 | ★★★☆☆ |
| 2 | WEB予約システム | 15日 | ★★★☆☆ |
| 3 | Pod管理 + ワークスペース | 20日 | ★★★★★ |
| 4 | 管理者ダッシュボード | 15日 | ★★★☆☆ |
| 5 | 外部公開 + セキュリティ | 5日 | ★★☆☆☆ |

---

## 📋 前提条件

```
□ Node.js v18+
□ npm v9+
□ NVIDIA GPU + 最新ドライバー
□ FFmpeg (NVENC対応ビルド)
□ Git
□ F:ドライブ (専用ストレージ領域)
□ Cloudflare アカウント
```

---

## 🗂 ドキュメント

| ドキュメント | 内容 |
|------------|------|
| [プロジェクト概要](docs/01_project_overview.md) | アーキテクチャ・技術スタック・DB設計・API設計 |
| [実装フェーズ詳細](docs/02_implementation_phases.md) | 全フェーズの詳細タスク |
| [工数見積もり](docs/03_effort_estimation.md) | 人月・期間・コスト試算 |
| [ユーザーフロー](docs/04_user_flow_sequence.md) | シーケンス図・ステータス遷移図 |

---

## 📄 ライセンス

MIT License - 詳細は [LICENSE](LICENSE) を参照

---

## 👤 作者

Antigravity GPU Platform Project - 2026
