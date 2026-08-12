@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title Workspace Server localhost:8080
echo ===================================================
echo   Workspace Local Server (no tunnel)
echo   Open: http://localhost:8080
echo   Close this window to stop server
echo ===================================================
echo.
"C:\Users\Lenovo\.workbuddy\binaries\python\versions\3.13.12\python.exe" server.py
echo.
echo [Server stopped] Press any key to close
pause >nul
