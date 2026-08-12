#!/usr/bin/env python3
"""第二大脑工作台 HTTP 服务器 + 行情代理"""

import http.server
import urllib.parse
import urllib.request
import urllib.error
import json
import base64
import os
import re
import ssl
import uuid
import threading
import subprocess
import sys
from datetime import datetime, timedelta, timezone
import argparse
import atexit
import time

PORT = 8080
WEBROOT = os.path.dirname(os.path.abspath(__file__))
SYNC_DIR = os.path.join(WEBROOT, '.sync')
MASTER_FILE = os.path.join(SYNC_DIR, 'master.json')


def _ts(v):
    """时间戳统一成 int(毫秒)。兼容 int/float、数字字符串、ISO 日期字符串
    (如 '2026-08-08T17:30:11.644039' 会转成对应毫秒戳)；空/非数字文本返回 0。
    用途：同步合并时比较 updatedAt/deletedAt，杜绝 Python `int > str` 抛
    TypeError 导致 /api/sync 返回 500（阻断级 bug #1 的根因）。"""
    if v is None:
        return 0
    if isinstance(v, bool):
        return 0
    if isinstance(v, (int, float)):
        try:
            return int(v)
        except (TypeError, ValueError):
            return 0
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return 0
        # 数字字符串（含小数）
        try:
            return int(float(s))
        except (TypeError, ValueError):
            pass
        # ISO 日期字符串
        for fmt in ('%Y-%m-%dT%H:%M:%S.%f', '%Y-%m-%dT%H:%M:%S',
                    '%Y-%m-%d %H:%M:%S', '%Y-%m-%d'):
            try:
                return int(datetime.strptime(s, fmt).timestamp() * 1000)
            except ValueError:
                continue
        return 0
    return 0

