@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  Infinite Canvas updater
echo  ----------------------------------------
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1" %*
set EXITCODE=%ERRORLEVEL%
echo.
if "%EXITCODE%"=="0" (
  echo  Done. Check the summary above.
) else (
  echo  Stopped with issues. Read the summary above before retrying.
)
echo.
pause
