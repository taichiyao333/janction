@echo off
chcp 65001 > nul
title GPU Rental - Cloudflare Tunnel

echo.
echo ╔══════════════════════════════════════════════════════╗
echo ║         GPU RENTAL - 外部公開 (Cloudflare)          ║
echo ╚══════════════════════════════════════════════════════╝
echo.

:: Check cloudflared
where cloudflared >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] cloudflared が見つかりません
    echo setup.bat を先に実行してください
    pause
    exit /b 1
)

echo [INFO] クイックトンネルを起動中...
echo [INFO] 公開URL が割り当てられます（無料・ランダム）
echo.
echo ══════════════════════════════════════════════════════
echo   起動後、表示される https://*.trycloudflare.com の
echo   URLを外部ユーザーに共有してください
echo   管理画面: [URL]/admin/
echo   予約ポータル: [URL]/portal/
echo ══════════════════════════════════════════════════════
echo.

:: Start quick tunnel (no login required)
cloudflared tunnel --url http://localhost:3000

pause