# 抖音链接 → 认知笔记 的异步消化任务表（内存态，单人使用足够）
DIGEST_JOBS = {}
DIGEST_LOCK = threading.Lock()
# 全局串行锁：一次只跑一个转写/分析任务。
# 否则用户连点多次会并发起一堆 whisper 进程抢 CPU，互相拖慢甚至假死，
# 表现为前端一直「进行中」。串行后并发请求进入「排队中」依次处理。
DIGEST_RUN_LOCK = threading.Lock()
# 单条任务硬上限（秒）：超过则强杀子进程，避免卡死永久占锁。
DIGEST_PROC_TIMEOUT = 900

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEBROOT, **kwargs)

    def end_headers(self):
        # 强制不缓存：避免浏览器长期使用旧 JS，导致同步逻辑停留在「增量推送」版本，
        # 从而出现记账/体重/跳舞等旧记录漏推、手机电脑不同步的问题。
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()

    def read_body(self):
        """健壮读取请求体：循环读够 Content-Length 声明的字节数。
        经 cloudflared 等隧道/反向代理转发时，大数据体会被切成多个 TCP 包到达，
        rfile.read(length) 可能短读导致 JSON 截断。这里循环补齐，并对端断连时安全退出。
        """
        try:
            length = int(self.headers.get('Content-Length', 0))
        except (ValueError, TypeError):
            length = 0
        if not length:
            return b''
        chunks = []
        remaining = length
        deadline = time.time() + 120  # 最多等 120s，避免卡死
        try:
            self.connection.settimeout(120)
        except Exception:
            pass
        while remaining > 0:
            try:
                chunk = self.rfile.read(min(remaining, 65536))
            except Exception:
                break
            if not chunk:
                if time.time() > deadline:
                    break
                time.sleep(0.05)
                continue
            chunks.append(chunk)
            remaining -= len(chunk)
        return b''.join(chunks)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        # 行情代理路由
        if parsed.path == '/api/quote':
            self.handle_quote(parsed)
            return
        if parsed.path == '/api/kline':
            self.handle_kline(parsed)
            return
        if parsed.path == '/api/fund':
            self.handle_fund(parsed)
            return
        if parsed.path == '/api/fund/history':
            self.handle_fund_history(parsed)
            return
        if parsed.path == '/api/news':
            self.handle_news(parsed)
            return
        if parsed.path == '/api/sync':
            self.handle_sync(parsed)
            return
        if parsed.path == '/api/backup':
            self.handle_backup(parsed)
            return
        if parsed.path == '/api/aihot':
            self.handle_aihot(parsed)
            return
        if parsed.path == '/api/ai-impact':
            self.handle_ai_impact(parsed)
            return
        if parsed.path == '/api/thoughts':
            self.handle_thoughts(parsed)
            return
        if parsed.path == '/api/digest/status':
            self.handle_digest_status(parsed)
            return
        if parsed.path == '/api/github-weekly':
            self.handle_github_weekly(parsed)
            return
        if parsed.path == '/api/deploy-status':
            self.handle_deploy_status(parsed)
            return

        # 静态文件
        super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/api/sync':
            self.handle_sync(parsed)
            return
        if parsed.path == '/api/backup':
            self.handle_backup(parsed)
            return
        if parsed.path == '/api/digest':
            self.handle_digest_post(parsed)
            return
        if parsed.path == '/api/digest-github':
            self.handle_digest_github(parsed)
            return
        self.send_json({'ok': False, 'error': '方法不支持'}, 405)

    def handle_quote(self, parsed):
        """实时行情代理: /api/quote?code=sh000300"""
        params = urllib.parse.parse_qs(parsed.query)
        code = params.get('code', ['sh000300'])[0]
        url = f'https://qt.gtimg.cn/q={code}'
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': 'Mozilla/5.0',
                'Referer': 'https://gu.qq.com/'
            })
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = resp.read().decode('gbk', errors='replace')
            self.send_json({'data': data})
        except Exception as e:
            self.send_json({'error': str(e)}, 500)

    def handle_kline(self, parsed):
        """K线数据代理: /api/kline?code=sh000300&count=7"""
        params = urllib.parse.parse_qs(parsed.query)
        code = params.get('code', ['sh000300'])[0]
        count = params.get('count', ['7'])[0]
        url = f'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={code},day,,,{count},qfq'
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': 'Mozilla/5.0'
            })
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = resp.read().decode('utf-8', errors='replace')
            self.send_json({'data': data})
        except Exception as e:
            self.send_json({'error': str(e)}, 500)

    def handle_fund(self, parsed):
        """基金净值代理: /api/fund?code=007044"""
        params = urllib.parse.parse_qs(parsed.query)
        code = params.get('code', ['007044'])[0]
        url = f'https://fund.eastmoney.com/{code}.html'
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://fund.eastmoney.com/'
            })
            with urllib.request.urlopen(req, timeout=10) as resp:
                html = resp.read().decode('utf-8', errors='replace')

            # 解析基金数据
            data = {
                'code': code,
                'name': '',
                'nav': '',        # 单位净值
                'accNav': '',     # 累计净值
                'navDate': '',    # 净值日期
                'dayChange': '',  # 日涨幅
                'scale': '',      # 规模
                'manager': '',    # 基金经理
                'startDate': '',  # 成立日
                'star': '',       # 晨星评级
            }

            # 解析净值：从HTML标签中提取
            # 格式1: <span class="fix_date">(07-30)：</span><span class="fix_dwjz">1.7921</span><span class="fix_zzl">-1.29%</span>
            m = re.search(r'class="fix_date">\((\d{2}-\d{2})\).*?class="fix_dwjz[^"]*">(\d+\.\d+)</span>.*?class="fix_zzl[^"]*">(-?\d+\.\d+%)</span>', html, re.DOTALL)
            # 格式2: <span>(2026-07-30)</span>...<span class="ui-num">1.7921</span><span class="ui-num">-1.29%</span>
            if not m:
                m = re.search(r'\((\d{4}-\d{2}-\d{2})\).*?class="ui-num">(\d+\.\d+)</span>.*?class="ui-num">(-?\d+\.\d+%)</span>', html, re.DOTALL)
            if m:
                data['navDate'] = m.group(1)
                data['nav'] = m.group(2)
                data['dayChange'] = m.group(3)

            # 累计净值: <span class="fix_dwjz">1.7921</span> 在累计净值区域
            m = re.search(r'累计净值.*?class="fix_dwjz[^"]*">(\d+\.\d+)</span>', html, re.DOTALL)
            if not m:
                m = re.search(r'累计净值[^<]*</a>.*?<span[^>]*>(\d+\.\d+)</span>', html, re.DOTALL)
            if m: data['accNav'] = m.group(1)

            # 基金名称 - 从title标签
            m = re.search(r'<title>([^(]+)\((\d+)\)', html)
            if m: data['name'] = m.group(1).strip()

            # 规模
            m = re.search(r'规模[^：:]*[：:]\s*([\d.]+亿元)', html)
            if m: data['scale'] = m.group(1)

            # 基金经理
            m = re.search(r'基金经理[^：:]*[：:]\s*<a[^>]*>\s*([^<\s]+)', html)
            if m: data['manager'] = m.group(1).strip()

            # 成立日
            m = re.search(r'成\s*立\s*日[^：:]*[：:]\s*(\d{4}-\d{2}-\d{2})', html)
            if m: data['startDate'] = m.group(1)

            # 晨星评级 - 从"晨星评级"后的星星数
            m = re.search(r'晨星评级.*?(\d{4}-\d{2}-\d{2}).*?★+', html, re.DOTALL)
            if m:
                stars = re.findall(r'★', m.group(0))
                data['star'] = str(len(stars))

            self.send_json(data)
        except Exception as e:
            self.send_json({'error': str(e)}, 500)

    def handle_fund_history(self, parsed):
        """基金历史净值(用于历史分位): /api/fund/history?code=017641&count=120"""
        params = urllib.parse.parse_qs(parsed.query)
        code = params.get('code', ['007044'])[0]
        try:
            count = int(params.get('count', ['120'])[0])
        except ValueError:
            count = 120
        url = f'https://api.fund.eastmoney.com/f10/lsjz?fundCode={code}&pageIndex=1&pageSize={count}'
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'http://fundf10.eastmoney.com/'
            })
            with urllib.request.urlopen(req, timeout=10) as resp:
                json_data = json.loads(resp.read().decode('utf-8', errors='replace'))
            lsjz = (json_data.get('Data') or {}).get('LSJZList', [])
            data = [{
                'date': it.get('FSRQ'),
                'nav': it.get('DWJZ'),
                'accNav': it.get('LJJZ'),
                'changePct': it.get('JZZZL')
            } for it in lsjz]
            self.send_json({'code': code, 'data': data})
        except Exception as e:
            self.send_json({'error': str(e)}, 500)

    def handle_news(self, parsed):
        """新浪新闻热搜代理: /api/news"""
        try:
            url = 'http://api.guiguiya.com/api/hotlist/sina?type=search'
            req = urllib.request.Request(url, headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            })
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = resp.read().decode('utf-8', errors='replace')
            self.send_json(json.loads(data))
        except Exception as e:
            self.send_json({'success': False, 'error': str(e)}, 500)

    def handle_aihot(self, parsed):
        """AI HOT 日报代理: /api/aihot 或 /api/aihot?date=YYYY-MM-DD"""
        params = urllib.parse.parse_qs(parsed.query)
        date = params.get('date', [None])[0]
        if date:
            api_url = f'https://aihot.virxact.com/api/v1/dailies/{date}'
        else:
            api_url = 'https://aihot.virxact.com/api/v1/dailies/latest'
        try:
            req = urllib.request.Request(api_url, headers={
                'User-Agent': 'aihot-skill/1.2.1 (+https://aihot.virxact.com/aihot-skill/)'
            })
            ctx = ssl.create_default_context()
            with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
                data = resp.read().decode('utf-8', errors='replace')
            self.send_json(json.loads(data))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                self.send_json({'error': 'not_found', 'code': 404}, 404)
            else:
                self.send_json({'error': str(e), 'code': e.code}, 500)
        except Exception as e:
            self.send_json({'error': str(e)}, 500)

    def handle_ai_impact(self, parsed):
        """市场影响分析: /api/ai-impact?date=YYYY-MM-DD"""
        import os
        params = urllib.parse.parse_qs(parsed.query)
        date = params.get('date', [None])[0]
        impact_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'aihot-impact.json')
        if not os.path.exists(impact_file):
            self.send_json({'error': '暂无市场影响分析数据'}, 404)
            return
        try:
            with open(impact_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if date and data.get('date') != date:
                self.send_json({'error': f'指定日期 {date} 无分析数据'}, 404)
                return
            self.send_json(data)
        except Exception as e:
            self.send_json({'error': str(e)}, 500)

    def handle_thoughts(self, parsed):
        """随想只读接口: /api/thoughts?date=YYYY-MM-DD
        不带 date 时返回全部日期的条数汇总，便于查看/调试整合链路。
        """
        params = urllib.parse.parse_qs(parsed.query)
        date = params.get('date', [None])[0]
        master = self.load_master()
        dead = set(master.get('tombstones', {}).keys())
        thoughts = master.get('data', {}).get('thoughts', {})
        digests = master.get('data', {}).get('thought_digests', {})

        if not date:
            summary = {}
            for gid, r in thoughts.items():
                if gid in dead:
                    continue
                d = r.get('date')
                if d:
                    summary[d] = summary.get(d, 0) + 1
            done = sorted({r.get('date') for gid, r in digests.items()
                           if gid not in dead and r.get('date')})
            self.send_json({
                'ok': True,
                'dates': [{'date': d, 'count': summary[d], 'digested': d in done}
                          for d in sorted(summary.keys(), reverse=True)]
            })
            return

        items = [r for gid, r in thoughts.items()
                 if gid not in dead and r.get('date') == date]
        items.sort(key=lambda r: r.get('ts') or r.get('createdAt') or 0)
        hits = [r for gid, r in digests.items()
                if gid not in dead and r.get('date') == date]
        hits.sort(key=lambda r: r.get('generatedAt') or 0, reverse=True)
        self.send_json({
            'ok': True,
            'date': date,
            'count': len(items),
            'thoughts': [{'time': r.get('time', ''), 'kind': r.get('kind', 'idea'),
                          'text': r.get('text', '')} for r in items],
            'digest': hits[0] if hits else None
        })

    # ===== 抖音/视频链接 → 认知笔记 异步消化 =====
    def handle_digest_post(self, parsed):
        """POST /api/digest  body: {"url": "https://v.douyin.com/xxx/"}
        后台线程跑 douyin_digest.py（本地 venv + 模型 + .env 密钥），
        立即返回 job_id，客户端轮询 /api/digest/status 取结果。
        """
        try:
            raw = self.read_body() or b'{}'
            payload = json.loads(raw.decode('utf-8'))
            url = (payload.get('url') or '').strip()
            # 清理抖音分享文案附带的追踪文字（如 "https://v.douyin.com/xxx/ :9pm QKj:/ 03/17 I@V.LJ"）
            m = re.search(r'^(https?://\S+)', url)
            if m:
                url = m.group(1).rstrip('.,) \t')
            if not re.match(r'^https?://', url):
                self.send_json({'ok': False, 'error': '请提供有效的 http(s) 链接'}, 400)
                return

            # 清理过期任务（保留最近 2 小时）
            now_ms = int(datetime.now().timestamp() * 1000)
            with DIGEST_LOCK:
                for jid in list(DIGEST_JOBS.keys()):
                    if now_ms - DIGEST_JOBS[jid].get('startedAt', 0) > 2 * 3600 * 1000:
                        DIGEST_JOBS.pop(jid, None)
                job_id = uuid.uuid4().hex
                DIGEST_JOBS[job_id] = {
                    'status': 'running', 'step': '排队中', 'url': url,
                    'result': None, 'error': None, 'startedAt': now_ms
                }
            t = threading.Thread(target=self._run_digest, args=(job_id, url), daemon=True)
            t.start()
            self.send_json({'ok': True, 'job_id': job_id})
        except Exception as e:
            self.send_json({'ok': False, 'error': str(e)}, 500)

    def _run_digest(self, job_id, url):
        # 进锁前先标记「排队中」，让用户看到是在排队而不是卡死
        with DIGEST_LOCK:
            DIGEST_JOBS[job_id]['step'] = '排队中（前面还有消化任务，依次处理）'
        # 全局串行：一次只跑一个转写/分析任务，避免并发抢 CPU 导致假死
        with DIGEST_RUN_LOCK:
            try:
                script = os.environ.get('DOUYIN_DIGEST_SCRIPT') \
                    or os.path.join(WEBROOT, 'tools', 'douyin_digest.py')
                py = os.environ.get('DOUYIN_PYTHON') \
                    or r'C:/Users/Lenovo/.workbuddy/binaries/python/envs/douyin/Scripts/python.exe'
                result_file = os.path.join(WEBROOT, 'digest_result.json')
                if os.path.exists(result_file):
                    try:
                        os.remove(result_file)
                    except OSError:
                        pass
                env = dict(os.environ)
                env['HF_HUB_DISABLE_XET'] = '1'   # 避免沙箱无回收站触发 huggingface 安全删除 fail-closed

                with DIGEST_LOCK:
                    DIGEST_JOBS[job_id]['step'] = '解析链接 → 下载/识别 → 写入认知（约 30-90 秒）'

                run_log = os.path.join(WEBROOT, 'digest_run.log')
                with open(run_log, 'w', encoding='utf-8') as rf:
                    proc = subprocess.Popen(
                        [py, script, '--url', url],
                        cwd=WEBROOT, env=env,
                        stdout=rf, stderr=subprocess.STDOUT,
                        stdin=subprocess.DEVNULL
                    )
                    try:
                        proc.wait(timeout=DIGEST_PROC_TIMEOUT)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        try: proc.wait(timeout=10)
                        except Exception: pass
                        raise RuntimeError(f'消化超时（>{DIGEST_PROC_TIMEOUT}s），已终止进程；请稍后重试或检查网络/模型')
                out = b''
                if proc.returncode != 0:
                    try:
                        with open(run_log, 'r', encoding='utf-8', errors='replace') as rf2:
                            out = rf2.read()[-800:].encode('utf-8', 'replace')
                    except Exception:
                        pass
                    tail = out.decode('utf-8', 'replace')
                    raise RuntimeError(f'消化脚本退出码 {proc.returncode}：{tail}')

                # 读取结构化结果（douyin_digest.py 单条模式写入）
                rec = None
                gid = None
                rj = {}
                try:
                    with open(result_file, 'r', encoding='utf-8') as f:
                        rj = json.load(f)
                    gid = rj.get('gid') or rj.get('existing_gid')
                except Exception:
                    pass

                master = self.load_master()
                notes = master.get('data', {}).get('learn_notes', {})
                if gid and gid in notes:
                    rec = notes[gid]
                else:
                    for g, n in notes.items():       # 兜底：按 url 匹配
                        if n.get('url') == url:
                            rec = n
                            gid = g
                            break

                with DIGEST_LOCK:
                    DIGEST_JOBS[job_id]['status'] = 'done'
                    DIGEST_JOBS[job_id]['step'] = '完成'
                    # 优先用脚本回传的结构化结果（含去重/来源信息），缺失项从 master 补
                    DIGEST_JOBS[job_id]['result'] = {
                        'gid': gid,
                        'dup': bool(rj.get('dup', False)),
                        'title': rj.get('title') or (rec.get('title') if rec else None),
                        'tags': rj.get('tags') or (rec.get('tags') if rec else []),
                        'author': rj.get('author') or (rec.get('author') if rec else None),
                        'publishDate': rj.get('publishDate') or (rec.get('publishDate') if rec else None),
                    }
            except Exception as e:
                sys.stderr.write(f"[digest error] job={job_id} url={url} :: {e}\n")
                with DIGEST_LOCK:
                    DIGEST_JOBS[job_id]['status'] = 'error'
                    DIGEST_JOBS[job_id]['step'] = '失败'
                    DIGEST_JOBS[job_id]['error'] = str(e)

    def handle_digest_status(self, parsed):
        """GET /api/digest/status?job_id=xxx"""
        params = urllib.parse.parse_qs(parsed.query)
        job_id = params.get('job_id', [''])[0]
        with DIGEST_LOCK:
            job = DIGEST_JOBS.get(job_id)
        if not job:
            self.send_json({'ok': False, 'error': '任务不存在或已过期'}, 404)
            return
        self.send_json({
            'ok': True,
            'status': job['status'],
            'step': job.get('step'),
            'result': job.get('result'),
            'error': job.get('error')
        })

    def handle_github_weekly(self, parsed):
        """GET /api/github-weekly —— 返回本周全品类周榜（含中文摘要 + 领域分类）。"""
        try:
            force = parsed.query == 'force=1' or urllib.parse.parse_qs(parsed.query).get('force') == ['1']
            data = _github_weekly_data(force=force)
            self.send_json(data)
        except Exception as e:
            self.send_json({'ok': False, 'error': str(e)}, 500)

    def handle_digest_github(self, parsed):
        """POST /api/digest-github  body: {"name":"owner/repo","url":"...","description":"...","zh":"..."}
        调用 DeepSeek 做结构化提炼（核心观点/结论/适用场景/行动建议），返回 markdown 长文。
        """
        try:
            raw = self.read_body() or b'{}'
            payload = json.loads(raw.decode('utf-8'))
            name = (payload.get('name') or '').strip()
            if not name:
                self.send_json({'ok': False, 'error': '缺少仓库'}, 400)
                return
            result = _ds_digest_repo(
                name=name,
                url=payload.get('url', ''),
                description=payload.get('description', ''),
                zh=payload.get('zh', ''),
            )
            if not result:
                self.send_json({'ok': False, 'error': 'AI 提炼失败（可能密钥未配置）'}, 503)
            else:
                self.send_json({'ok': True, 'note': result})
        except Exception as e:
            self.send_json({'ok': False, 'error': str(e)}, 500)

    def handle_deploy_status(self, parsed):
        """GET /api/deploy-status —— 部署状态自检：server / 隧道 / 各设备同步 / 备份。"""
        res = {
            'ok': True,
            'server': {'up': True, 'port': PORT},
            'time': int(datetime.now().timestamp() * 1000),
        }
        # 隧道：本地实时地址（cloudflared 写出）vs 已发布到 GitHub Pages 的地址
        tunnel_live = ''
        tunnel_pub = ''
        try:
            with open(os.path.join(SYNC_DIR, 'tunnel_url.txt'), 'r', encoding='utf-8') as f:
                tunnel_live = f.read().strip()
        except Exception:
            pass
        try:
            with open(os.path.join(WEBROOT, 'dist', 'tunnel.txt'), 'r', encoding='utf-8') as f:
                tunnel_pub = f.read().strip()
        except Exception:
            pass
        # 隧道可达性：直接探活公网地址（best-effort，超时即不可达）
        reachable = None
        if tunnel_live:
            try:
                with urllib.request.urlopen(tunnel_live + '/', timeout=5) as r:
                    reachable = (r.status == 200)
            except Exception:
                reachable = False
        res['tunnel'] = {
            'live': tunnel_live,
            'published': tunnel_pub,
            'match': bool(tunnel_live and tunnel_pub and tunnel_live == tunnel_pub),
            'reachable': reachable,
        }
        # 各设备同步快照（.sync 下除已知非设备文件外的 *.json）
        SKIP = {'master.json', 'auto-backup.json', 'github_weekly.json', 'github_digests.json'}
        devices = []
        try:
            for name in os.listdir(SYNC_DIR):
                if not name.endswith('.json') or name in SKIP:
                    continue
                try:
                    with open(os.path.join(SYNC_DIR, name), 'r', encoding='utf-8') as f:
                        d = json.load(f)
                    devices.append({
                        'device': d.get('device', name[:-5]),
                        'syncedAt': d.get('syncedAt'),
                    })
                except Exception:
                    pass
        except Exception:
            pass
        devices.sort(key=lambda x: x.get('syncedAt') or '', reverse=True)
        res['devices'] = devices
        # 自动备份
        try:
            bf = os.path.join(SYNC_DIR, 'auto-backup.json')
            if os.path.exists(bf):
                st = os.stat(bf)
                res['backup'] = {'exists': True, 'updatedAt': int(st.st_mtime * 1000), 'size': st.st_size}
            else:
                res['backup'] = {'exists': False}
        except Exception:
            res['backup'] = {'exists': False}
        # cloudflared 体积（过小 = 下载残缺）
        try:
            cf = os.path.join(WEBROOT, 'tools', 'cloudflared.exe')
            res['cloudflaredSize'] = os.path.getsize(cf) if os.path.exists(cf) else 0
        except Exception:
            res['cloudflaredSize'] = 0
        self.send_json(res)

    def send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', len(body))
        # 允许跨域：静态托管（GitHub Pages / CloudStudio 等）部署的页面可回连本机做同步/行情
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        # 预检请求：返回 CORS 头即可
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def load_master(self):
        """加载合并后的主数据集"""
        if not os.path.exists(MASTER_FILE):
            return {'version': 2, 'updatedAt': 0, 'data': {}, 'tombstones': {}}
        try:
            with open(MASTER_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return {'version': 2, 'updatedAt': 0, 'data': {}, 'tombstones': {}}

    def save_master(self, master):
        """保存合并后的主数据集"""
        os.makedirs(SYNC_DIR, exist_ok=True)
        tmp = MASTER_FILE + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(master, f, ensure_ascii=False)
        os.replace(tmp, MASTER_FILE)

    def handle_sync(self, parsed):
        """局域网同步端点: /api/sync?device=xxx&since=ts
        GET: 拉取自 since 之后的合并数据
        POST: 推送本地变更，服务端按「最新 updatedAt 覆盖」合并
        """
        params = urllib.parse.parse_qs(parsed.query)
        device = (params.get('device', [''])[0] or '').strip()
        if not device or not re.match(r'^[a-zA-Z0-9_-]{6,64}$', device):
            self.send_json({'ok': False, 'error': '无效的设备标识'}, 400)
            return

        try:
            since = int(params.get('since', ['0'])[0] or '0')
        except ValueError:
            since = 0

        os.makedirs(SYNC_DIR, exist_ok=True)
        safe = re.sub(r'[^a-zA-Z0-9_-]', '', device)
        device_path = os.path.join(SYNC_DIR, f'{safe}.json')

        if self.command == 'GET':
            # 全量返回：忽略 since，任何一端同步都拿到服务器完整数据，
            # 由客户端按 gid + updatedAt 合并，彻底消除「增量漏同步」问题。
            master = self.load_master()
            changes = {}
            for store_name, records in master.get('data', {}).items():
                if records:
                    changes[store_name] = list(records.values())
            tombstones = list(master.get('tombstones', {}).values())
            self.send_json({
                'ok': True,
                'changes': changes,
                'tombstones': tombstones,
                'serverTime': int(datetime.now().timestamp() * 1000)
            })
            return

        if self.command == 'POST':
            try:
                raw = self.read_body()
                payload = json.loads(raw.decode('utf-8'))
                master = self.load_master()
                now = int(datetime.now().timestamp() * 1000)
                incoming_changes = payload.get('changes') or payload.get('data') or {}
                incoming_tombstones = payload.get('tombstones') or []

                # 合并变更：按 gid 比较 updatedAt，最新覆盖
                # （08-07 bug fix）：如果该 gid 已被 tombstone 标记删除，且删除时间晚于 incoming 的 updatedAt，则拒绝复活
                for store_name, records in incoming_changes.items():
                    if store_name not in master['data']:
                        master['data'][store_name] = {}
                    for r in records:
                        gid = r.get('gid')
                        if not gid:
                            continue
                        # 字段归一化：timeline_logs.hour 统一为 int，
                        # 杜绝 str/int 混写（如自动化 POST 写字符串 "14"）导致下游 Python 排序崩溃
                        if store_name == 'timeline_logs' and 'hour' in r:
                            try:
                                r['hour'] = int(r['hour'])
                            except (TypeError, ValueError):
                                pass
                        # 时间戳归一化（治本 bug #1）：updatedAt 可能是数字/数字串/ISO日期串，
                        # 统一成 int 毫秒后再存，避免残留脏数据下次又触发 int>str 崩溃
                        r['updatedAt'] = _ts(r.get('updatedAt'))
                        # 检查 tombstone：若已被删且删除时间更新，跳过这条 incoming
                        existing_tomb = master['tombstones'].get(gid)
                        if existing_tomb and existing_tomb.get('storeName') == store_name:
                            tomb_time = _ts(existing_tomb.get('deletedAt'))
                            if tomb_time > _ts(r.get('updatedAt')):
                                continue  # 拒绝复活
                        existing = master['data'][store_name].get(gid)
                        if not existing or _ts(r.get('updatedAt')) > _ts(existing.get('updatedAt')):
                            master['data'][store_name][gid] = r

                # 合并墓碑：最新删除时间为准，并清除已被删除的数据
                for t in incoming_tombstones:
                    gid = t.get('gid')
                    if not gid:
                        continue
                    t['deletedAt'] = _ts(t.get('deletedAt'))
                    existing_t = master['tombstones'].get(gid)
                    if not existing_t or _ts(t.get('deletedAt')) > _ts(existing_t.get('deletedAt')):
                        master['tombstones'][gid] = t
                    store_name = t.get('storeName')
                    if store_name and store_name in master['data']:
                        rec = master['data'][store_name].get(gid)
                        if rec and _ts(t.get('deletedAt')) > _ts(rec.get('updatedAt')):
                            del master['data'][store_name][gid]

                # 时间轴重复条目去重：同 date+hour+content 完全相同的记录只保留最新一条，
                # 其余写 tombstone 并从 data 移除（防止多设备/旧数据把重复内容拉回）。
                tl_store = master['data'].get('timeline_logs')
                if tl_store:
                    tl_groups = {}
                    for gid, r in list(tl_store.items()):
                        if gid in master['tombstones']:
                            continue
                        date = r.get('date')
                        hour = r.get('hour')
                        if not date or hour is None:
                            continue
                        try:
                            hour = int(hour)
                        except (TypeError, ValueError):
                            continue
                        key = (date, hour, r.get('content'))
                        tl_groups.setdefault(key, []).append((gid, r))
                    for key, items in tl_groups.items():
                        if len(items) <= 1:
                            continue
                        items.sort(key=lambda x: _ts(x[1].get('updatedAt')))
                        for gid, r in items[:-1]:
                            master['tombstones'][gid] = {
                                'gid': gid,
                                'storeName': 'timeline_logs',
                                'deletedAt': now
                            }
                            tl_store.pop(gid, None)

                master['updatedAt'] = now
                self.save_master(master)

                # 保留单设备快照，兼容旧逻辑与调试
                payload['syncedAt'] = datetime.now().isoformat()
                with open(device_path, 'w', encoding='utf-8') as f:
                    json.dump(payload, f, ensure_ascii=False)

                self.send_json({'ok': True, 'serverTime': now})
            except Exception as e:
                self.send_json({'ok': False, 'error': str(e)}, 500)
            return

        self.send_json({'ok': False, 'error': '方法不支持'}, 405)

    def handle_backup(self, parsed):
        """磁盘自动备份端点: /api/backup
        POST: 接收客户端完整数据，写入 .sync/auto-backup.json
        GET: 返回当前备份文件信息
        """
        backup_file = os.path.join(SYNC_DIR, 'auto-backup.json')
        if self.command == 'GET':
            if not os.path.exists(backup_file):
                self.send_json({'ok': True, 'exists': False})
                return
            try:
                st = os.stat(backup_file)
                with open(backup_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                counts = {}
                for store_name, records in data.get('data', {}).items():
                    counts[store_name] = len(records) if isinstance(records, list) else len(records)
                self.send_json({
                    'ok': True,
                    'exists': True,
                    'size': st.st_size,
                    'updatedAt': int(st.st_mtime * 1000),
                    'total': sum(counts.values()),
                    'counts': counts
                })
            except Exception as e:
                self.send_json({'ok': False, 'error': str(e)}, 500)
            return

        if self.command == 'POST':
            try:
                raw = self.read_body() or b'{}'
                payload = json.loads(raw.decode('utf-8'))
                os.makedirs(SYNC_DIR, exist_ok=True)
                tmp = backup_file + '.tmp'
                with open(tmp, 'w', encoding='utf-8') as f:
                    json.dump(payload, f, ensure_ascii=False)
                os.replace(tmp, backup_file)
                self.send_json({'ok': True, 'size': os.path.getsize(backup_file)})
            except Exception as e:
                self.send_json({'ok': False, 'error': str(e)}, 500)
            return

        self.send_json({'ok': False, 'error': '方法不支持'}, 405)

    def log_message(self, format, *args):
        # 临时开日志，便于排查手机消化失败（之后可改回 pass）
        try:
            sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format % args))
        except Exception:
            pass

def _load_github_token():
    """读取 GitHub token：优先环境变量 GH_TOKEN，其次 .sync/github_token.txt（不进 dist，不上传）。"""
    t = os.environ.get('GH_TOKEN')
    if t:
        return t.strip()
    p = os.path.join(SYNC_DIR, 'github_token.txt')
    if os.path.exists(p):
        try:
            return open(p, encoding='utf-8').read().strip()
        except Exception:
            return None
    return None


def _github_api(method, path, token, data=None):
    url = f'https://api.github.com/repos/whaleof/second-brain-web/contents/{path}'
    headers = {
        'Authorization': f'Bearer {token}',
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
    }
    req = urllib.request.Request(url, headers=headers, method=method)
    if data is not None:
        req.data = json.dumps(data).encode('utf-8')
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode('utf-8'))


