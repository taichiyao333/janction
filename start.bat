@echo off
chcp 65001 > nul
title GPU Rental Platform

echo.
echo ╔══════════════════════════════════════════╗
echo ║      GPU RENTAL PLATFORM - STARTING      ║
echo ╚══════════════════════════════════════════╝
echo.

:: Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found!
    echo Please install Node.js from: https://nodejs.org/dist/v24.14.0/node-v24.14.0-x64.msi
    echo.
    pause
    exit /b 1
)

echo [OK] Node.js found:
node --version

:: Check nvidia-smi
where nvidia-smi >nul 2>nul
if %errorlevel% neq 0 (
    echo [WARN] nvidia-smi not found. GPU monitoring will be limited.
) else (
    echo [OK] NVIDIA GPU detected:
    nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
)

echo.

:: Install dependencies if needed
if not exist node_modules (
    echo [INFO] Installing dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed
        pause
        exit /b 1
    )
    echo [OK] Dependencies installed
)

:: Create F:/gpu-rental directories
if not exist "F:\gpu-rental\db" mkdir "F:\gpu-rental\db"
if not exist "F:\gpu-rental\users" mkdir "F:\gpu-rental\users"
if not exist "F:\gpu-rental\shared" mkdir "F:\gpu-rental\shared"
echo [OK] Storage directories ready (F:\gpu-rental\)

echo.
echo ══════════════════════════════════════════
echo   Starting server...
echo   Portal:    http://localhost:3000/portal/
echo   Admin:     http://localhost:3000/admin/
echo ══════════════════════════════════════════
echo.

:: Start the server
node server/index.js

pause
