#!/bin/bash
# 把本机 server.py (localhost:8080) 通过 cloudflared 暴露到公网，供「部署版」工作台回连做同步/行情。
# 二进制已随仓库放在 tools/cloudflared.exe（Windows 下由 Git Bash 直接调用）。
#
# 用法：
#   临时（每次重启换地址）：  ./tunnel.sh
#   固定地址（推荐，一次性登录）：先 `tools/cloudflared.exe login`，再 `./tunnel.sh named`
#
# 启动后把终端里出现的 https://xxx.trycloudflare.com 填进「设置 → 后端服务地址」即可。
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CF="$DIR/tools/cloudflared.exe"

if [ ! -f "$CF" ]; then
  echo "未找到 cloudflared，请先下载到 tools/cloudflared.exe"
  exit 1
fi

if [ "$1" = "named" ]; then
  # 固定隧道：需先 cloudflared login 并创建隧道 second-brain
  "$CF" tunnel --name second-brain --url http://localhost:8080 --no-autoupdate
else
  # 快速隧道：地址每次重启都会变，仅临时用
  while true; do
    echo "[$(date)] 启动 cloudflared 快速隧道..."
    "$CF" tunnel --url http://localhost:8080 --no-autoupdate 2>&1 | while read line; do
      echo "$line"
      echo "$line" | grep -q 'trycloudflare.com' && echo "URL: $(echo "$line" | grep -o 'https://[^ ]*trycloudflare\.com')" > /tmp/cf_url.txt
    done
    echo "[$(date)] 隧道断开，5秒后重试..."
    sleep 5
  done
fi