def _publish_tunnel_url(url):
    """把最新隧道地址写入 dist/tunnel.txt 并推到 GitHub Pages，供前端自动读取（无需手动填地址）。"""
    token = _load_github_token()
    if not token:
        print('[隧道] 未配置 GitHub token，跳过自动发布地址（手动填仍可正常工作）')
        return
    # 本地也留一份，方便排查
    url_path = os.path.join(SYNC_DIR, 'tunnel_url.txt')
    try:
        with open(url_path, 'w', encoding='utf-8') as f:
            f.write(url)
    except Exception:
        pass
    # 写进 dist，并推到 GitHub（GitHub Pages 会重建，约 1-3 分钟生效）
    dist_file = os.path.join(WEBROOT, 'dist', 'tunnel.txt')
    try:
        os.makedirs(os.path.dirname(dist_file), exist_ok=True)
        with open(dist_file, 'w', encoding='utf-8') as f:
            f.write(url)
    except Exception:
        pass
    content_b64 = base64.b64encode(url.encode('utf-8')).decode('ascii')
    try:
        sha = None
        try:
            cur = _github_api('GET', 'tunnel.txt', token)
            sha = cur.get('sha')
        except urllib.error.HTTPError:
            sha = None
        payload = {'message': 'auto: update tunnel url', 'content': content_b64}
        if sha:
            payload['sha'] = sha
        _github_api('PUT', 'tunnel.txt', token, payload)
        print('[隧道] 已自动把新地址发布到 GitHub Pages，前端将自动读取并更新')
    except Exception as e:
        print(f'[隧道] 自动发布地址到 GitHub 失败: {e}（不影响本地使用，可稍后手动填）')


