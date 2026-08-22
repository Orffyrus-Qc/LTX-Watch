@echo off
setlocal
title LTX Watch
cd /d "%~dp0"

if not exist "runtime\node.exe" (
  echo The bundled LTX Watch runtime is missing.
  echo Reinstall LTX Watch and try again.
  pause
  exit /b 1
)

"runtime\node.exe" "scripts\run-installed.mjs"
if errorlevel 1 pause

