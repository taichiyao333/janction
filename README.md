# 🚀 GPU Cloud Rendering System

> NVIDIA A6000 PROMAX × 12枚 / QNAP × 2台 / SeaweedFS 分散FS / AWS S3 / 10Gbps NURO によるエンタープライズグレードGPUクラウドレンダリングシステム

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-v18+-green.svg)](https://nodejs.org/)
[![Status](https://img.shields.io/badge/Status-In_Progress-orange.svg)]()
[![SeaweedFS](https://img.shields.io/badge/Storage-SeaweedFS-blue.svg)](https://seaweedfs.com/)
[![AWS S3](https://img.shields.io/badge/Cloud-AWS_S3-FF9900.svg)](https://aws.amazon.com/s3/)

---

## 📋 概要

NVIDIA A6000 PROMAX × 12枚のGPUクラスターを活用し、**AWS S3経由** でユーザーがファイルをアップロードし、データセンターの **QNAP + SeaweedFS分散ファイルシステム** でファイルを管理・処理する、エンタープライズグレードのGPUクラウドレンダリングシステムです。

### 主要機能

| 機能 | 説明 |
|------|------|
| ☁️ **S3アップロード** | ユーザーがAWS S3経由で最大5GBのレンダリングデータをアップロード |
| 💾 **SeaweedFS分散FS** | QNAP 2台 (M.2 4TB×8枚) + SeaweedFS で高速分散ストレージ |
| 🖥 **GPU分散レンダリング** | A6000 × 12枚を動的割当、並列レンダリング実行 |
| 📦 **アーカイブ管理** | 250TB HDD × 4台 (1PB) への自動ライフサイクル管理 |
| 📊 **Grafana監視** | GPU/ネットワーク/ストレージのリアルタイムダッシュボード |
| 🌐 **外部公開** | Cloudflare Tunnel + 10Gbps NURO回線 |

---

## 🏗 システムアーキテクチャ

```
【インターネット側】
  エンドユーザー
       │  HTTPS (S3 Presigned URL)
       ▼
  AWS S3 (ap-northeast-1)
  ├── /incoming/  ← ユーザーアップロード (~5GB/ジョブ)
  └── /results/   ← レンダリング完了データ
       │
       │  10Gbps NURO回線 (rclone/s5cmd 並列転送)
       ▼
【データセンター】
  10Gbps FIREWALL → 10Gbps SWITCH × 2
       │
  ┌────┼────────────────┐
  │    │                │
  ▼    ▼                ▼
 QNAP  QNAP          GPU Server
 NAS1  NAS2          A6000 × 12
  │    │
  └────┘ (SeaweedFS 分散FS)
       │
  アーカイバーHDD (250TB × 4台 = 1PB)
```

---

## 🛠 技術スタック

| レイヤー | 技術 |
|---------|------|
| クラウドストレージ | AWS S3 + Transfer Acceleration |
| 分散FS | SeaweedFS (Master/Volume/Filer) |
| ストレージ | QNAP NAS × 2台 (M.2 4TB × 8枚/台) |
| アーカイブ | ZFS on HDD (250TB × 4台) |
| GPU | NVIDIA A6000 PROMAX × 12枚 (CUDA/OptiX) |
| レンダリング | Blender CLI / FFmpeg NVENC |
| ジョブキュー | Redis + BullMQ |
| バックエンド | Node.js + Fastify |
| データベース | PostgreSQL |
| フロントエンド | Next.js 15 + TypeScript |
| 監視 | Prometheus + Grafana + Zabbix |
| 外部公開 | Cloudflare Tunnel |
| S3同期 | rclone / s5cmd |

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
| 2名体制 (エンジニアA・B) | 約 5ヶ月 | 7.0人月 |
| 3名体制 (+開発者1名) | 約 3.5ヶ月 | 7.0人月 |
| 4名体制 (+開発者2名) | 約 2.5ヶ月 | 7.0人月 |

詳細は [`docs/05_system_development_flow.md`](docs/05_system_development_flow.md) を参照。

---

## 📅 実装フェーズ

| # | フェーズ | 工数 | 状態 |
|---|---------|------|------|
| 0 | 環境検証・技術選定 | 160h | ✅ 完了 |
| 1 | インフラ基盤構築 (NW/QNAP/SeaweedFS/GPU-OS) | 200h | 🔄 進行中 |
| 2 | データパイプライン (S3↔SeaweedFS↔GPUキュー) | 120h | ⏳ 予定 |
| 3 | レンダリングエンジン (GPU割当/Blender/分散) | 160h | ⏳ 予定 |
| 4 | Webプラットフォーム (UI/API/管理画面) | 200h | ⏳ 予定 |
| 5 | 監視・運用 (Grafana/Prometheus) | 80h | ⏳ 予定 |
| 6 | セキュリティ・外部公開 | 60h | ⏳ 予定 |
| 7 | アーカイブ・長期運用 (1PB HDD管理) | 40h | ⏳ 予定 |

---

## 📋 前提条件

```
【インフラ】
□ NVIDIA A6000 PROMAX × 12枚 + ドライバー (535+)
□ CUDA Toolkit 12.x + NVIDIA Container Toolkit
□ QNAP NAS (QTS最新版) × 2台
□ M.2 NVMe SSD 4TB × 8枚/台
□ 250TB HDD アーカイバー × 4台
□ 10Gbps NURO インターネット回線
□ 10Gbps ファイアウォール × 1台
□ 10Gbps コアスイッチ × 2台
□ 1Gbps 管理スイッチ × 1台

【ソフトウェア】
□ Ubuntu 22.04/24.04 LTS (GPUサーバー・VM)
□ SeaweedFS (latest from GitHub)
□ Docker + Docker Compose
□ Node.js v18+
□ PostgreSQL 16+
□ Redis 7+
□ Blender (ヘッドレス対応版)
□ rclone / s5cmd

【クラウド】
□ AWS アカウント (S3, SQS, CloudWatch)
□ Cloudflare アカウント (Tunnel)
```

---

## 🗂 ドキュメント

| ドキュメント | 内容 |
|------------|------|
| **[🆕 完全開発フロー](docs/05_system_development_flow.md)** | **インフラ〜アプリ全体の開発フロー (最新版)** |
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
