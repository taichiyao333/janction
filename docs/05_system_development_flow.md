# GPU クラウドレンダリングシステム - 完全開発フロー

## ドキュメント情報

| 項目 | 内容 |
|------|------|
| プロジェクト名 | GPU Cloud Rendering System |
| 作成日 | 2026-03-01 |
| バージョン | 1.3 |
| ステータス | 開発進行中 |
| 体制 | エンジニアA（インフラ・S3/AWS連携担当）＋ エンジニアB（SeaweedFS担当）＋ 開発チーム |
| 開発期区分 | **第1期**: インフラ基盤＋レンダリング稼働 / **第2期**: SeaweedFSアーカイブ＋本格外部公開 |

---

## 1. システム全体構成図

### 1.1 ストレージ役割の整理

| 機器 | 役割 | 対象データ | 開発期 |
|------|------|----------|-------|
| **QNAP NAS × 4台** (M.2 NVMe 32TB/台) | **ホットストレージ** | アクティブジョブ（受信〜レンダリング〜結果DLまで） | 第1期 |
| **SeaweedFS HDD サーバー × 4台** (250TB/台) | **長期アーカイブ** | ジョブ完了後の長期保存（アーカイブ管理） | 第2期 |

> SeaweedFS は **分散型アーカイブストレージ** として位置付ける。  
> アクティブなレンダリング処理は QNAP (NVMe) が担い、完了済みジョブを SeaweedFS へ移動・長期保存する。

```
【インターネット側】
  エンドユーザー
       │  HTTPS (S3 Presigned URL)
       ▼
  AWS S3 (ap-northeast-1)
  ├── /incoming/  ← ユーザーアップロード (~5GB/ジョブ)
  └── /results/   ← レンダリング完了・ダウンロード用
       │
       │  10Gbps NURO回線 (rclone/s5cmd 並列転送)
       ▼
【データセンター側】
  ┌───────────────────────────────────────────────────────────┐
  │  10Gbps FIREWALL (1台)                                    │
  │       │                                                   │
  │  10Gbps SWITCH (2台)                                      │
  │       │                                                   │
  │  ┌────┼──────────────────┬─────────────┐                 │
  │  │    │                  │             │                  │
  │  ▼    ▼                  ▼             ▼                  │
  │ QNAP NAS × 4台        GPU Server   Zabbix監視             │
  │ (M.2 NVMe 32TB/台)    A6000 × 12   サーバー              │
  │ [ホットストレージ]      │                                  │
  │  ▲    │  ◄──受信─────┘                                  │
  │  │    └──►レンダリング出力保存                            │
  │  │         ジョブ完了後 ↓ 自動アーカイブ移動（第2期）       │
  │  │                                                        │
  │  └──────────────────────────────────────────────────►    │
  │           SeaweedFS HDD サーバー × 4台                    │
  │           (250TB/台, 3複製時 実効 約532TB)                 │
  │           [長期アーカイブストレージ] ※第2期構築            │
  └───────────────────────────────────────────────────────────┘
       │
  1Gbps SWITCH (管理用)
```

> 📌 **各機器の役割**:  
> - **QNAP NAS × 4台 (M.2 NVMe)**: アクティブジョブ用ホットストレージ（S3受信〜レンダリング〜結果DL）**【第1期稼働】**  
> - **SeaweedFS HDD サーバー × 4台 (250TB/台)**: 完了ジョブの長期アーカイブ（分散冗長保存）**【第2期構築】**

---

## 2. ハードウェア構成一覧

### 2.1 コンピューティング

| 機器 | スペック | 台数 | 用途 | 開発期 |
|------|---------|------|------|-------|
| GPU サーバー | NVIDIA A6000 PROMAX × 12 | 1クラスター | レンダリング実行 | 第1期 |
| QNAP NAS | M.2 NVMe 4TB × 8枚 = 32TB/台 | 4台 | **ホットストレージ**（アクティブジョブ受信〜完了まで） | 第1期 |
| SeaweedFS HDD サーバー | 250TB/台（機種・構成未定） | 4台 | **長期アーカイブ**（完了ジョブの分散冗長保存） | 第2期 |

### 2.2 ネットワーク機器

| 機器 | スペック | 台数 | 用途 |
|------|---------|------|------|
| ファイアウォール | 10Gbps対応 | 1台 | 外部通信セキュリティ |
| コアスイッチ | 10Gbps | 2台 | 内部高速バックボーン |
| 管理スイッチ | 1Gbps | 1台 | 管理・監視ネットワーク |
| インターネット回線 | NURO 10Gbps | 1回線 | AWS S3との通信 |

### 2.3 役割分担: QNAP vs SeaweedFS HDDサーバー

| 機器 | 役割 | 用途詳細 |
|------|------|----------|
| **QNAP NAS × 4台** (M.2 NVMe, 計128TB) | **ホットストレージ** | S3から受信したジョブデータ保存 → GPU高速アクセス → 完了結果をS3へ返却。NVMeの高速I/Oでレンダリング処理を支える |
| **SeaweedFS HDD サーバー × 4台** (計1PB) | **長期アーカイブ** | 完了ジョブをQNAPから移動し分散冗長保存。3複製設定時の実効容量は約**532TB** |

### 2.4 SeaweedFS クラスター構成（**検証中**）【第2期対象】

> 📌 **前提**: SeaweedFSはHDDサーバー 4台上で動作させる。各サーバーが複数のSeaweedFSロールを兼務する。

