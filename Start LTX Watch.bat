@echo off
cd /d "%~dp0"
wscript.exe //nologo "%~dp0scripts\start-hidden.vbs"
exit /b 0
