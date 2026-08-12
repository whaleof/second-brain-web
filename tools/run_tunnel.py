#!/usr/bin/env python3
"""启动 cloudflared Quick Tunnel，捕获 URL 并写入 .sync/tunnel_url.txt，保持进程运行。"""
import os, re, subprocess, sys, time

WEBROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SYNC_DIR = os.path.join(WEBROOT, '.sync')
LOG_FILE = os.path.join(SYNC_DIR, 'cloudflared.log')
URL_FILE = os.path.join(SYNC_DIR, 'tunnel_url.txt')

def main():
    os.makedirs(SYNC_DIR, exist_ok=True)
    cf = os.path.join(WEBROOT, 'tools', 'cloudflared.exe')
    if not os.path.exists(cf):
        print('[隧道] 未找到 cloudflared.exe')
        return 1
    with open(LOG_FILE, 'w', encoding='utf-8') as logf:
        proc = subprocess.Popen(
            [cf, 'tunnel', '--url', 'http://localhost:8080'],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1
        )
        print(f'[隧道] 启动 cloudflared PID={proc.pid}', file=sys.stderr)
        url = None
        for line in proc.stdout:
            logf.write(line)
            logf.flush()
            print(line, end='')
            m = re.search(r'https://[a-z0-9-]+\.trycloudflare\.com', line)
            if m and not url:
                url = m.group(0)
                with open(URL_FILE, 'w', encoding='utf-8') as f:
                    f.write(url)
                print(f'[隧道] URL 已写入 {URL_FILE}: {url}', file=sys.stderr)
        proc.wait()
    return 0

if __name__ == '__main__':
    sys.exit(main())