| ロール | 台数 | 役割 |
|--------|------|------|
| Masterサーバー | 3台 | メタデータ管理・Raft選出（奇数必須） |
| Filerサーバー | 2台 | クライアントアクセス用（冗長構成） |
| Volumeサーバー | **4台** | 実データ保存（全HDDサーバーが担当） |
| HAProxy (LB) | 2台 | FilerへのVIPフェイルオーバー |

> ⚠️ **ステータス**: 現在検証環境で性能試験・フェイルオーバー試験を実施中。合格後にサービス環境を構築する予定。

#### HDDサーバー 4台へのロール配置（修正版）

```
  HDDサーバー1 (250TB)
    ├─ weed master  … Raft Leader候補
    ├─ weed volume  … 250TB全HDD容量をVolumeとして提供
    ├─ weed filer   … クライアントアクセス窓口①
    └─ HAProxy      … LB VIP (Primary)

  HDDサーバー2 (250TB)
    ├─ weed master  … Raft Follower
    ├─ weed volume  … 250TB全HDD容量をVolumeとして提供
    ├─ weed filer   … クライアントアクセス窓口②
    └─ HAProxy      … LB VIP (Standby, Keepalived)

  HDDサーバー3 (250TB)
    ├─ weed master  … Raft Follower (3台でRaft合意を保証)
    └─ weed volume  … 250TB全HDD容量をVolumeとして提供

  HDDサーバー4 (250TB)
    └─ weed volume  … 250TB全HDD容量をVolumeとして提供

物理容量合計 : 4台 × 250TB = 1,000TB
3複製時 実効容量: 約 532TB
※ FilerのメタデータDB: 各Filerサーバーにて組込DBまたは外部MySQL使用
```

---

## 3. 開発フェーズ全体マップ（第1期 / 第2期）

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 【第1期】インフラ基盤 ＋ レンダリング稼働
  目標: GPUレンダリングサービスをまず稼働させる
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Phase 0: 環境検証・技術選定 ──────────► 完了 ✅ (一部継続中)
  └─ S3帯域検証 / SeaweedFS選定(第2期用) / 構成検討

Phase 1: インフラ基盤構築 ────────────► 現在着手中 🔄
  ├─ ネットワーク設計・構築 (構成確定後に詳細手順決定)
  ├─ QNAP NAS 4台 セットアップ (ホットストレージ)
  └─ GPU サーバー OS セットアップ

Phase 2: データパイプライン (第1期版) ──► 次フェーズ
  └─ S3 ↔ QNAP 同期 / ジョブキュー (Redis+BullMQ)

Phase 3: レンダリングエンジン ─────────► 次フェーズ
  └─ Blender + A6000×12 / GPU動的割当

Phase 4: 基本Webプラットフォーム ───────► 次フェーズ
  └─ ジョブ投入UI / 進捗確認 / 結果DL

Phase 5: 基本監視 (Zabbix) ────────────► 次フェーズ
  └─ QNAP/GPU/ネットワーク監視・アラート設定

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 【第2期】SeaweedFS アーカイブ ＋ 本格外部公開
  目標: 長期保存・高度なWebUI・外部サービス化
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Phase 6: SeaweedFS アーカイブ構築 ──────► 第2期
  └─ HDD サーバー 4台セットアップ / SeaweedFS本番展開
       実効容量 約532TB (3複製設定)

Phase 7: 自動アーカイブ連携 ────────────► 第2期
  └─ QNAP(完了ジョブ) → SeaweedFS 自動移動
       ライフサイクル管理 / 容量監視

Phase 8: 本格Webプラットフォーム ────────► 第2期
  └─ 管理者機能 / 課金 / ユーザー管理 / API強化

Phase 9: セキュリティ強化・外部公開 ─────► 第2期
  └─ Cloudflare Tunnel / WAF / 外部アクセス本番化

Phase 10: 長期運用・高度化 ──────────────► 第2期以降
  └─ 容量管理 / S3 Glacier連携 / パフォーマンス最適化
```

---

## 4. Phase 0: 環境検証・技術選定（完了 / 一部継続）

### 4.1 完了済み ✅

| 検証項目 | 結果 | 担当 |
|---------|------|------|
| S3 署名付きURL ダウンロード検証 | 完了（結果.xlsx参照） | エンジニアA |
| 1Gbps vs 10Gbps 帯域評価 | **10Gbps必要**と判断 | エンジニアA |
| LizardFS 評価 | **断念**（リポジトリ廃止） | エンジニアB |
| SeaweedFS 評価 | **採用決定** | エンジニアB |
| SeaweedFS 冗長構成検証環境 | 構築完了（16ノード構成） | エンジニアB |

### 4.2 継続中 🔄

| 検証項目 | 状況 | 担当 | 目標期日 |
|---------|------|------|---------|
| S3マルチパート並列アップロード検証 | AWSアカウント設定待ち | エンジニアA | 3月中 |
| NURO 10Gbps回線契約・開通 | 検討中 | エンジニアA | 要確認 |
| SeaweedFS 本番構成の性能測定 | 検証環境での計測予定 | エンジニアB | 3月末 |

### 4.3 AWS アカウント設定手順

```bash
# 1. AWSアカウント作成後、S3バケット作成
aws s3 mb s3://gpu-render-incoming-prod --region ap-northeast-1

# 2. S3 Transfer Acceleration 有効化
aws s3api put-bucket-accelerate-configuration \
  --bucket gpu-render-incoming-prod \
  --accelerate-configuration Status=Enabled

# 3. マルチパートアップロード検証スクリプト実行
python3 scripts/s3_multipart_benchmark.py \
  --bucket gpu-render-incoming-prod \
  --file-size 5GB \
  --parallel-parts 16
