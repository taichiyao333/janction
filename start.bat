@echo off
chcp 65001 > nul
title GPU Rental Platform - Launcher

echo.
echo ╔══════════════════════════════════════════════════════╗
echo ║         GPU RENTAL PLATFORM v1.0                    ║
echo ║         RTX A4500 Home GPU Rental                   ║
echo ╚══════════════════════════════════════════════════════╝
echo.

:: Check setup
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [WARN] Node.js が未インストールです。setup.bat を実行してください。
    echo.
    choice /c YN /m "今すぐ setup.bat を実行しますか？"
    if errorlevel 2 goto :eof
    call setup.bat
    exit /b
)

if not exist node_modules (
    echo [WARN] node_modules がありません。setup.bat を実行してください。
    choice /c YN /m "今すぐ setup.bat を実行しますか？"
    if errorlevel 2 goto :eof
    call setup.bat
    exit /b
)

:: ─── メニュー ────────────────────────────────────────────────────
echo   [1] サーバーのみ起動
echo   [2] サーバー + Cloudflare Tunnel (外部公開) 起動
echo   [3] セットアップ実行
echo   [4] 終了
echo.
choice /c 1234 /m "選択してください: "

if errorlevel 4 goto :eof
if errorlevel 3 call setup.bat&& goto :eof
if errorlevel 2 goto :start_with_tunnel
if errorlevel 1 goto :start_server

:start_server
echo.
echo [INFO] サーバーを起動中...
echo.
node server/index.js
goto :eof

:start_with_tunnel
echo.
echo [INFO] サーバーとCloudflare Tunnelを起動中...
echo.
:: Start server in background
start "GPU Rental Server" cmd /k "node server/index.js"
timeout /t 3 /nobreak > nul
:: Start tunnel
echo.
echo ══════════════════════════════════════════════════════
echo  サーバー起動完了。Tunnel を開始します...
echo  表示されたURLを外部ユーザーに共有してください
echo ══════════════════════════════════════════════════════
echo.
cloudflared tunnel --url http://localhost:3000
goto :eof
