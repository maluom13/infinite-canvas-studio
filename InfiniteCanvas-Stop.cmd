@echo off
rem Stop Infinite Canvas: local agent + web
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "D:\CodexOutputs\infinite-canvas\Stop-InfiniteCanvas.ps1"
if errorlevel 1 pause