```

---

## 5. Phase 1: インフラ基盤構築

### 5.1 ネットワーク設計・構築

> ⚠️ **未決定**: VLAN設計・ファイアウォールルール・設定手順はすべて未決定です。
> QNAP 4台構成・SeaweedFS構成が確定した後、ネットワーク設計を具体化します。

#### 現時点での方針（参考）

| 項目 | 状況 | 備考 |
|------|------|------|
| VLAN 設計 | **未決定** | QNAP構成確定後に設計 |
| ファイアウォールルール | **未決定** | ネットワーク設計確定後 |
| 10Gbps FIREWALL 設定 | **未決定** | 設定手順は構成確定後 |
| 10Gbps SWITCH 設定 | **未決定** | 設定手順は構成確定後 |
| 1Gbps 管理SWITCH 設定 | **未決定** | 設定手順は構成確定後 |
| NURO 10Gbps 回線収容 | 検討中 | 開通日要確認 |

#### 今後の手順（確定後に詳細化）

```
□ Step 1.1: QNAP 4台構成・SeaweedFS構成の最終確定
□ Step 1.2: ネットワーク設計書の作成 (VLAN / ルーティング / FWルール)
□ Step 1.3: 設計レビュー・承認
□ Step 1.4: ネットワーク機器への設定投入
□ Step 1.5: NURO 10Gbps 回線収容・疎通確認
□ Step 1.6: 通信テスト (iperf3)
```

### 5.2 QNAP NAS セットアップ

> ⚠️ **未決定**: QNAP 4台の具体的な構成（2台×2グループ / 4台統合 / その他）が未確定です。
> 構成を決定した後、詳細な設定手順を策定します。動作検証も必要なため、十分な期間を確保する必要があります。

#### QNAP 構成パターン（検討中）

| パターン | 構成 | メリット | デメリット |
|---------|------|---------|----------|
| **案A**: 2台×2グループ | NAS1+NAS2 でSeaweedFS群A / NAS3+NAS4 でSeaweedFS群B | 障害分離・冗長性高い | 管理が複雑 |
| **案B**: 4台統合 | 4台すべてをSeaweedFSに統合（Volume数を増やす） | シンプル・総容量大 | 1グループ障害時の影響大 |
| **案C**: 役割分担 | 2台をSeaweedFS用、2台をバックアップ/アーカイブ前段用 | 用途明確 | 要詳細設計 |

```
【今後の手順 (構成決定後に詳細化)】
□ Step 2.1: QNAP 4台の構成方針を決定・合意
□ Step 2.2: 構成に応じた動作検証（性能・フェイルオーバー）
□ Step 2.3: 検証合格後、本番セットアップ手順書を作成
□ Step 2.4: 本番セットアップ実施
□ Step 2.5: SeaweedFS との統合確認
```

### 5.3 SeaweedFS 環境構築（検証→本番の2ステップ）

> 📋 **方針**: SeaweedFSはHDDサーバー 4台上で動作させる。
> まず検証環境での性能試験・フェイルオーバー試験を完了させ、合格後にサービス環境（本番）を構築する。

#### ステップ概要

```
【Step A: 検証環境での試験】(現在進行中 🔄)
  ├─ 書込み/読込み性能測定 (目標: Write ≥ 500MB/s, Read ≥ 1GB/s)
  ├─ フェイルオーバーテスト (Master障害/Volume障害)
  ├─ 長時間安定性テスト
  └─ 試験合格の判定

【Step B: サービス環境構築】(検証合格後)
  ├─ HDDサーバー 4台へのSeaweedFSロール配置設計
  ├─ 本番環境インストール・設定
  └─ QNAPキャッシュとの連携テスト
```

#### 検証環境 SeaweedFS サーバー構成（現在の検証対象）

#### 本番構成アーキテクチャ

```
QNAP NAS 1
├── [VM] Load Balancer 1 (HAProxy)
├── [VM] Filer Server 1
├── [VM] Master Server 1 (Leader候補)
├── [VM] Master Server 2
├── [VM] Database Server 1 (MySQL/TiDB)
├── [VM] Volume Server 1 (M.2 NVMe直接マウント)
└── [VM] Volume Server 2

QNAP NAS 2
├── [VM] Load Balancer 2 (HAProxy) ← VIPでフェイルオーバー
├── [VM] Filer Server 2
├── [VM] Master Server 3
├── [VM] Database Server 2
├── [VM] Database Server 3
└── [VM] Volume Server 3
```

#### SeaweedFS インストール手順（Ubuntu 24.04 LTS）

```bash
# 1. GitHubから最新バイナリ取得
wget https://github.com/seaweedfs/seaweedfs/releases/latest/download/linux_amd64.tar.gz
tar -xzf linux_amd64.tar.gz
sudo mv weed /usr/local/bin/

# 2. Master Server 起動 (3台, Raft合意)
weed master -port=9333 -mdir=/data/master \
  -peers=master1:9333,master2:9333,master3:9333

# 3. Volume Server 起動
weed volume -port=8080 -dir=/data/volumes \
  -max=100 -mserver=master1:9333,master2:9333,master3:9333

# 4. Filer Server 起動
weed filer -port=8888 \
  -master=master1:9333,master2:9333,master3:9333 \
  -s3

# 5. S3互換API確認
curl http://filer1:8333/

# 6. systemd サービス化
sudo systemctl enable weed-master weed-volume weed-filer
sudo systemctl start weed-master weed-volume weed-filer
```

#### SeaweedFS チェックリスト

```
□ Step 3.1: Master 3台 起動・Raft選出確認
□ Step 3.2: Volume Server 3台 起動・データ書き込み確認
□ Step 3.3: Filer Server 2台 起動・S3 API確認
□ Step 3.4: HAProxy Load Balancer 2台 設定・VIP設定 (Keepalived)
□ Step 3.5: POSIX マウント確認 (FUSE経由)
□ Step 3.6: フェイルオーバーテスト (Master1ダウン→自動切替確認)
□ Step 3.7: 書き込み/読み込み性能測定
              目標: Write 5GB/min以上 (S3→QNAPコピー速度確保)
