@echo off
chcp 65001 >nul
title AI Anime Studio 3D - Build EXE
cd /d "%~dp0"

echo =========================================
echo   AI Anime Studio 3D - EXE Builder
echo =========================================
echo.

set "PYCMD=venv\Scripts\python.exe"
if not exist "%PYCMD%" set "PYCMD=python"

echo [1/2] Installing PyInstaller (skip if ready)...
%PYCMD% -m pip install -q pyinstaller
if errorlevel 1 (
    echo [ERROR] PyInstaller install failed. Check network / pip config.
    pause
    exit /b 1
)

echo [2/2] Building single-file EXE (2-5 min)...
%PYCMD% -m PyInstaller --noconfirm --onefile --console ^
  --name "AI-Anime-Studio-3D" ^
  --add-data "static\index.html;static" ^
  --add-data "static\director3d.js;static" ^
  --add-data "static\vendor;static\vendor" ^
  --add-data "static\style-previews;static\style-previews" ^
  run_app.py
if errorlevel 1 (
    echo [ERROR] Build failed. Scroll up for the error message.
    pause
    exit /b 1
)

echo.
echo =========================================
echo   Build OK: dist\AI-Anime-Studio-3D.exe
echo   Double-click to run. .env must sit
echo   next to the exe (copy it there).
echo =========================================
pause
