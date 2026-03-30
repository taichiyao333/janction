@echo off
chcp 65001 > nul
title GPU Rental - Server Restart

echo.
echo ╔══════════════════════════════════════════════╗
echo ║  GPU Rental Platform - サーバー再起動        ║
echo ╚══════════════════════════════════════════════╝
echo.
echo [1/3] 旧サーバープロセスを終了中...
taskkill /F /IM node.exe /T 2>nul
timeout /t 2 /nobreak > nul

echo [2/3] ポート3000の解放確認...
timeout /t 2 /nobreak > nul

echo [3/3] 新サーバーを起動中...
echo.
node server/index.js