```

### 5.4 GPU サーバー OS セットアップ

```
□ Step 4.1: Ubuntu 22.04 LTS Server インストール (全ノード)
□ Step 4.2: NVIDIA Driver インストール (A6000対応最新版)
             sudo apt install nvidia-driver-535
□ Step 4.3: CUDA Toolkit 12.x インストール
□ Step 4.4: Docker + NVIDIA Container Toolkit インストール
□ Step 4.5: SeaweedFS クライアント マウント設定
             weed mount -filer=filer-vip:8888 -dir=/mnt/seaweedfs
□ Step 4.6: GPU動作確認
             nvidia-smi / 負荷テスト (gpu-burn)
□ Step 4.7: ジョブワーカー設定（後述）
```

### 5.5 SeaweedFS HDDサーバーセットアップ

> ⚠️ **未決定**: HDDサーバーの機種・OS・ストレージ構成（RAIDレベル等）は未決定です。
> 構成決定後に詳細手順を策定します。

#### 検討事項

| 項目 | 状況 | 備考 |
|------|------|------|
| 機種・OS | **未決定** | Linux系を想定 (Ubuntu 22.04 or 24.04 LTS) |
| RAIDレベル | **未決定** | RAID6 / ZFS RAIDZ2 等を検討 |
| ファイルシステム | **未決定** | XFS (大容量向け) / ZFS 等 |
| SeaweedFSへのHDDディレクトマウント | **未決定** | Volumeサーバーのディスクディレクト管理 |

```
【今後の手順 (構成決定後に詳細化)】
□ Step 5.1: HDDサーバー機種・構成の決定
□ Step 5.2: OS インストール・初期設定
□ Step 5.3: HDDアレイ構成 (RAID/ZFSなど)
□ Step 5.4: SeaweedFSインストール (GitHubバイナリ)
□ Step 5.5: SeaweedFS Volume/Master/Filer ロール設定 (4台配置設計に従う)
□ Step 5.6: HAProxy ロードバランサー設定 (Keepalived VIP)
□ Step 5.7: seaweedfs兼 QNAPNVMeキャッシュ連携テスト
□ Step 5.8: 監視・アラート設定 (Zabbix)
```

---

## 6. Phase 2: データパイプライン構築

### 6.1 S3 ↔ データセンター 同期システム

ユーザーがS3にアップロードしたファイルを、自動でデータセンターのSeaweedFS（HDDサーバー 4台）に取り込み、アクティブジョブ間はQNAP（NVMeキャッシュ）を経由してGPUで高速処理する。

#### アーキテクチャ

```
User Browser
    │ マルチパート PUT (5GB)
    ▼
AWS S3 (ap-northeast-1)
  incoming/{jobId}/
    │
    │ S3 Event Notification (SQS)
    ▼
  AWS SQS Queue
    │
    │ 10Gbps NURO回線
    │ rclone / s5cmd 並列ダウンロード
    ▼
Data Sync Worker (データセンター)
    │
    ▼
SeaweedFS (HDDサーバー 4台) /jobs/{jobId}/input/
    │ ジョブデータを分散保存
    │ (必要に応じてQNAP NVMeキャッシュへプリフェッチ)
    ▼
QNAP NAS (M.2 NVMe) ホットキャッシュバッファ
    │ アクティブジョブデータをNVMe高速キャッシュ
    ▼
Render Job Queue (Redis / BullMQ)
    │
    ▼
GPU Render Worker (A6000 × 12)
    │ QNAPキャッシュから高速読み込み・SeaweedFSへ書き戻し
    ▼
SeaweedFS (HDDサーバー 4台) /jobs/{jobId}/output/
    │
    │ rclone parallel upload
    ▼
AWS S3 results/{jobId}/
    │
    │ Presigned URL (24h)
    ▼
User Browser (ダウンロード)
```

#### S3→データセンター 高速同期 (rclone設定)

```ini
# /etc/rclone/rclone.conf
[s3-gpu-render]
type = s3
provider = AWS
region = ap-northeast-1
acl = private

[seaweedfs-local]
type = s3
provider = Other
endpoint = http://filer-vip:8333
access_key_id = your-access-key
secret_access_key = your-secret-key
```

```bash
# 高速同期スクリプト (16並列, チャンクサイズ 128MB)
rclone copy s3-gpu-render:gpu-render-incoming/jobs/${JOB_ID}/ \
  seaweedfs-local:jobs/${JOB_ID}/input/ \
  --transfers=16 \
  --s3-chunk-size=128M \
  --s3-upload-concurrency=16 \
  --progress
```

#### s5cmd（rclone代替、高速）

```bash
# s5cmd は Golang製で高速なS3クライアント
s5cmd --numworkers 256 \
  cp "s3://gpu-render-incoming/jobs/${JOB_ID}/*" \
  "s3://seaweedfs-local/jobs/${JOB_ID}/input/"
