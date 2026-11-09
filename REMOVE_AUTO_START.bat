@echo off
title Remove NIFTY Engine 9:00 AM Auto-Start
cd /d "%~dp0"

echo Removing NIFTY_Quant_Engine_9AM task from Task Scheduler...
schtasks /delete /tn "NIFTY_Quant_Engine_9AM" /f

if %ERRORLEVEL% EQU 0 (
    echo.
    echo =====================================================================
    echo [SUCCESS] Auto-start task successfully remove ho gaya hai!
    echo =====================================================================
) else (
    echo.
    echo [INFO] Task nahi mila ya pehle se removed hai.
)
