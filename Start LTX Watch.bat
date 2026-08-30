@echo off
title LTX Watch Studio
cd /d "%~dp0"

set LTX_WATCH_API_PORT=4312
set LTX_WATCH_SITE_PORT=3001
set NEXT_PUBLIC_LTX_WATCH_API=http://127.0.0.1:4312

echo Starting LTX Watch...
echo   UI     http://localhost:3001
echo   Bridge http://127.0.0.1:4312
echo.

start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://localhost:3001'"
node scripts\run-studio.mjs
if errorlevel 1 (
  echo.
  echo LTX Watch failed to start. The local bridge must be running for pause, queue, and live status.
  pause
  exit /b 1
)
pause