```

### 6.2 ジョブキューシステム設計

```javascript
// ジョブオブジェクト設計 (Redis JSON)
{
  "jobId": "uuid-v4",
  "userId": "user-001",
  "status": "pending", // pending→queued→downloading→rendering→uploading→completed|failed
  "inputPath": "/jobs/{jobId}/input/",
  "outputPath": "/jobs/{jobId}/output/",
  "renderSettings": {
    "engine": "blender|octane|vray|arnold",
    "resolution": "3840x2160",
    "samples": 512,
    "frames": "1-250",
    "gpuCount": 4,
    "cudaDevices": [0, 1, 2, 3]
  },
  "priority": "normal", // low|normal|high|urgent
  "createdAt": "2026-03-01T00:00:00Z",
  "startedAt": null,
  "completedAt": null,
  "progress": 0,
  "estimatedTime": null,
  "cost": null,
  "s3InputUrl": "s3://gpu-render-incoming/...",
  "s3OutputUrl": "s3://gpu-render-results/..."
}
```

#### ジョブキュー チェックリスト

```
□ Step 6.1: Redis / Redis Cluster インストール (HA構成)
□ Step 6.2: BullMQ (Node.js) ジョブキューワーカー実装
□ Step 6.3: S3 Event Notification → SQS → ワーカートリガー設定
□ Step 6.4: ジョブステータス管理API実装
□ Step 6.5: 並列ジョブ実行制御 (GPU空き状況に応じた動的割当)
□ Step 6.6: ジョブ失敗時リトライ・Dead Letter Queue設定
□ Step 6.7: ジョブキュー監視ダッシュボード (Bull Dashboard)
```

---

## 7. Phase 3: レンダリングエンジン開発

### 7.1 対応レンダーエンジン

| エンジン | 対応状況 | GPU利用 | 備考 |
|---------|---------|---------|------|
| Blender Cycles | ✅ 最優先 | CUDA/OptiX | オープンソース |
| Blender EEVEE | ✅ 対応 | OpenGL | リアルタイム系 |
| Octane Render | 🔄 検討 | CUDA | 高品質 |
| V-Ray | 🔄 検討 | CUDA | 建築・CG向け |
| Arnold | 🔄 検討 | CUDA | VFX向け |
| FFmpeg NVENC | ✅ 対応 | NVENC | 動画エンコード |

### 7.2 Blender GPU レンダリング 設定

```bash
# Blender CLIによるGPUレンダリング (CUDA)
blender -b /mnt/seaweedfs/jobs/${JOB_ID}/input/scene.blend \
  -o /mnt/seaweedfs/jobs/${JOB_ID}/output/ \
  -F PNG \
  -x 1 \
  -s ${START_FRAME} -e ${END_FRAME} \
  --python /opt/render/set_gpu.py \
  -a

# set_gpu.py (CUDAデバイス指定)
import bpy
scene = bpy.context.scene
scene.cycles.device = 'GPU'
prefs = bpy.context.preferences.addons['cycles'].preferences
prefs.compute_device_type = 'OPTIX'  # A6000なのでOptiX推奨
for device in prefs.devices:
    if device.type in ['CUDA', 'OPTIX']:
        device.use = True
```

### 7.3 A6000 × 12 GPU 割当戦略

```
GPUプール管理システム:

GPU 0-3  → Job A (4GPU割当)
GPU 4-7  → Job B (4GPU割当)
GPU 8-11 → Job C (4GPU割当)
             ↕
       GPU Manager Service
       ├─ 空きGPU検出 (nvidia-smi)
       ├─ ジョブ←→GPU マッピング
       ├─ CUDA_VISIBLE_DEVICES 設定
       └─ 温度・使用率監視 (過熱時自動スロットル)
```

#### レンダリングワーカー チェックリスト

```
□ Step 7.1: Blender インストール (ヘッドレスモード)
□ Step 7.2: GPU Manager Service 開発 (Node.js or Python)
              - nvidia-smi 常時ポーリング
              - GPU空き状況管理
              - 動的GPU割当
□ Step 7.3: Render Worker 開発
              - BullMQコンシューマー
              - ジョブ受取 → SeaweedFSマウント確認 → Blender実行
              - 進捗取得 (blender --log-file パース)
              - 完了→S3アップロード
□ Step 7.4: フレーム分散レンダリング対応
              12GPUで1ジョブを並列実行 (フレーム分割)
□ Step 7.5: A6000 OptiX最適化設定
□ Step 7.6: レンダリング所要時間推定アルゴリズム
□ Step 7.7: GPU温度・使用率監視 → 自動サーマルスロットリング
```

---

## 8. Phase 4: Webプラットフォーム開発

### 8.1 システム全体の画面構成

| 画面 | URL | 対象 | 機能 |
|------|-----|------|------|
| ランディングページ | / | 一般 | サービス紹介・料金 |
| ユーザー登録/ログイン | /auth | 全ユーザー | 認証 |
| ジョブ投入画面 | /jobs/new | 一般ユーザー | ファイルアップロード・レンダー設定 |
| ジョブ一覧/状況 | /jobs | 一般ユーザー | 進捗確認・結果DL |
| 管理者ダッシュボード | /admin | 管理者 | 全体監視 |
| GPU監視画面 | /admin/gpus | 管理者 | RTX状態・温度 |
| ジョブ管理画面 | /admin/jobs | 管理者 | キュー管理 |
| ストレージ監視 | /admin/storage | 管理者 | SeaweedFS/アーカイバー |

### 8.2 ジョブ投入UI フロー

```
Step 1: ファイルアップロード
  ├─ S3 Presigned URL取得 (バックエンドAPI)
  ├─ マルチパートアップロード (最大5GB)
  └─ 進捗バー表示

Step 2: レンダリング設定
  ├─ エンジン選択 (Blender / V-Ray / FFmpeg)
  ├─ 解像度設定 (1080p / 4K / 8K)
  ├─ フレーム範囲 (開始〜終了フレーム)
  ├─ サンプル数 (品質)
  ├─ GPU数 (1-12)
  └─ 優先度 (Standard/Priority/Ultra)

