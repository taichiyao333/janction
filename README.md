# ⚡ janction.net (GPU Rental Platform)

**RTX 4090 / A4500 を個人・企業・第三者に時間貸し（シェア）する次世代GPUクラウドプラットフォーム**

> 余っている自宅やオフィスのGPUを外部に貸し出して自動で報酬を受け取ったり、外出先のノートPCからクラウド上の高性能GPUを1時間単位でレンタルして、BlenderレンダリングやAI開発をサクサク実行できるシステムです。\n\n**🌐 サービスURL**: [https://janction.net](https://janction.net)

---

## ✨ 主な機能

### 1. 👥 ユーザー（借りる人）向け
- **時間単位レンタル**: RTX 4090などの高性能GPUを、1時間あたり数百円から手軽にデプロイ。
- **Web専用ワークスペース**: 予約時間になると専用のDocker Podが立ち上がり、ブラウザ上で操作できる**Webターミナル**や**Code-Server**（ブラウザ版VSCode）が利用可能。
- **ポイント決済・クレジットカード決済**: ポイント制によるわかりやすい課金。クレカ決済機能（Stripe / GMO Epsilon）をフルサポート。
- **Blender専用アドオン (`v2.3.1`)**: Blenderから直接クラウドGPUへ重いレンダリング処理を投げられる「レンダーファーム機能」と、AIエージェントによる外部操作を可能にする「MCPソケットサーバー」を内蔵。

### 2. 🖥️ プロバイダー（貸す人）向け
- **余剰リソースの収益化**: アイドル状態のパソコンをプロバイダーエージェントにつなぐだけでプラットフォームに自動登録され、貸し出された分だけ収益（原則80%）が発生。
- **環境の自動分離**: 貸し出し中は安全なDockerコンテナの中に閉じ込められるため、ホストPCの設定やデータを汚される心配はありません。
- **マイページ**: リアルタイムで稼働状況や累積報酬額を確認可能。

### 3. 🛡️ 管理者（プラットフォーム運営）向け
- **全体管理ダッシュボード**: 売上KPI、GPUマシンの稼働率、エラーの監視を1つの画面で一元管理。
- **稼働状態の可視化**: WebSocketを通じたリアルタイム通信により、ページをリロードすることなく、全国各地にあるGPUサーバーの温度・VRAM空き容量・ジョブ状況を監視できます。

---

## 🏗 アーキテクチャ

```text
┌─────────────────────────────────────────────────────────────────┐
│              インターネット ( https://janction.net )              │
│  Stripe / GMO Epsilon Webhook  ↔  Cloudflare API Gateway         │
└─────────────────────────────────────────────────────────────────┘
                                  │
                    ┌─────────────▼─────────────┐
                    │    Express + Socket.io    │
                    │   Node.js 中央サーバー      │
                    └─┬────────┬────────┬───────┘
                      │        │        │
            ┌─────────▼┐   ┌───▼───┐  ┌─▼─────────┐
            │SQLite DB │   │ GPU   │  │ Scheduler │
            │(Local)   │   │Manager│  │ (Cron)    │
            └──────────┘   └───────┘  └───────────┘
```

### 🛠 技術スタック
- **Backend Core**: Node.js + Express 4 + Socket.io (WebSocketによるリアルタイムUI更新)
- **Database**: SQLite (better-sqlite3)
- **Resource Monitor**: nvidia-smi ポーリング / Docker API
- **Authentication**: JWT (JSON Web Token) + bcrypt
- **Payments**: Stripe Checkout / GMO Epsilon
- **Frontend**: Vanilla HTML/JS + Modern CSS (Tailwind ライクなユーティリティ併用)
- **Infrastructure**: Cloudflare Tunnel（セキュアな外部公開）

---

## 🚀 開発・動作環境の立ち上げ

### 前提条件
- Windows 10/11
- NVIDIA GPU搭載PC (Docker Desktop と WSL2 または Hyper-V が必要)

### 1. セットアップ
```bat
setup.bat
```
パッケージ群のインストール、SQLiteデータベースの初期化とDBマイグレーションを実行します。

### 2. 環境変数の設定 (`.env`)
自動生成された `.env` ファイルに、Stripe APIキーなどの必要な変数を記載してください。

### 3. 起動
```bat
start.bat
```
`http://localhost:3000` でサーバーが起動します。

---

## 🎨 Blender クラウドレンダー・アドオン (v2.3.1)

Janctionでは、Blender内で直接レンダーファームを操作できる専用Pythonアドオンを提供しています。

**主な機能:**
- シーンのバックグラウンド自動アップロード機能（UIをフリーズさせません）
- **クラウドセッション維持（Heartbeat）**: 作業中にGPUセッションが切れないように監視し、Blender内からシームレスに `+1h 延長` が可能。
- クラウドコンテナからレンダリング結果（PNG/MP4など）を直接ダウンロード。

### 🤖 Antigravity / AI 連携機能 (MCP Server内蔵)
アドオンには、ローカル環境のBlenderをAntigravityなどの外部AIエージェントから操作するための **MCP (Message Control Protocol) 風ローカルソケットサーバー** が内蔵されています（ポート `8123`）。
アドオンの設定から有効化するだけで、AIからPythonスクリプトを直接実行させたり、メッシュ情報を引き出したりして全自動のモデリングやレンダリングが可能になります（API制限回避のためのタイマーキュー設計を採用）。

---

## 🗄 データベース構成 (主要テーブル)

- `users`: 一般ユーザー・プロバイダー・管理者のアカウント情報、ポイント・保有残高
- `gpu_nodes`: 提供中のGPUとスペック (Home PC/Enterprise/DataCenter)
- `reservations`: GPUレンタルの時間帯予約データ
- `pods`: 現在立ち上がっている仮想PCセッション・ライフサイクル管理
- `payments`: Stripe等からの入金・ポイント購入履歴

---

## ⚠️ セキュリティについて

- **認証情報**: `.env` の `JWT_SECRET` や `ADMIN_PASSWORD` は本番稼働時に必ず書き換えてください。
- **分離環境**: プロバイダーとして貸し出す場合、`Docker` 環境が適切に設定されていることを確認し、ホストOSとの不要なファイル共有が行われないように構成されています。

---
© 2026 METADATALAB.INC / Janction.jp
