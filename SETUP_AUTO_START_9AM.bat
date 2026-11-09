@echo off
title Setup NIFTY Engine 9:00 AM Auto-Start
cd /d "%~dp0"

set "TARGET_BAT=%~dp0RUN_LIVE.bat"
echo Target: "%TARGET_BAT%"
echo.
echo Setting up Windows Scheduled Task for 9:00 AM (Monday to Friday)...

schtasks /create /tn "NIFTY_Quant_Engine_9AM" /tr "\"%TARGET_BAT%\"" /sc WEEKLY /d MON,TUE,WED,THU,FRI /st 09:00 /f

if %ERRORLEVEL% EQU 0 (
    echo.
    echo =====================================================================
    echo [SUCCESS] Auto-start schedule set ho gaya hai!
    echo Har Monday se Friday subah 9:00 AM par RUN_LIVE.bat automatically chalega.
    echo =====================================================================
) else (
    echo.
    echo =====================================================================
    echo [ERROR] Task create karne me issue aaya.
    echo Kripya is file par Right Click karke 'Run as Administrator' karein.
    echo =====================================================================
)
