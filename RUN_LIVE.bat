@echo off
title NIFTY Institutional Quant Engine - LIVE
cd /d "%~dp0"

echo ============================================================
echo   Starting Institutional Quant Engine Live Bridge...
echo ============================================================

:: Start browser after 2 seconds in parallel
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000"

:: Run Node Server
node server.js

pause