def _start_tunnel():
    """启动 cloudflared 快速隧道，把本机 server.py 暴露成公网 https，并把地址写到 .sync/tunnel_url.txt 与 GitHub Pages。"""
    cf = os.path.join(WEBROOT, 'tools', 'cloudflared.exe')
    if not os.path.exists(cf):
        print('[隧道] 未找到 tools/cloudflared.exe，跳过自动隧道')
        return
    if os.path.getsize(cf) < 40 * 1024 * 1024:
        print('[隧道] 警告: cloudflared.exe 文件过小（可能下载残缺），隧道大概率起不来。'
              '请重新双击 启动工作台.bat，它会自动重新下载。')
        return
    proc = subprocess.Popen(
        [cf, 'tunnel', '--url', f'http://localhost:{PORT}'],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1
    )
    url_path = os.path.join(SYNC_DIR, 'tunnel_url.txt')
    published = {'done': False}

    def _watch():
        try:
            for line in proc.stdout:
                m = re.search(r'https://[a-z0-9.-]+\.trycloudflare\.com', line)
                if m:
                    url = m.group(0)
                    try:
                        with open(url_path, 'w', encoding='utf-8') as f:
                            f.write(url)
                    except Exception:
                        pass
                    if not published['done']:
                        published['done'] = True
                        _publish_tunnel_url(url)
                    print(f'\n=== 隧道已就绪 ===\n{url}\n(已自动发布到 GitHub Pages，前端无需手动填地址)\n')
        except Exception:
            pass

    threading.Thread(target=_watch, daemon=True).start()
    atexit.register(lambda: proc.poll() is None and proc.terminate())
    print('[隧道] 正在启动 cloudflared 快速隧道...')


