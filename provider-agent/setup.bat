@echo off
chcp 65001 >nul
title GPU Provider Agent - セットアップ

echo.
echo ╔═══════════════════════════════════════════════╗
echo ║   Janction - プロバイダーエージェント Setup   ║
echo ║   あなたのGPUを簡単に貸し出し開始！            ║
echo ╚═══════════════════════════════════════════════╝
echo.

:: Check for Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Node.js がインストールされていません。
    echo    https://nodejs.org/ からインストールしてください。
    echo.
    pause
    exit /b 1
)

:: Check for nvidia-smi
where nvidia-smi >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ NVIDIA GPU ドライバーが検出されません。
    echo    https://www.nvidia.com/drivers/ から最新ドライバーをインストールしてください。
    echo.
    pause
    exit /b 1
)

echo ✅ Node.js 検出
echo ✅ NVIDIA ドライバー検出
echo.

:: Show GPU info
echo ── 検出されたGPU ──────────────────────────────
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
echo ───────────────────────────────────────────────
echo.

:: Get email
set /p EMAIL="Janction アカウントのメールアドレスを入力: "
if "%EMAIL%"=="" (
    echo ❌ メールアドレスが入力されていません。
    pause
    exit /b 1
)

:: Install dependencies
echo.
echo 📦 依存パッケージをインストール中...
cd /d "%~dp0"
call npm install --production >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ パッケージのインストールに失敗しました。
    pause
    exit /b 1
)
echo ✅ インストール完了

:: Create config
echo.
echo 📝 設定ファイルを作成中...
echo {"platformUrl":"https://janction.net","email":"%EMAIL%","sshHost":"127.0.0.1","sshPort":22} > config.json
echo ✅ config.json 作成完了

:: Setup SSH (OpenSSH Server)
echo.
echo 🔐 SSHサーバーをセットアップ中...
echo    (管理者権限のダイアログが表示される場合があります)
powershell -ExecutionPolicy Bypass -File "%~dp0scripts\setup-ssh.ps1" 2>nul
if %errorlevel% neq 0 (
    echo ⚠️  SSHサーバーの自動セットアップに失敗しました。
    echo    手動でSSHのセットアップが必要な場合があります。
)

:: Start agent
echo.
echo ╔═══════════════════════════════════════════════╗
echo ║   🚀 エージェントを起動します！               ║
echo ╚═══════════════════════════════════════════════╝
echo.
echo Ctrl+C で停止できます。
echo ログは agent.log に保存されます。
echo.

node index.js 2>&1 | tee agent.log
pause
