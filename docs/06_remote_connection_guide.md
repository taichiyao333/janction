## 🖥 自分のエディターでGPUを使う方法（接続ガイド）

GPU Rentalは**ブラウザ端末**に加え、以下の方法で自分のエディターやツールから直接GPUを利用できます。

---

## 接続方法の選択

| 方法 | 難易度 | 対応エディター | 速度 | 特徴 |
|---|---|---|---|---|
| **SSH + VSCode Remote** | ★★☆ | VS Code | 速い | フル機能、ファイル編集、デバッグも可能 |
| **JupyterLab (ブラウザ)** | ★☆☆ | ブラウザ | 中間 | 機械学習・データ分析に最適 |
| **SSH + PyCharm** | ★★★ | PyCharm | 速い | Pythonプロジェクトに最適 |

---

## 方法1: VS Code Remote SSH（推奨）

### 事前準備（1回だけ）

1. **VS Code をインストール**（まだの場合）  
   https://code.visualstudio.com/

2. **「Remote - SSH」拡張機能をインストール**  
   VS Code → 拡張機能 → `Remote - SSH` を検索してインストール

### 接続手順

**Step 1: SSH接続情報を確認する**

ポータルのマイアカウント → マイ予約 → 「接続情報」をクリックして以下を確認：

```
ホスト:     <トンネルドメイン>.trycloudflare.com
ポート:     2222
ユーザー名: gpu-user
パスワード: <表示されるパスワード>
```

**Step 2: SSH設定ファイルを編集する**

`~/.ssh/config` に以下を追記：

```ssh-config
Host janction
    HostName <トンネルドメイン>.trycloudflare.com
    Port 2222
    User gpu-user
    ProxyCommand cloudflared access ssh --hostname %h
```

**Step 3: VSCodeから接続する**

1. `Ctrl+Shift+P` → `Remote-SSH: Connect to Host`
2. `janction` を選択
3. パスワードを入力
4. ✅ リモートGPUマシンに接続完了！

**Step 4: 作業フォルダを開く**

接続後、`/workspace` フォルダを開くとGPU作業環境が使えます：

```
ファイル → フォルダを開く → /workspace
```

**Step 5: PythonとCUDAを使う**

ターミナルで確認：
```bash
python -c "import torch; print(torch.cuda.get_device_name(0))"
# → NVIDIA RTX A4500
nvidia-smi
```

---

## 方法2: JupyterLab（機械学習・データ分析向け）

### 接続手順

**Step 1: ワークスペースのブラウザ端末を開く**

ポータル → 予約 → 「今すぐ開始」→「ワークスペースを開く」

**Step 2: JupyterLabを起動する**

ブラウザ端末で以下を実行：

```bash
pip install jupyterlab -q
jupyter lab --ip=0.0.0.0 --port=8888 --no-browser --NotebookApp.token='your-token'
```

**Step 3: ブラウザでJupyterLabにアクセス**

```
http://localhost:8888/?token=your-token
```

> ⚠️ 現在のトンネル設定ではポート8888は直接公開されていません。  
> ブラウザ端末を使ってJupyterのURLをコピーしてアクセスしてください。

---

## 方法3: PyCharm Remote Interpreter

### 接続手順

**Step 1: PyCharmでSSH接続設定**

1. `File` → `Settings` → `Project` → `Python Interpreter`
2. `Add` → `SSH Interpreter`
3. HOST / PORT / USER を入力

**Step 2: リモートワークスペースを同期**

`Tools` → `Deployment` → `Configuration` でワークスペースパスを設定

---

## 現在の接続情報（利用中のPod）

SSH接続に必要な情報は、ワークスペース画面の **「接続情報」タブ** で確認できます：

```
SSH ホスト:  (Cloudflare SSH トンネル起動後に表示)
SSH ポート:  2222
ユーザー名:  gpu-user-<ユーザーID>
作業ディレクトリ: /workspace
```

---

## ⚠️ 重要な注意事項

- **セッション時間**: 予約した時間を過ぎると自動切断されます（10分前に警告メール送信）
- **データ保存**: `/workspace` 内のファイルはセッション終了後も**一定期間保持**されますが、必ず大切なファイルはローカルにダウンロードしてください
- **GPU使用**: CUDAは直接利用可能。最初から `torch`, `tensorflow` 等がインストールされています