# ===== GitHub 周榜（全品类 + AI 高亮，中文一句话摘要）=====
GITHUB_WEEKLY_CACHE = os.path.join(SYNC_DIR, 'github_weekly.json')


def _gh_search(query, per_page=30, token=None):
    """复用 github-trending-cn 的 GitHub Search API 逻辑：按近期 push + stars 排序。"""
    params = urllib.parse.urlencode({
        'q': query, 'sort': 'stars', 'order': 'desc', 'per_page': per_page
    })
    url = f'https://api.github.com/search/repositories?{params}'
    headers = {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'second-brain/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
    }
    if token:
        headers['Authorization'] = f'Bearer {token}'
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode('utf-8')).get('items', [])
    except Exception as e:
        print(f'[周榜] GitHub API 错误: {e}', file=sys.stderr)
        return []


def _fetch_weekly_repos(limit=25, token=None):
    since = (datetime.now(timezone.utc) - timedelta(days=7)).strftime('%Y-%m-%d')
    seen = set()
    results = []
    for it in _gh_search(f'pushed:>={since} stars:>=10', per_page=min(limit * 2, 100), token=token):
        if it['full_name'] not in seen:
            seen.add(it['full_name'])
            results.append(it)
    # 按主流语言补充，避免单语言垄断，保证多样性
    if len(results) < limit * 2:
        for lang in ['python', 'javascript', 'typescript', 'go', 'rust']:
            if len(results) >= limit * 3:
                break
            for it in _gh_search(f'pushed:>={since} stars:>=50 language:{lang}', per_page=20, token=token):
                if it['full_name'] not in seen:
                    seen.add(it['full_name'])
                    results.append(it)
    results.sort(key=lambda r: r.get('stargazers_count', 0), reverse=True)
    return results[:limit]


