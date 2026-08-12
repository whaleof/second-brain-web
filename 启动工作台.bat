@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1
cd /d "%~dp0" || (echo [ERROR] cd to script dir failed & pause & exit /b 1)
set "LOG=tools\startup_log.txt"
echo [%date% %time%] START cwd=%cd% >> "%LOG%"

REM Check cloudflared.exe completeness: rely on ACTUAL file size + valid PE header,
REM NOT just the .cf_ok marker (a stale/corrupt marker caused endless re-downloads).
REM NOTE: must use !VAR! (delayed expansion) inside () blocks, else %VAR% is expanded
REM before the for-loop assigns it -> CF_SIZE empty -> always re-downloads.
REM 阈值说明：cloudflared windows-amd64 稳定体积约 36-42MB；download_tunnel.ps1 已做
REM magic-bytes(MZ) 校验确保下到的是真 exe。这里用 25MB 作为"明显完整"下限，既能接受
REM 真实 exe，又能拒绝残缺/HTML 错误页。原 40MB 阈值与 ps1 的 15MB 不一致，导致真实
REM exe(约38MB)在边界附近被误判为不足、反复重新下载——这是"每次都说下好下次又下"的主因。
set "CF_OK=0"
set "CF_SIZE=0"
if exist "tools\cloudflared.exe" (
  for %%A in ("tools\cloudflared.exe") do set "CF_SIZE=%%~zA"
  echo [%date% %time%] cloudflared.exe size=!CF_SIZE! >> "%LOG%"
  if !CF_SIZE! GEQ 25000000 set "CF_OK=1"
)
echo [%date% %time%] CF_OK=!CF_OK! >> "%LOG%"

if "!CF_OK!"=="1" (
  echo ============================================
  echo   cloudflared 已存在 (!CF_SIZE! 字节)，跳过下载，直接启动
  echo   （如果卡在这一步，那是隧道连接慢，不是在下文件）
  echo ============================================
  goto :have_cf
)

if "%CF_OK%"=="0" (
  REM 诊断：若上次下载成功的标记(.cf_ok)还在、但 exe 不见了，说明下好的 exe 被删了。
  REM 最常见原因 = Windows Defender / 第三方杀软把 cloudflared(隧道工具)当威胁隔离。
  if exist "tools\.cf_ok" if not exist "tools\cloudflared.exe" (
    echo ============================================
    echo   [警告] 上次下载成功的 cloudflared.exe 不见了！
    echo   最大嫌疑：Windows Defender 或杀毒软件把它当隧道工具隔离/删除了。
    echo   解决：Windows 安全中心 -> 病毒和威胁防护 -> 允许列表(排除项)，
    echo         把 G:\_06_项目代码\工作台\workspace\tools\cloudflared.exe 加白名单，
    echo         然后重新运行本脚本。否则每次开机都会重新下载。
    echo ============================================
  )
  echo ============================================
  echo   First-time setup: downloading cloudflared
  echo   (~25MB, please wait, do NOT close window)
  echo ============================================
  for /L %%i in (1,1,3) do (
    powershell -ExecutionPolicy Bypass -File tools\download_tunnel.ps1 >> "%LOG%" 2>&1
    if exist "tools\.cf_ok" goto :have_cf
    echo Attempt %%i failed, retrying... >> "%LOG%"
  )
  echo [ERROR] download failed, see tools\startup_log.txt >> "%LOG%"
  echo Download failed. Will start WITHOUT tunnel (localhost only).
  echo Open http://localhost:8080 on this PC. Phone/remote access needs tunnel.
  echo To fix tunnel later, tell WorkBuddy "重新下载 cloudflared".
  goto :no_tunnel
)
:have_cf
echo [%date% %time%] STEP have_cf >> "%LOG%"

echo ============================================
echo   Starting Second Brain (server + tunnel)
echo   Keep this window OPEN. Close = tunnel down.
echo   Wait ~10s for tunnel URL, then you can sync.
echo ============================================

REM Port 8080 check (server.py listens on 8080, NOT 8000)
REM Use findstr to only match local LISTENING sockets, avoiding false positives
REM from remote UDP/TCP connections whose remote endpoint happens to be :8080.
netstat -ano 2>nul | findstr /R /C:"0\.0\.0\.0:8080[ ]*0\.0\.0\.0:0[ ]*LISTENING" /C:"127\.0\.0\.1:8080[ ]*0\.0\.0\.0:0[ ]*LISTENING" /C:"[::]:8080[ ]*\[::\]:0[ ]*LISTENING" >nul
if not errorlevel 1 (
  echo [%date% %time%] [WARN] port 8080 already in use >> "%LOG%"
  REM Probe whether the occupying service is actually our running server
  curl -s --max-time 3 -o nul -w "%%{http_code}" http://localhost:8080 >nul 2>&1
  if not errorlevel 1 (
    echo [INFO] 8080 已被占用，但服务已经在正常运行。
    echo        直接打开 http://localhost:8080 即可，无需重复启动。
    pause
    exit /b 0
  )
  echo [WARN] Port 8080 is in use by an unexpected process! A previous server may not have exited.
  echo        Restart your PC to clear it, then re-run this bat.
  echo        See tools\startup_log.txt for details.
  pause
  exit /b 1
)

echo [%date% %time%] STEP before launch >> "%LOG%"
echo [%date% %time%] LAUNCH server.py --tunnel >> "%LOG%"
"C:\Users\Lenovo\.workbuddy\binaries\python\versions\3.13.12\python.exe" server.py --tunnel >> "%LOG%" 2>&1
echo [%date% %time%] server.py exited with code=%errorlevel% >> "%LOG%"
pause
goto :eof

:no_tunnel
echo [%date% %time%] STEP before launch (no tunnel) >> "%LOG%"
echo [%date% %time%] LAUNCH server.py (localhost only) >> "%LOG%"
"C:\Users\Lenovo\.workbuddy\binaries\python\versions\3.13.12\python.exe" server.py >> "%LOG%" 2>&1
echo [%date% %time%] server.py exited with code=%errorlevel% >> "%LOG%"
pause
