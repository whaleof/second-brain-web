@echo off
cd /d "%~dp0"
echo Starting cloudflared tunnel -> http://localhost:8080
echo Wait for the line: Your quick Tunnel has been assigned this URL: https://xxx.trycloudflare.com
echo Copy that https URL into the workbench Settings -> Backend URL, then click Sync Now.
echo (Keep this window open; closing it stops the tunnel)
cloudflared.exe tunnel --url http://localhost:8080
pause
