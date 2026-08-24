@echo off
title LTX Watch Studio
cd /d "%~dp0"
start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://localhost:3001'"
npm run dev:studio
pause
