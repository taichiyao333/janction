@echo off
chcp 65001 > nul
title GPU Rental Platform - Setup

echo.
echo ╔══════════════════════════════════════════════════════╗
echo ║         GPU RENTAL PLATFORM - FULL SETUP            ║
echo ╚══════════════════════════════════════════════════════╝
echo.

:: ─── Step 1: Check/Install Node.js ──────────────────────────────
echo [STEP 1] Node.js チェック...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [INFO] Node.js が見つかりません。自動ダウンロード中...
    
    :: Download Node.js installer
    set NODE_URL=https://nodejs.org/dist/v24.14.0/node-v24.14.0-x64.msi
    set NODE_MSI=%TEMP%\node-installer.msi
    
    echo [INFO] ダウンロード中: %NODE_URL%
    powershell -Command "Invoke-WebRequest -Uri '%NODE_URL%' -OutFile '%NODE_MSI%' -UseBasicParsing"
    
    if exist "%NODE_MSI%" (
        echo [INFO] Node.js をインストール中... (管理者権限が必要な場合があります)
        msiexec /i "%NODE_MSI%" /quiet /norestart ADDLOCAL=ALL
        echo [OK] Node.js インストール完了
        del "%NODE_MSI%"
        :: Refresh PATH
        call RefreshEnv.cmd 2>nul
        setx PATH "%PATH%;%ProgramFiles%\nodejs" >nul 2>nul
    ) else (
        echo [ERROR] ダウンロードに失敗しました
        echo 手動でインストールしてください:
        echo https://nodejs.org/dist/v24.14.0/node-v24.14.0-x64.msi
        pause
        exit /b 1
    )
) else (
    for /f "tokens=*" %%i in ('node --version') do echo [OK] Node.js %%i
)

:: ─── Step 2: Check NVIDIA GPU ───────────────────────────────────
echo.
echo [STEP 2] NVIDIA GPU チェック...
where nvidia-smi >nul 2>nul
if %errorlevel% neq 0 (
    echo [WARN] nvidia-smi が見つかりません（GPU監視が制限されます）
) else (
    echo [OK] NVIDIA GPU 検出:
    nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
)

:: ─── Step 3: Create F: Storage Directories ──────────────────────
echo.
echo [STEP 3] F:ドライブ ストレージ作成...
if not exist "F:\gpu-rental" (
    mkdir "F:\gpu-rental" 2>nul
    if %errorlevel% neq 0 (
        echo [WARN] F:ドライブへのアクセスに失敗。ローカルフォルダを使用します...
        set STORAGE=C:\gpu-rental
        mkdir "C:\gpu-rental\db" 2>nul
        mkdir "C:\gpu-rental\users" 2>nul
        mkdir "C:\gpu-rental\shared" 2>nul
        :: Update .env to use C: drive
        powershell -Command "(Get-Content .env) -replace 'F:/gpu-rental', 'C:/gpu-rental' | Set-Content .env"
        echo [OK] C:\gpu-rental を作成しました
    ) else (
        mkdir "F:\gpu-rental\db" 2>nul
        mkdir "F:\gpu-rental\users" 2>nul
        mkdir "F:\gpu-rental\shared" 2>nul
        echo [OK] F:\gpu-rental を作成しました
    )
) else (
    mkdir "F:\gpu-rental\db" 2>nul
    mkdir "F:\gpu-rental\users" 2>nul
    mkdir "F:\gpu-rental\shared" 2>nul
    echo [OK] F:\gpu-rental が存在します
)

:: ─── Step 4: npm install ────────────────────────────────────────
echo.
echo [STEP 4] 依存パッケージのインストール...
if not exist node_modules (
    echo [INFO] npm install 実行中... (数分かかる場合があります)
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install に失敗しました
        pause
        exit /b 1
    )
    echo [OK] パッケージインストール完了
) else (
    echo [OK] node_modules が存在します (スキップ)
)

:: ─── Step 5: Check/Install Cloudflare tunnel ────────────────────
echo.
echo [STEP 5] Cloudflare Tunnel チェック...
where cloudflared >nul 2>nul
if %errorlevel% neq 0 (
    echo [INFO] cloudflared をインストール中...
    set CF_URL=https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.msi
    set CF_MSI=%TEMP%\cloudflared.msi
    powershell -Command "Invoke-WebRequest -Uri '%CF_URL%' -OutFile '%CF_MSI%' -UseBasicParsing" 2>nul
    if exist "%CF_MSI%" (
        msiexec /i "%CF_MSI%" /quiet /norestart
        del "%CF_MSI%"
        echo [OK] cloudflared インストール完了
    ) else (
        echo [WARN] cloudflared の自動インストールに失敗しました
        echo 手動インストール: https://github.com/cloudflare/cloudflared/releases
    )
) else (
    for /f "tokens=*" %%i in ('cloudflared --version 2^>^&1') do echo [OK] %%i
)

:: ─── Done ───────────────────────────────────────────────────────
echo.
echo ══════════════════════════════════════════════════════
echo   セットアップ完了！
echo   start.bat を実行してサーバーを起動してください
echo ══════════════════════════════════════════════════════
echo.
pause