Step 3: 見積もり確認
  ├─ 推定処理時間
  ├─ 料金計算 (GPU数 × 時間 × 単価)
  └─ 支払い確認

Step 4: ジョブ実行 & 監視
  ├─ リアルタイム進捗 (WebSocket)
  ├─ 現在レンダリング中のフレーム番号
  ├─ 経過時間 / 残り時間
  └─ GPU使用率グラフ

Step 5: 完了 & ダウンロード
  ├─ S3 Presigned URL (24h有効)
  └─ ZIP一括ダウンロード or 個別ダウンロード
```

### 8.3 技術スタック（Webプラットフォーム）

```
フロントエンド: Next.js 15 (App Router) + TypeScript
バックエンド:  Node.js + Fastify / Express
データベース:  PostgreSQL (メイン) + Redis (キャッシュ/キュー)
認証:         NextAuth.js (Google OAuth + メール認証)
ファイル転送:  AWS SDK v3 (S3 Multipart Upload)
リアルタイム: Socket.IO
コンテナ:     Docker + Docker Compose
外部公開:     Cloudflare Tunnel or Nginx + Let's Encrypt
課金:         Stripe API (将来対応)
```

### 8.4 バックエンドAPI 設計

#### ジョブ管理 API

| Method | Endpoint | 説明 |
|--------|----------|------|
| POST | /api/jobs | 新規ジョブ作成 |
| GET | /api/jobs | ジョブ一覧取得 |
| GET | /api/jobs/:id | ジョブ詳細・進捗 |
| DELETE | /api/jobs/:id | ジョブキャンセル |
| POST | /api/jobs/upload-url | S3 Presigned URL発行 |
| GET | /api/jobs/:id/download-url | 結果DL URL発行 |

#### GPU管理 API (管理者)

| Method | Endpoint | 説明 |
|--------|----------|------|
| GET | /api/admin/gpus | GPU状態一覧 |
| GET | /api/admin/gpus/:id | GPU詳細 |
| PUT | /api/admin/gpus/:id/maintenance | メンテナンスモード |
| GET | /api/admin/storage | SeaweedFS/アーカイバー状態 |

#### WebSocket イベント

| イベント | 方向 | 説明 |
|---------|------|------|
| job:progress | Server→Client | レンダリング進捗 (%) |
| job:frame | Server→Client | 現在フレーム番号 |
| job:completed | Server→Client | 完了通知 |
| job:failed | Server→Client | エラー通知 |
| gpu:status | Server→Client | GPU温度/使用率 |

### 8.5 データベース設計（PostgreSQL）

```sql
-- ユーザー
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    role TEXT DEFAULT 'user',       -- 'user' | 'admin'
    stripe_customer_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ジョブ
CREATE TABLE render_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    status TEXT DEFAULT 'pending',
    -- pending→queued→downloading→rendering→uploading→completed|failed
    input_s3_key TEXT NOT NULL,
    output_s3_key TEXT,
    render_engine TEXT DEFAULT 'blender',
    render_settings JSONB,
    gpu_count INTEGER DEFAULT 1,
    assigned_gpus INTEGER[],
    progress INTEGER DEFAULT 0,      -- 0-100%
    current_frame INTEGER,
    total_frames INTEGER,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    duration_seconds INTEGER,
    cost_yen DECIMAL(10,2),
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- GPU状態ログ (時系列)
CREATE TABLE gpu_metrics (
    id BIGSERIAL PRIMARY KEY,
    gpu_index INTEGER NOT NULL,
    gpu_name TEXT,
    utilization INTEGER,     -- %
    memory_used INTEGER,     -- MB
    memory_total INTEGER,    -- MB
    temperature INTEGER,     -- ℃
    power_draw REAL,         -- W
    job_id UUID REFERENCES render_jobs(id),
    recorded_at TIMESTAMPTZ DEFAULT NOW()
);