def _ds_config():
    """读取 .env 里的 DeepSeek（OpenAI 兼容）配置，用于批量中文摘要。"""
    key = base = model = None
    p = os.path.join(WEBROOT, '.env')
    if os.path.exists(p):
        try:
            with open(p, encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith('#') or '=' not in line:
                        continue
                    k, v = line.split('=', 1)
                    k = k.strip()
                    if k == 'OPENAI_API_KEY':
                        key = v.strip()
                    elif k == 'OPENAI_BASE_URL':
                        base = v.strip()
                    elif k == 'OPENAI_MODEL':
                        model = v.strip()
        except Exception:
            pass
    key = key or os.environ.get('OPENAI_API_KEY')
    base = base or os.environ.get('OPENAI_BASE_URL') or 'https://api.openai.com/v1'
    model = model or os.environ.get('OPENAI_MODEL') or 'deepseek-chat'
    return key, base, model


def _parse_ds_json(content):
    if not content:
        return None
    s = content.strip()
    m = re.search(r'```(?:json)?\s*(.*?)\s*```', s, re.DOTALL)
    if m:
        s = m.group(1)
    try:
        arr = json.loads(s)
        if isinstance(arr, dict):
            arr = arr.get('repos') or arr.get('items') or []
        return arr if isinstance(arr, list) else None
    except Exception:
        return None


def _ds_summarize(repos, key, base, model):
    """一次调用让 DeepSeek 给全量仓库出中文一句话摘要 + 领域分类。"""
    if not key:
        return None
    sys_prompt = (
        '你是中文技术编辑。下面是一批 GitHub 仓库（name/简介/话题）。'
        '请为每个仓库输出一句中文简介（不超过 40 字，说清它是什么、解决什么问题），'
        '并判断领域：AI(人工智能/大模型/Agent/RAG)、工具(开发/效率/运维)、'
        '学习(教程/资料)、其他。只返回 JSON 数组，不要解释，'
        '格式：[{"name":"owner/repo","zh":"中文简介","domain":"AI"}]'
    )
    items = [{'name': r['full_name'],
              'desc': r.get('description') or '',
              'topics': r.get('topics', [])[:6]} for r in repos]
    url = base.rstrip('/') + '/chat/completions'
    payload = {
        'model': model,
        'messages': [
            {'role': 'system', 'content': sys_prompt},
            {'role': 'user', 'content': json.dumps(items, ensure_ascii=False)}
        ],
        'temperature': 0.3,
    }
    headers = {'Content-Type': 'application/json', 'Authorization': f'Bearer {key}'}
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'),
                                  headers=headers, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        return _parse_ds_json(data['choices'][0]['message']['content'])
    except Exception as e:
        print(f'[周榜] DeepSeek 摘要失败: {e}', file=sys.stderr)
        return None


def _ds_digest_repo(name, url='', description='', zh=''):
    """对单个 GitHub 仓库做 DeepSeek 结构化提炼，返回 markdown 长文。
    结果缓存到 .sync/github_digests.json，同仓库重复调用直接返回缓存（瞬间）。"""
    # ① 查缓存
    cache_path = os.path.join(SYNC_DIR, 'github_digests.json')
    try:
        if os.path.exists(cache_path):
            with open(cache_path, 'r', encoding='utf-8') as f:
                cache = json.load(f)
            if name in cache:
                print(f'[周榜消化] 命中缓存: {name}')
                return cache[name]
    except Exception:
        pass

    # ② 缓存未命中 → 调 API
    key, base, model = _ds_config()
    if not key:
        return None
    sys_prompt = (
        "你是技术洞察分析师。对给定的GitHub仓库写中文极简分析（**模仿 GitHub 周榜 Digest HTML 的两行格式**）。\n\n"
        "格式要求（**严格**）：\n"
        "1. **只输出两行**，用换行分隔，每行（含前缀）不超过 40 字：\n"
        "   第一行以「作者在干嘛：」开头，说清这个仓库在做什么、解决什么问题（动宾、抓本质，不要「他介绍了…」套话）\n"
        "   第二行以「关联工作台：」开头，写对「第二大脑工作台」的具体落地启发（落到本地优先/IndexedDB/语义回忆/自动化/标签治理 等具体机制上）\n"
        "2. 不用任何章节标题（不要 ### 核心观点/### 结论/### 适用场景/### 行动建议），不要其他前缀。\n"
        "3. 直接输出两行正文，不要任何客套话/导语/总结。\n\n"
        "如果仓库信息太少说不清，就只输出一行「信息不足、跳过」即可。"
    )
    user_content = json.dumps({
        'name': name,
        'url': url,
        'description': description or '',
        'summary': zh or '',
    }, ensure_ascii=False)
    ds_url = base.rstrip('/') + '/chat/completions'
    payload = {
        'model': model,
        'messages': [
            {'role': 'system', 'content': sys_prompt},
            {'role': 'user', 'content': f"请分析这个 GitHub 项目：\n\n{user_content}"}
        ],
        'temperature': 0.5,
        'max_tokens': 800,
    }
    headers = {'Content-Type': 'application/json', 'Authorization': f'Bearer {key}'}
    req = urllib.request.Request(ds_url, data=json.dumps(payload).encode('utf-8'),
                                  headers=headers, method='POST')
    try:
        print(f'[周榜消化] 正在调用 DeepSeek 提炼: {name} ...')
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        result = data['choices'][0]['message']['content'].strip()

        # ③ 写入缓存
        try:
            cache = {}
            if os.path.exists(cache_path):
                with open(cache_path, 'r', encoding='utf-8') as f:
                    cache = json.load(f)
            cache[name] = result
            with open(cache_path, 'w', encoding='utf-8') as f:
                json.dump(cache, f, ensure_ascii=False, indent=2)
            print(f'[周榜消化] 已缓存: {name}')
        except Exception as e:
            print(f'[周榜消化] 缓存写入失败: {e}', file=sys.stderr)

        return result
    except Exception as e:
        print(f'[周榜消化] DeepSeek 提炼失败({name}): {e}', file=sys.stderr)
        return None




def _heuristic_domain(r):
    blob = ((r.get('description') or '') + ' ' + ' '.join(r.get('topics', []))).lower()
    ai_kw = ['ai', 'llm', 'gpt', 'agent', 'rag', 'machine learning', 'deep learning',
             'neural', 'transformer', 'chatbot', 'prompt', 'mcp', 'diffusion', 'nlp']
    if any(k in blob for k in ai_kw):
        return 'AI'
    if any(k in blob for k in ['tutorial', 'learn', 'course', 'book', 'docs']):
        return '学习'
    return '工具'


def _github_weekly_data(force=False):
    """返回本周 GitHub 周榜；按 ISO 周惰性刷新（缓存到 .sync/github_weekly.json）。"""
    token = _load_github_token()
    week = datetime.now().isocalendar()
    week_key = f'{week[0]}-W{week[1]}'
    if not force and os.path.exists(GITHUB_WEEKLY_CACHE):
        try:
            with open(GITHUB_WEEKLY_CACHE, encoding='utf-8') as f:
                data = json.load(f)
            if data.get('week') == week_key and data.get('items'):
                return data
        except Exception:
            pass
    repos = _fetch_weekly_repos(limit=25, token=token)
    if not repos:
        if os.path.exists(GITHUB_WEEKLY_CACHE):
            try:
                with open(GITHUB_WEEKLY_CACHE, encoding='utf-8') as f:
                    return json.load(f)
            except Exception:
                pass
        return {'week': week_key,
                'generatedAt': int(datetime.now().timestamp() * 1000),
                'items': [],
                'error': '获取 GitHub 数据失败（可能已达 API 限额，稍后再试，或配置 .sync/github_token.txt 提升限额）'}
    key, base, model = _ds_config()
    summ = _ds_summarize(repos, key, base, model) or []
    summ_map = {s.get('name'): s for s in summ if s.get('name')}
    items = []
    for r in repos:
        name = r['full_name']
        s = summ_map.get(name) or {}
        zh = s.get('zh') or r.get('description') or ''
        domain = s.get('domain') or _heuristic_domain(r)
        items.append({
            'rank': 0,
            'name': name,
            'url': r['html_url'],
            'description': r.get('description') or '',
            'stars': r.get('stargazers_count', 0),
            'forks': r.get('forks_count', 0),
            'language': r.get('language'),
            'topics': r.get('topics', [])[:6],
            'pushedAt': r.get('pushed_at'),
            'zh': zh,
            'domain': domain,
        })
    for i, it in enumerate(items, 1):
        it['rank'] = i
    data = {'week': week_key,
            'generatedAt': int(datetime.now().timestamp() * 1000),
            'items': items}
    try:
        os.makedirs(SYNC_DIR, exist_ok=True)
        with open(GITHUB_WEEKLY_CACHE, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False)
    except Exception:
        pass
    return data


def handle_github_weekly(self, parsed):
    """GET /api/github-weekly —— 返回本周全品类周榜（含中文摘要 + 领域分类）。"""
    try:
        params = urllib.parse.parse_qs(parsed.query)
        force = params.get('force', ['0'])[0] in ('1', 'true')
        data = _github_weekly_data(force=force)
        self.send_json({'ok': True, **data})
    except Exception as e:
        self.send_json({'ok': False, 'error': str(e)}, 500)


# ===== 单实例锁：避免多个 server.py 同时跑，抢 8080 / 重复拉隧道导致手机同步错乱 =====
LOCK_FILE = os.path.join(SYNC_DIR, 'server.pid')


def _pid_alive(pid):
    """跨平台判断进程是否存活；Windows 下 os.kill(pid, 0) 进程存在即返回 True。"""
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False
    except Exception:
        return False


def _acquire_instance_lock():
    """拿到锁返回 True；已有存活实例返回 False。锁指向死进程时自动清理后放行。"""
    try:
        if os.path.exists(LOCK_FILE):
            old_pid = 0
            try:
                with open(LOCK_FILE, 'r', encoding='utf-8') as f:
                    old_pid = int((f.read() or '0').strip() or 0)
            except Exception:
                old_pid = 0
            if old_pid and _pid_alive(old_pid):
                return False
            try:
                os.remove(LOCK_FILE)
            except OSError:
                pass
        os.makedirs(SYNC_DIR, exist_ok=True)
        with open(LOCK_FILE, 'w', encoding='utf-8') as f:
            f.write(str(os.getpid()))
        return True
    except Exception:
        # 锁文件不可写时不阻塞启动，降级为仅端口检测
        return True


def _release_instance_lock():
    try:
        if os.path.exists(LOCK_FILE):
            pid_in_file = 0
            with open(LOCK_FILE, 'r', encoding='utf-8') as f:
                pid_in_file = int((f.read() or '0').strip() or 0)
            # 必须先关闭文件句柄再删除：Windows 不允许删除仍被本进程打开的文件
            if pid_in_file == os.getpid():
                os.remove(LOCK_FILE)
    except Exception:
        pass


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--tunnel', action='store_true', help='启动时自动拉起 cloudflared 公网隧道')
    args = parser.parse_args()

    # 单实例锁：已有存活实例直接退出，绝不重复拉隧道 / 占端口（多实例是同步失败最大根因）
    if not _acquire_instance_lock():
        print(f'[server] 检测到已有 server.py 实例在运行（PID 见 {LOCK_FILE}）。'
              f'为避免多实例抢 8080 / 重复隧道导致同步错乱，本次直接退出。')
        print('[server] 如需重启，请先关闭旧的 server.py 窗口。')
        raise SystemExit(0)

    atexit.register(_release_instance_lock)

    if args.tunnel:
        _start_tunnel()

    try:
        server = http.server.ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    except OSError as e:
        if '10048' in str(e) or 'address already in use' in str(e).lower():
            # 端口被其它（非本脚本）进程占用：同样不放行，避免无后端却以为启动成功
            print(f'[server] 端口 {PORT} 已被其它进程占用，退出。请先释放端口或关闭冲突程序。')
            raise SystemExit(1)
        raise
    print(f'服务器启动: http://localhost:{PORT}')
    server.serve_forever()
