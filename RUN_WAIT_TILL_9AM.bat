@echo off
title NIFTY Engine - Wait Until 9:00 AM
cd /d "%~dp0"

echo ============================================================
echo   Waiting until 09:00:00 AM to start NIFTY Quant Engine...
echo   (Press Ctrl+C to stop waiting)
echo ============================================================
echo.

node -e "const now = new Date(); const t = new Date(); t.setHours(9,0,0,0); if (now > t) t.setDate(t.getDate()+1); const waitMs = t - now; console.log('Target Time: ' + t.toLocaleString()); console.log('Wait time  : ' + Math.round(waitMs/1000) + ' seconds (' + (waitMs/3600000).toFixed(2) + ' hours)'); setTimeout(() => process.exit(0), waitMs);"

echo.
echo ============================================================
echo [09:00 AM Reached!] Starting NIFTY Live Bridge...
echo ============================================================
call RUN_LIVE.bat