-- ストレージ使用量ログ
CREATE TABLE storage_metrics (
    id BIGSERIAL PRIMARY KEY,
    seaweedfs_used_gb REAL,
    seaweedfs_total_gb REAL,
    archive_used_tb REAL,
    archive_total_tb REAL,
    s3_used_gb REAL,
    recorded_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 9. Phase 5: 監視・運用システム

> 📋 **方針**: 監視システムは **Zabbix** を使用します。Prometheus / Grafana は使用しません。

### 9.1 Zabbix 監視システム

#### 監視対象

| 監視対象 | 監視内容 | 方法 |
|---------|---------|------|
| GPU サーバー | CPU/RAM/Disk/Network/GPU温度・使用率 | Zabbix Agent |
| QNAP NAS × 4台 | Disk使用量・温度・NIC帯域 | SNMP / Zabbix Agent |
| アーカイバーサーバー × 4台 | Disk使用量・温度・NIC帯域 | Zabbix Agent |
| 10Gbps ファイアウォール | 死活・帯域・セッション数 | SNMP |
| 10Gbps スイッチ × 2台 | 死活・帯域・エラー率 | SNMP |
| 1Gbps 管理スイッチ | 死活 | SNMP |
| AWS S3 | 転送量・エラー率 | CloudWatch (参照のみ) |
| SeaweedFS クラスター | FS状態・容量 | Zabbix Agent |

#### アラート設定

```
【Zabbix アラート】
├─ GPU温度 > 85℃ → 警告
├─ GPU温度 > 90℃ → 緊急（自動シャットダウン）
├─ QNAP / アーカイバー Disk使用量 > 80% → 警告
├─ SeaweedFS Volume使用量 > 80% → 警告
├─ ネットワーク機器 死活異常 → 即時通知
└─ サービスダウン → 即時通知 (メール / Slack)
```

### 9.2 Zabbix セットアップ チェックリスト

```
□ Step 9.1: Zabbix Server インストール (管理ネットワーク上)
□ Step 9.2: 全サーバーへ Zabbix Agent インストール
□ Step 9.3: QNAP × 4台 SNMP 監視設定
□ Step 9.4: ファイアウォール・スイッチ 死活監視設定
□ Step 9.5: アーカイバーサーバー × 4台 監視設定
□ Step 9.6: GPU 温度・使用率アラート設定
□ Step 9.7: ストレージ使用量アラート設定
□ Step 9.8: 通知設定 (メール / Slack)
```

---

## 10. Phase 6: セキュリティ強化・外部公開

### 10.1 セキュリティ対策チェックリスト

```
【ネットワーク層】
□ 10.1: ファイアウォール ACL 最小権限設定
□ 10.2: DDoS対策 (Cloudflare WAF)
□ 10.3: IDS/IPS 設定 (Snort or Suricata)
□ 10.4: VPN (管理者アクセス用) 設定

【アプリケーション層】
□ 10.5: HTTPS 強制 (TLS 1.3)
□ 10.6: JWT トークン有効期限・リフレッシュ
□ 10.7: Rate Limiting (APIエンドポイント別)
□ 10.8: ファイルアップロード検証 (拡張子・マジックバイト)
□ 10.9: S3バケット ポリシー (WRITE専用 → 外部からREAD不可)
□ 10.10: 環境変数による機密情報管理 (AWS Secrets Manager)

【データ層】
□ 10.11: PostgreSQL 暗号化 (at-rest)
□ 10.12: S3 バケット暗号化 (SSE-S3 or KMS)
□ 10.13: SeaweedFS 通信暗号化 (TLS)

【運用層】
□ 10.14: 定期バックアップ (PostgreSQL daily dump)
□ 10.15: インシデント対応手順書作成
□ 10.16: 監査ログ 180日保存
```

### 10.2 Cloudflare Tunnel によるゼロトラスト公開

```yaml
# config.yml
tunnel: gpu-render-prod
credentials-file: /root/.cloudflared/gpu-render-prod.json

ingress:
  - hostname: render.example.com
    service: http://localhost:3000
  - hostname: admin.render.example.com
    service: http://localhost:3001
    originRequest:
      access: true  # Cloudflare Access (管理者のみ)
  - service: http_status:404
```

---

## 11. Phase 7: アーカイブ・長期運用

### 11.1 ストレージライフサイクル管理

```
データライフサイクル:

ジョブ完了直後
  └─ SeaweedFS (ホット) : /jobs/{jobId}/
       │ 7日後自動移動
       ▼
アーカイバーサーバー (ウォーム) : /archive/{YYYY}/{MM}/{jobId}/
       │ 90日後自動移動
       ▼
S3 Glacier (コールド) : s3://gpu-render-archive/...
       │ 1年後
       ▼
S3 Glacier Deep Archive (アーカイブ)
```

### 11.2 自動アーカイブスクリプト

```bash
#!/bin/bash
# /opt/scripts/auto_archive.sh
# 7日以上経過したジョブをSeaweedFSからアーカイバーへ移動

DAYS=7
SRC="/mnt/seaweedfs/jobs/"
DEST="/mnt/archive/"

find ${SRC} -maxdepth 1 -type d -mtime +${DAYS} | while read JOB_DIR; do
    JOB_ID=$(basename ${JOB_DIR})
    rsync -av --remove-source-files \
      "${JOB_DIR}/" \
      "${DEST}/$(date +%Y/%m)/${JOB_ID}/"
    echo "Archived: ${JOB_ID}"
done
```

---

## 12. 工数見積もり（インフラ + アプリ + 運用）

### 12.1 フェーズ別工数

| # | フェーズ | 工数(人時) | 人月 | 担当 |
|---|---------|-----------|------|------|
| 0 | 検証・選定（完了） | 160h | 1.0 | エンジニアA・B |
| 1 | インフラ基盤構築 | 200h | 1.25 | エンジニアA・インフラSE |
| 2 | データパイプライン | 120h | 0.75 | 開発者A |
| 3 | レンダリングエンジン | 160h | 1.0 | 開発者A |
| 4 | Webプラットフォーム | 200h | 1.25 | 開発者A+B |
| 5 | 監視・運用システム | 80h | 0.5 | インフラSE |
| 6 | セキュリティ・外部公開 | 60h | 0.375 | 全員 |
| 7 | アーカイブ・自動化 | 40h | 0.25 | インフラSE |
| - | テスト・調整・ドキュメント | 100h | 0.625 | 全員 |
| **合計** | | **1,120h** | **7.0人月** | |

### 12.2 現体制でのスケジュール（2名体制）

```
2026年3月 ─────────────────────────────────────────────
 Week 1-2  : Phase 1 前半 (ネットワーク/QNAP設定)
 Week 3-4  : Phase 1 後半 (SeaweedFS本番/GPUサーバーOS)

2026年4月 ─────────────────────────────────────────────
 Week 5-6  : Phase 2 (S3↔データセンター同期/ジョブキュー)
 Week 7-8  : Phase 3 前半 (レンダリングエンジン基礎)

2026年5月 ─────────────────────────────────────────────
 Week 9-10 : Phase 3 後半 (GPU割当/分散レンダリング)
 Week 11-12: Phase 4 前半 (Web UI/ジョブ投入画面)

2026年6月 ─────────────────────────────────────────────
 Week 13-14: Phase 4 後半 (管理画面/監視ダッシュボード)
 Week 15   : Phase 5 (Zabbix監視設定)
 Week 16   : Phase 6 (セキュリティ/Cloudflare)

2026年7月 ─────────────────────────────────────────────
 Week 17   : Phase 7 (アーカイブ自動化)
 Week 18-20: 全体テスト・負荷試験・本番稼働準備
 Week 21   : 本番稼働 🚀
```

### 12.3 マイルストーン

| # | マイルストーン | 完了条件 | 目標期日 |
|---|-------------|---------|---------|
| M0 | 技術選定完了 | SeaweedFS採用決定・構成確定 | 完了✅ |
| M1 | インフラ基盤完成 | ネットワーク/QNAP/SeaweedFS動作確認 | 2026/03/31 |
| M2 | パイプライン完成 | S3→SeaweedFS→GPU自動連携確認 | 2026/04/30 |
| M3 | レンダリングα版 | Blenderジョブ実行・GPU分散動作 | 2026/05/31 |
| M4 | Web UIα版 | ジョブ投入〜結果DLフロー動作 | 2026/06/30 |
| M5 | 監視・セキュリティ完成 | Zabbix監視/アラート/外部公開準備 | 2026/07/15 |
| M6 | 本番リリース🚀 | 全機能テスト完了・負荷試験OK | 2026/07/31 |

---

## 13. 担当分業 (現体制)

| 担当 | 現状の担当範囲 | 推奨追加担当 |
|------|-------------|------------|
| **エンジニアA** | ①S3/AWS連携・帯域検証, ③システム構成検討 | Phase1インフラ全般（ネットワーク・QNAP）、Phase6外部公開 |
| **エンジニアB** | ②SeaweedFS検証・本番構築 | Phase2パイプライン、Phase5監視 |
| **追加SEが必要** | - | Phase3レンダリングエンジン、Phase4 Web開発 |

> **推奨**: Phase3〜4の開発は高度な知識（GPU/CUDA制御、Webフルスタック、S3大容量転送）が必要なため、  
> フルスタックエンジニア 1〜2名の追加参画を推奨します。

---

## 14. リスクと対策

| リスク | 影響度 | 確率 | 追加工数 | 対策 |
|--------|--------|------|---------|------|
| NURO 10Gbps回線 開通遅延 | 高 | 中 | +2週 | 暫定1Gbps回線で並行開発 |
| SeaweedFS 本番性能不足 | 中 | 低 | +40h | ZFS+直接マウントへフォールバック |
| GPU Server OS 互換性問題 | 中 | 低 | +16h | Ubuntu 22.04 LTS (実績版)に統一 |
| S3転送コスト超過 | 低 | 中 | - | 転送量上限アラート・圧縮転送 |
| A6000ドライバー不安定 | 中 | 低 | +24h | ドライバーバージョン固定・検証環境先行 |
| アーカイバーHDD故障 | 高 | 低 | +8h | RAIDZ2 + オフサイトS3バックアップ |
| **gpu-sv-007 再故障** | 中 | 中 | +8h | 予備HDD常備・Zabbix死活監視強化 |

---

## 15. 次のアクションアイテム（2026年3月）

### 今週中
```
□ [ エンジニアA ] AWSアカウント設定完了 → S3マルチパートアップロード検証実施
□ [ エンジニアA ] NURO 10Gbps回線 申し込み状況確認・開通日確定
□ [ エンジニアB ] SeaweedFS 検証環境での書込み/読出し性能測定
           - 目標: Write ≥ 500MB/s, Read ≥ 1GB/s  
□ [ エンジニアB ] SeaweedFS フェイルオーバーテスト (Master1ダウン→自動切替)
□ [ 全員 ] 本ドキュメントレビュー → フェーズ1詳細設計書作成
```

### 3月中
```
□ [ エンジニアA ] QNAP NAS 2台 10Gbps ネットワーク接続設定
□ [ エンジニアA ] ファイアウォール VLAN設計・設定投入
□ [ エンジニアB ] SeaweedFS 本番環境 QNAP上への移行
□ [ 開発 ] ジョブキューシステム (Redis + BullMQ) プロトタイプ作成
□ [ 全員 ] システム構成図 最終確定・合意
```

---

## 16. 参考資料・リンク集

| 資料 | URL |
|------|-----|
| SeaweedFS 公式 | https://seaweedfs.com/ |
| SeaweedFS GitHub | https://github.com/seaweedfs/seaweedfs |
| AWS S3 マルチパートアップロード | https://docs.aws.amazon.com/s3/latest/userguide/mpuoverview.html |
| s5cmd (高速S3クライアント) | https://github.com/peak/s5cmd |
| NVIDIA A6000 データシート | https://www.nvidia.com/en-us/design-visualization/rtx-a6000/ |
| Blender CLI レンダリング | https://docs.blender.org/manual/en/latest/advanced/command_line/ |
| rclone S3設定 | https://rclone.org/s3/ |
| BullMQ (Jobキュー) | https://bullmq.io/ |
| Grafana + Prometheus | https://grafana.com/docs/grafana/latest/ |
| Cloudflare Tunnel | https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/ |

---

> 📝 **更新履歴**  
> 2026-03-01 v1.0 初版作成 (週次報告・2/2〜2/23の進捗を反映)  
> 2026-03-02 v1.1 指摘事項反映 (QNAP4台対応・監視Zabbix統一・未決定項目の明記・SeaweedFS検証→本番2ステップ化・ネットワーク/QNAP手順を未確定に変更)  
> 2026-03-02 v1.2 構成明確化: SeaweedFS分散ストレージをHDDサーバー 4台で実施、QNAP 4台はNVMeホットキャッシュ/バッファとして役割分担を明記

