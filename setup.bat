@echo off
chcp 65001 > nul
title Janction Agent Server - Setup

echo.
echo ╔══════════════════════════════════════════════════════╗
echo ║        GPU RENTAL SERVER - SETUP                    ║
echo ╚══════════════════════════════════════════════════════╝
echo.

:: ─── Step 1: Check Node.js ────────────────────────────────────────
echo [STEP 1] Node.js チェック...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [INFO] Node.js が見つかりません。インストールしてください。
    echo 公式サイト: https://nodejs.org/
    start https://nodejs.org/
    pause
    exit /b 1
) else (
    for /f "tokens=*" %%i in ('node --version') do echo [OK] Node.js %%i
)

:: ─── Step 2: Check NVIDIA GPU ────────────────────────────────────
echo.
echo [STEP 2] NVIDIA GPU チェック...
where nvidia-smi >nul 2>nul
if %errorlevel% neq 0 (
    echo [WARN] nvidia-smiが見つかりません。GPU監視が制限されます。
) else (
    echo [OK] NVIDIA GPU 検出:
    nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
)

:: ─── Step 3: Create data directories ─────────────────────────────
echo.
echo [STEP 3] データ保存フォルダ作成...
if not exist "C:\janction-main\data\db" (
    mkdir "C:\janction-main\data\db" 2>nul
    echo [OK] C:\janction-main\data\db を作成しました
) else (
    echo [OK] C:\janction-main\data\db が存在します
)
if not exist "C:\janction-main\data\users" (
    mkdir "C:\janction-main\data\users" 2>nul
    echo [OK] C:\janction-main\data\users を作成しました
) else (
    echo [OK] C:\janction-main\data\users が存在します
)

:: ─── Step 4: Create .env if not exists ───────────────────────────
echo.
echo [STEP 4] 設定ファイル (.env) チェック...
if not exist ".env" (
    if exist ".env.example" (
        copy .env.example .env >nul
        echo [OK] .env.example から .env を作成しました
    ) else (
        echo [WARN] .env.example が見つかりません
    )
) else (
    echo [OK] .env が存在します
)

:: ─── Step 5: npm install ──────────────────────────────────────────
echo.
echo [STEP 5] 依存パッケージのインストール...
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

:: ─── Done ─────────────────────────────────────────────────────────
echo.
echo ══════════════════════════════════════════════════════
echo   セットアップ完了！
echo   次のコマンドでサーバーを起動してください:
echo   npm start
echo ══════════════════════════════════════════════════════
echo.
pause