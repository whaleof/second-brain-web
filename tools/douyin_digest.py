#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
抖音收藏 → 认知笔记 · 深度提炼工具
================================================================================
把你抖音里「收藏了但没看」的视频，变成第二大脑「认知」模块里可直接回看的
观点笔记，而不是又一个躺着等看的链接。

流程:
    抖音分享链接(或本地视频)
      → 红狐 API 解析下载无水印 mp4          (需 REDFOX_API_KEY)
      → imageio-ffmpeg 抽取音频(wav 16k单声道)
      → 本地 faster-whisper 转写语音为中文文稿 (免 key；或 TRANSCRIBE_MODE=api 走 OpenAI Whisper)
      → OpenAI 兼容聊天模型提炼(默认 DeepSeek): 核心观点3条/结论/适用场景/领域标签/行动建议
      → 写入 .sync/master.json 的 learn_notes (gid 主键, status="pending" 待消化)
      → 浏览器下次同步自动出现在「认知」模块「待消化」队列；标记已消化后转 done；同时归档一份 Markdown

与随想整合工具 digest_tool.py 同理: 直接原子写 master.json，复用既有同步链路
下发到手机/电脑，不依赖 server.py 是否在跑。

用法:
    # 完整跑一条（需 REDFOX_API_KEY 下载 + OPENAI_API_KEY 分析；转写默认本地免 key）
    python douyin_digest.py --url "https://v.douyin.com/xxxx/"

    # 直接用本机已下载的视频
    python douyin_digest.py --file "C:/videos/xxx.mp4"

    # 跳过下载/转写/分析，仅验证「写库 + 归档」（用给定文稿，无需任何 key）
    python douyin_digest.py --url "https://v.douyin.com/xxxx/" \
        --transcript-file transcript.txt --skip-download --skip-llm

    # 批量消化收藏夹：把一堆抖音链接每行一个放进 urls.txt，一键串行处理
    # （逐条容错，某条失败不中断，最后汇总成败；--fail-log 可选记录失败项）
    python douyin_digest.py --batch-urls-file urls.txt
    python douyin_digest.py --batch-urls-file urls.txt --fail-log failed.txt

环境变量:
    REDFOX_API_KEY   红狐数据 API Key (https://redfox.hk/settings/api-keys)  ← 下载必须
    OPENAI_API_KEY   分析用「OpenAI 兼容」Key（DeepSeek / 通义 / 智谱 等；DeepSeek 已验证可用）
    OPENAI_BASE_URL  分析用 base url（DeepSeek 示例 https://api.deepseek.com；默认官方）
    OPENAI_MODEL     分析所用聊天模型（DeepSeek 示例 deepseek-chat）
    TRANSCRIBE_MODE  转写方式: local(默认, 本地 faster-whisper 免 key) | api(走 OpenAI Whisper, 需 WHISPER_API_KEY)
    WHISPER_API_KEY  仅 TRANSCRIBE_MODE=api 时需要（DeepSeek 不支持音频，不能复用）
    WHISPER_BASE_URL 转写 API base（默认 https://api.openai.com/v1）
    WHISPER_SIZE     本地转写模型大小（默认 base；可选 tiny/small 等）
    WHISPER_MODEL_DIR 本地模型目录（内含 model.bin 时优先用，避免国内拉不到 HF/Xet）
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import uuid
from datetime import datetime
from pathlib import Path

# Windows 终端 UTF-8
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

WORKSPACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASTER_FILE = os.path.join(WORKSPACE, ".sync", "master.json")
ARCHIVE_DIR = os.path.join(WORKSPACE, "data", "learn-digests")
LEARN_STORE = "learn_notes"


# ─── 本地 .env 支持（密钥放文件，不进聊天/仓库）──────────────────────────────
def _load_dotenv_local():
    """读取 WORKSPACE/.env（若存在），仅补充尚未设置的环境变量，不覆盖已设置的。"""
    dotenv = os.path.join(WORKSPACE, ".env")
    if not os.path.exists(dotenv):
        return
    try:
        with open(dotenv, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k, v = k.strip(), v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except Exception:
        pass


_load_dotenv_local()

# 认知模块的预设领域标签（LLM 只能从这里选，保证前端筛选可用）
PRESET_TAGS = ["挣钱", "理财", "法律", "自媒体", "科技", "AI", "职场", "地缘",
               "股市", "经济", "商业", "新闻", "油价汇价"]

# ─── 红狐 API（下载解析）──────────────────────────────────────────────────────
REDFOX_API_BASE = "https://redfox.hk"
REDFOX_PARSE_ENDPOINT = "/story/api/parseWork/videoDownload/douyin"


# ─── 颜色 ──────────────────────────────────────────────────────────────────────
def _c(code, s):
    if sys.stdout.isatty():
        return f"\033[{code}m{s}\033[0m"
    return s


def info(m):
    print(_c("92", "[OK] ") + m)


def step(m):
    print(_c("96", "[>>] ") + m)


def warn(m):
    print(_c("93", "[!!] ") + m)


def err(m):
    print(_c("91", "[XX] ") + m)


# ─── master.json 原子读写（mirror digest_tool）──────────────────────────────────
def load_master():
    if not os.path.exists(MASTER_FILE):
        return {"version": 2, "updatedAt": 0, "data": {}, "tombstones": {}}
    try:
        with open(MASTER_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"version": 2, "updatedAt": 0, "data": {}, "tombstones": {}}


def save_master(master):
    os.makedirs(os.path.dirname(MASTER_FILE), exist_ok=True)
    tmp = MASTER_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(master, f, ensure_ascii=False)
    os.replace(tmp, MASTER_FILE)


# ─── 抖音链接解析 / 下载 ─────────────────────────────────────────────────────────
def resolve_real_url(short_url, timeout=20):
    """v.douyin.com 短链跳转后拿到真实视频页 URL。"""
    try:
        resp = __import__("requests").get(
            short_url, headers={"User-Agent": "Mozilla/5.0"},
            allow_redirects=True, timeout=timeout,
        )
        return resp.url
    except Exception as e:
        warn(f"短链跳转失败，尝试直接用原链接: {e}")
        return short_url


def _dig(d, *names, default=None):
    """在嵌套 dict/list 里按 key 名（任一匹配）查找第一个非空值。"""
    if isinstance(d, dict):
        for k, v in d.items():
            if k in names and v not in (None, "", [], {}):
                return v
        for v in d.values():
            r = _dig(v, *names)
            if r is not None:
                return r
    elif isinstance(d, list):
        for v in d:
            r = _dig(v, *names)
            if r is not None:
                return r
    return default


def normalize_url(u):
    """归一化 URL：去查询/锚点/末尾斜杠、小写 host+path，用于去重比对。"""
    if not u:
        return ""
    u = u.strip().split("?")[0].split("#")[0].rstrip("/")
    try:
        p = urllib.parse.urlparse(u)
        return (p.netloc + p.path).lower()
    except Exception:
        return u.lower()


def find_existing_learn_note(content_id=None, canonical_url=None, submit_url=None):
    """按 content_id（优先）→ 归一化 canonical_url → 归一化 提交原始 url 查重，返回已有记录或 None。

    三层覆盖：新笔记带 contentId/canonicalUrl（同作品任意短链都能命中）；
    旧笔记只有原始短链 url（重贴同一条短链也能命中）。
    """
    if not content_id and not canonical_url and not submit_url:
        return None
    master = load_master()
    notes = master.get("data", {}).get(LEARN_STORE, {})
    norm_c = normalize_url(canonical_url) if canonical_url else None
    norm_s = normalize_url(submit_url) if submit_url else None
    for rec in notes.values():
        if content_id and rec.get("contentId") and rec.get("contentId") == content_id:
            return rec
        if norm_c and rec.get("canonicalUrl") and normalize_url(rec.get("canonicalUrl")) == norm_c:
            return rec
        if norm_s and rec.get("url") and normalize_url(rec.get("url")) == norm_s:
            return rec
    return None


def redfox_parse(work_url, api_key):
    """调用红狐解析接口，返回 {success, download_url, title, duration}。"""
    import requests
    payload = {"url": work_url, "source": "收藏提炼-WorkBuddy"}
    headers = {"Content-Type": "application/json", "X-API-KEY": api_key}
    try:
        resp = requests.post(
            f"{REDFOX_API_BASE}{REDFOX_PARSE_ENDPOINT}",
            json=payload, headers=headers, timeout=30,
        )
        data = resp.json()
    except Exception as e:
        return {"success": False, "error": f"解析请求失败: {e}"}

    code = str(data.get("code", ""))
    if not code.startswith("2"):
        return {"success": False,
                "error": f"解析失败 (code {code}): {data.get('msg', '')}"}
    pd = data.get("data") or {}
    title = pd.get("desc") or pd.get("title")
    dl = None
    for res in (pd.get("resources") or []):
        if isinstance(res, dict):
            u = res.get("downloadUrl") or res.get("url")
            if u and res.get("type") == "video" and not dl:
                dl = u
    if not dl:
        dl = (pd.get("videoUrl") or pd.get("download_url")
              or pd.get("playUrl"))

    # 抽取来源元数据：博主 / 发布时间 / 作品唯一 ID（用于卡片展示 + 去重）
    author = _dig(pd, "author", "authorName", "author_name", "nickname", "authorNickname",
                  "nickName", "unique_id", "uniqueId")
    if isinstance(author, dict):
        author = author.get("nickname") or author.get("name") or author.get("uniqueId") \
            or author.get("nickName") or str(author)
    author_id = _dig(pd, "authorId", "author_id", "uid", "secUid", "authorIdStr",
                     "user_id", "userId")
    ct = _dig(pd, "createTime", "create_time", "publishTime", "publish_time",
              "createTimeMs", "publishTimeMs")
    publish_date = ""
    if ct:
        try:
            ct_int = int(str(ct)[:13] if len(str(ct)) > 13 else int(ct))
            if ct_int > 10 ** 12:           # 毫秒
                dt = datetime.fromtimestamp(ct_int / 1000)
            else:                            # 秒
                dt = datetime.fromtimestamp(ct_int)
            publish_date = dt.strftime("%Y-%m-%d")
        except Exception:
            publish_date = str(ct)
    content_id = _dig(pd, "awemeId", "aweme_id", "videoId", "video_id",
                      "noteId", "note_id", "itemId", "item_id", "workId", "id")
    if content_id:
        content_id = str(content_id)

    meta = {"author": author or "", "author_id": author_id or "",
            "publishDate": publish_date, "content_id": content_id}

    # 调试：当作者信息缺失时，记录 API 返回的顶层 key 方便排查
    if not author and not author_id:
        debug_keys = list(pd.keys())[:20]
        print(f"[WARN] 红狐 API 未返回博主信息，data 顶层 keys: {debug_keys}")

    if dl:
        return {"success": True, "type": "video", "download_url": dl,
                "title": title, "duration": pd.get("duration"), **meta}
    # 图文笔记：尝试抽取图片地址（无视频时走图片 OCR 链路）
    images = _collect_image_urls(pd)
    if images:
        return {"success": True, "type": "image", "images": images,
                "title": title, **meta}
    return {"success": False, "error": "该内容没有视频/图片可下载（可能是纯文字或受限作品），智能消化目前仅支持视频与图文笔记"}


def yuntts_parse(work_url, api_key):
    """云霆(yuntts)备用解析源，归一化到与 redfox_parse 一致的返回结构。
    抖音分享短链云霆通常能直接解析；个别链接长链反而失败，故短链优先、长链兜底。
    返回 {success, type, download_url, title, duration, author, author_id, publishDate, content_id}。
    """
    import requests

    def _try(u):
        try:
            resp = requests.post(
                "https://www.yuntts.com/api/v1/tiktok",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={"url": u}, timeout=30,
            )
            j = resp.json()
        except Exception as e:
            return None, f"yuntts_req_err:{e}"
        if j.get("code") != 200:
            return None, f"yuntts_{j.get('code')}:{j.get('message')}"
        d = (j.get("data") or {}).get("data") or {}
        t = str(d.get("type", ""))
        return {
            "success": True,
            "type": "image" if t == "1" else "video",
            "download_url": d.get("url") or "",
            "title": (d.get("title") or "").strip(),
            "duration": None,
            "author": "", "author_id": "", "publishDate": "", "content_id": "",
        }, None

    # 短链优先（抖音分享链接本身就是短链，yuntts 直接能解析）
    res, err1 = _try(work_url)
    if res:
        return res
    # 长链兜底：resolve 后重试，覆盖短链被识别为无效的情况
    real = resolve_real_url(work_url) if work_url.startswith("http") else work_url
    if real and real != work_url:
        res2, err2 = _try(real)
        if res2:
            return res2
        return {"success": False, "error": f"云霆短链失败({err1})；长链也失败({err2})"}
    return {"success": False, "error": err1}


def _collect_image_urls(pd):
    """从红狐返回的 data 里尽可能多地抽取图片地址。

    优先级：resources 中 type 为 image 的 → 常见图文字段(images/imageList/album/pics) → cover。
    最后兜底扫描整个 data 里以图片扩展名结尾的 URL（排除头像/logo 等噪音）。
    返回去重后的 URL 列表。
    """
    images = []
    seen = set()

    def add(u):
        if u and isinstance(u, str) and u.startswith("http") and u not in seen:
            seen.add(u)
            images.append(u)

    # 1) resources 里 type 为图片的
    for res in (pd.get("resources") or []):
        if isinstance(res, dict):
            if str(res.get("type", "")).lower() in ("image", "img", "pic", "picture"):
                add(res.get("downloadUrl") or res.get("url"))

    # 2) 常见图文字段
    for key in ("images", "imageList", "image_list", "album", "pics", "pictureUrls", "picUrls"):
        v = pd.get(key)
        if isinstance(v, list):
            for it in v:
                if isinstance(it, str):
                    add(it)
                elif isinstance(it, dict):
                    add(it.get("url") or it.get("src") or it.get("origin") or it.get("thumbnail"))
        elif isinstance(v, str):
            add(v)
    # cover
    cover = pd.get("cover")
    if isinstance(cover, str):
        add(cover)

    # 3) 兜底：扫描整个 data 里以图片扩展名结尾的 URL，排除 avatar/logo/head 等
    if not images:
        blob = json.dumps(pd, ensure_ascii=False)
        for m in re.finditer(r"https?://[^\s\"'\\]+?\.(?:jpg|jpeg|png|webp)", blob, re.I):
            u = m.group(0)
            if re.search(r"(avatar|logo|head|icon|thumb_|watermark)", u, re.I):
                continue
            add(u)

    return images


def download_file(url, path, retries=3):
    import requests, time
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                      "AppleWebKit/537.36 (KHTML, like Gecko) "
                      "Chrome/124.0.0.0 Safari/537.36",
        "Referer": "https://www.douyin.com/",
        "Accept": "video/mp4,video/*;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
    }
    for attempt in range(1, retries + 1):
        try:
            resp = requests.get(url, headers=headers, timeout=60, stream=True)
            resp.raise_for_status()
            total = 0
            with open(path, "wb") as f:
                for chunk in resp.iter_content(chunk_size=65536):
                    if chunk:
                        f.write(chunk)
                        total += len(chunk)
            if total < 1024:
                raise IOError(f"文件过小 ({total}B)，疑似未拿到真实视频")
            info(f"下载完成（{total // 1024} KB）")
            return True
        except Exception as e:
            err(f"下载尝试 {attempt}/{retries} 失败: {e}")
            try:
                os.remove(path)
            except OSError:
                pass
            time.sleep(2)
    return False


# ─── 音频抽取（ffmpeg via imageio-ffmpeg）────────────────────────────────────────
def get_ffmpeg():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        exe = shutil.which("ffmpeg")
        if exe:
            return exe
        raise RuntimeError("未找到 ffmpeg，请先 pip install imageio-ffmpeg")


def extract_audio(video_path, wav_path):
    ffmpeg = get_ffmpeg()
    cmd = [ffmpeg, "-y", "-i", video_path, "-vn", "-ac", "1",
           "-ar", "16000", "-f", "wav", wav_path]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(wav_path):
        raise RuntimeError(f"音频抽取失败: {r.stderr[-300:]}")
    return wav_path


# ─── 转写 + 分析（OpenAI 兼容）───────────────────────────────────────────────────
def make_chat_client():
    """分析（提炼观点）用的 OpenAI 兼容客户端，默认指向 DeepSeek。"""
    from openai import OpenAI
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise RuntimeError("缺少 OPENAI_API_KEY（分析用，DeepSeek 等兼容服务）")
    base = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
    return OpenAI(api_key=key, base_url=base)


def transcribe(audio_path):
    """语音 → 文字。默认本地 faster-whisper（免 key）；可切 api 走 OpenAI Whisper。"""
    mode = os.environ.get("TRANSCRIBE_MODE", "local").lower()
    if mode == "api":
        # 注意：DeepSeek 等多数兼容服务不含音频接口，需单独的 Whisper key
        from openai import OpenAI
        key = os.environ.get("WHISPER_API_KEY") or os.environ.get("OPENAI_API_KEY")
        if not key:
            raise RuntimeError("TRANSCRIBE_MODE=api 但缺少 WHISPER_API_KEY")
        base = os.environ.get("WHISPER_BASE_URL", "https://api.openai.com/v1")
        c = OpenAI(api_key=key, base_url=base)
        model = os.environ.get("OPENAI_WHISPER_MODEL", "whisper-1")
        with open(audio_path, "rb") as f:
            return c.audio.transcriptions.create(model=model, file=f, language="zh").text
    return _transcribe_local(audio_path)


def _transcribe_local(audio_path):
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        raise RuntimeError(
            "未安装本地转写库，请先在 douyin venv 执行 pip install faster-whisper；"
            "或设 TRANSCRIBE_MODE=api 并提供 WHISPER_API_KEY")
    import gc
    size = os.environ.get("WHISPER_SIZE", "base")
    # 优先用本地模型目录（国内网络拉不到 HF/Xet 时必备）；目录内含 model.bin 才生效
    local_dir = os.environ.get("WHISPER_MODEL_DIR") or os.path.join(
        WORKSPACE, "models", "faster-whisper-base")
    if os.path.isdir(local_dir) and os.path.exists(os.path.join(local_dir, "model.bin")):
        model_path = local_dir
        info(f"本地模型目录: {model_path}")
    else:
        model_path = size  # 回退到 HF hub 按 size 下载

    # 尝试加载模型（带重试：首次 mkl 内存不足时 gc 回收后重试一次）
    for attempt in range(2):
        try:
            gc.collect()
            model = WhisperModel(model_path, device="cpu", compute_type="int8")
            break
        except Exception as e:
            if attempt == 0 and "allocate" in str(e).lower():
                print(f"[WARN] Whisper 模型加载内存不足，尝试释放内存后重试… ({e})")
                gc.collect()
                continue
            raise
    segments, _ = model.transcribe(audio_path, language="zh", beam_size=3)
    return "\n".join(s.text for s in segments).strip()


def _extract_json(text):
    """从模型输出里抠出第一个 JSON 对象。"""
    text = text.strip()
    # 去 ```json 围栏
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if m:
        text = m.group(1)
    if not text.startswith("{"):
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if m:
            text = m.group(0)
    return json.loads(text)


# 画面 OCR 引擎（全局缓存，避免批量模式每条视频重复加载模型）
_OCR_ENGINE = None


def _get_ocr_engine():
    """懒加载并缓存 RapidOCR 引擎。"""
    global _OCR_ENGINE
    if _OCR_ENGINE is None:
        from rapidocr_onnxruntime import RapidOCR
        _OCR_ENGINE = RapidOCR()
    return _OCR_ENGINE


def extract_frames_ocr(video_path, max_frames=12):
    """抽关键帧并用本地 OCR 识别画面文字（字幕/板书/截图文字）。

    依赖 opencv-python-headless + rapidocr-onnxruntime；任一缺失则降级返回空串，
    绝不影响语音转写主链路。OCR 引擎全局缓存复用。
    """
    try:
        import cv2
    except Exception:
        warn("未安装 opencv-python-headless，跳过画面 OCR")
        return ""
    try:
        engine = _get_ocr_engine()
    except Exception as e:
        warn(f"未加载 RapidOCR（跳过画面 OCR）: {e}")
        return ""

    step(f"[{os.path.basename(video_path)}] 抽取画面关键帧并 OCR…")
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return ""
    fps = cap.get(cv2.CAP_PROP_FPS) or 25
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if total <= 0:
        cap.release()
        return ""
    # 均匀抽取（含首帧），位置去重
    positions = sorted(set([0] + [int(total * (i + 0.5) / max_frames) for i in range(max_frames)]))
    texts = []
    seen = set()
    for idx in positions:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, frame = cap.read()
        if not ok or frame is None:
            continue
        h, w = frame.shape[:2]
        if w > 1280:
            scale = 1280.0 / w
            frame = cv2.resize(frame, (1280, int(h * scale)))
        try:
            result, _ = engine(frame)
        except Exception:
            continue
        if not result:
            continue
        for item in result:
            txt = item[1] if isinstance(item, (list, tuple)) and len(item) > 1 else ""
            txt = (txt or "").strip()
            if len(txt) < 2:
                continue
            if txt in seen:
                continue
            seen.add(txt)
            texts.append(txt)
    cap.release()
    ocr_text = "\n".join(texts)
    info(f"[{os.path.basename(video_path)}] 画面 OCR 提取到 {len(texts)} 段文字（{len(ocr_text)} 字）")
    return ocr_text


def ocr_images(image_paths):
    """对一组本地图片做本地 OCR（图文笔记链路）。复用 RapidOCR 引擎，返回合并文字。"""
    try:
        engine = _get_ocr_engine()
    except Exception as e:
        warn(f"未加载 RapidOCR（跳过图片 OCR）: {e}")
        return ""
    try:
        import cv2
    except Exception:
        warn("未安装 opencv-python-headless，跳过图片 OCR")
        return ""
    texts = []
    seen = set()
    for p in image_paths:
        try:
            img = cv2.imread(p)
        except Exception:
            continue
        if img is None:
            continue
        try:
            result, _ = engine(img)
        except Exception:
            continue
        if not result:
            continue
        for item in result:
            txt = item[1] if isinstance(item, (list, tuple)) and len(item) > 1 else ""
            txt = (txt or "").strip()
            if len(txt) < 2:
                continue
            if txt in seen:
                continue
            seen.add(txt)
            texts.append(txt)
    ocr_text = "\n".join(texts)
    info(f"[图文] 图片 OCR 提取到 {len(texts)} 段文字（{len(ocr_text)} 字）")
    return ocr_text


def analyze(transcript, client, ocr_text=""):
    model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
    tags_str = "、".join(PRESET_TAGS)
    system = (
        "你是「视频知识提炼师」。任务：把一段视频（抖音/网页）的语音转写与画面文字，"
        "压成一张逻辑严密、可直接复用的结构化认知笔记。\n\n"
        "# 输入\n"
        "- 【语音文稿】：视频里说的话的转写。\n"
        "- 【画面文字】：视频画面、字幕、PPT、图片里识别出的文字（非语音）。\n"
        "- 两者都有就综合提炼；只有画面文字就以画面为主；只有语音就按语音。\n\n"
        "# 内容类型判断（输出前先在心里给视频分类，决定 viewpoints / actions 的『分工逻辑』）\n"
        "视频只有三类，分工逻辑完全不同：\n"
        "- 【观点型】（表达观点/态度）→ viewpoints = 主张（按视频原顺序逐条）；actions 通常留空（无明确步骤时禁止凑数）。\n"
        "- 【方法/路线/步骤型】（教一套做法 / 制定计划）→ 这是用户最反感的重复坑，按下述『分层』分工：\n"
        "    · viewpoints = WHY 层：『每一步为什么这么做 / 背后的判断 / 它解决什么根本问题』，是分析洞察层，不是步骤清单。例：『前一个月系统学LLM基础，因为这是后续所有项目的根基，跳过则实践悬空』。\n"
        "    · actions   = HOW 层：把同一套做法落成『可勾选的具体动作』，祈使句/动词开头。例：『第1个月：系统学LLM基础；第2-3个月：做2个端到端项目』。\n"
        "    · 两者讲同一套做法，但一个说『为什么』一个说『怎么做』，是互补不是重复。\n"
        "- 【疑问型】（回应一个真问题）→ viewpoints = 拆解问题的多角度；actions = 如何验证/试一下。\n\n"
        "⚠️ 字段分工铁律（用户已多次反馈方法型视频 viewpoints 与 actions 逐字重复，请严防）：\n"
        "  - 区分维度是『层』不是『句式』：viewpoints 谈原理/判断，actions 谈动作，角度必须不同。\n"
        "  - 禁止 actions 把 viewpoints 的内容换种说法再说一遍；也禁止 viewpoints 退化成『第1步做X、第2步做Y』的步骤复述（那是 actions 的活）。\n"
        "  - 方法型视频里『教什么』天然等于『做什么』，必须用上面的 WHY/HOW 分层切开，不能靠换句式硬分。\n\n"
        "# 字段契约（严格输出此 JSON，不多不少）\n"
        "1. title（必填，≤15字）：素材的『命名』——用名词短语概括主题/范畴，像给文件起名，"
        "不要写成完整句子。例：『纳指标普指数基金挑选指南』『Obsidian 高阶用法』。\n"
        "2. main_line（必填，一句话）：这条视频的『一句话内核』，是站在山顶俯瞰全片后收拢出的那一句总括。"
        "三态皆可：\n"
        "   · 主张型（视频在表达一个观点）：写主张，如『职业想象与现实体验存在明显落差』\n"
        "   · 方法型（视频在教一套做法）：写方法，如『选指数基金看额度、误差、成本、规模四要素』\n"
        "   · 疑问型（视频在回应一个真问题）：写疑问，如『怎么用现有框架拼出能用的 Skill 而非从零写？』\n"
        "   ⚠️ 铁律：main_line 必须与下面的 viewpoints 明显不同——viewpoints 是『拆开的多条论据』，"
        "main_line 是『把所有论据收拢后的总括』。禁止写成 viewpoints 里任何一条的复述、简化或换汤不换药；"
        "也禁止写成 title 的复述（title 是命名，main_line 是内容精华）。\n"
        "3. viewpoints（必填，字符串数组）：视频的『分解论据』，每条一句话，只写论断/判断，不展开说明、不写操作细节。**句式**：判断句/名词短语，不要祈使句。\n"
        "   · 完整性优先于简洁：务必覆盖视频里每一条独立的核心论点，漏掉重要主张比略显紧凑更严重；视频出现的关键场景/工具/名词/数据（如 PRD、竞品分析、70/20/10 比例）必须作为论断的一部分保留，不能为了精简而丢。\n"
        "   · 观点型：按视频原论证顺序逐条写核心主张，保留前因后果但不展开案例说明。\n"
        "   · 方法/步骤型：写『每一步为什么这么做 / 背后的判断』（WHY 层），一句话点透即可；视频里的关键做法名词可保留为论断成分，但『怎么做』的操作细节留给 actions，不要在核心观点里铺开教操作。\n"
        "   · 疑问型：拆解问题的多个角度。\n"
        "4. conclusion（可选，一句话）：仅当有一条凌驾于 viewpoints 之上的总结性结论才填；"
        "若已并入 viewpoints 或 main_line 则为空字符串，不要重复。\n"
        "5. scenarios（可选，字符串数组）：视频『明确』给出了适用场景才填；"
        "视频没说就留空数组，宁可空也不要凑。\n"
        "6. tags（必填，1-4个）：只能从预设里选："
        + tags_str + "。\n"
        "7. actions（可选，字符串数组）：视频『明确』给出了可落地行动才填；没说就留空数组，宁可空也不要凑。"
        "方法/步骤型视频里它就是『具体步骤清单』（HOW 层）：祈使句/动词开头，允许展开、允许举例、允许说明执行方式；"
        "它是对 viewpoints 的具体化——同样的关键词可以再次出现（视角必须是『动作』而非『论断』），但禁止把 viewpoints 已经写过的原话换种说法再说一遍，必须给出『下一步我可以怎么做』的增量信息。\n\n"
        "# 反模式（绝对不要做）\n"
        "- ❌ main_line 写成 viewpoints 里某条的简化版（这就是重复，必须避免）。\n"
        "- ❌ 所有视频都硬写成『如何…？』问句（教学/观点视频本不是问句，三态皆可）。\n"
        "- ❌ scenarios/actions 凑数填『可用于相关场景』这类空话。\n"
        "- ❌ 观点型视频里 viewpoints 重排成『重要程度排序』而非『视频原顺序』。\n"
        "- ❌ 方法型视频里 viewpoints 退化成『步骤清单』（那是 actions 的活），或 actions 把 viewpoints 的『为什么』换种说法再说一遍（用户已多次反馈，请严防）。\n"
        "- ❌ 核心观点把『怎么做』的操作步骤铺开教（如一步步写操作指引），导致行动建议只能重复照搬；核心观点只给论断本体+关键名词，操作展开一律留给行动建议——但视频里的关键场景/工具/数据仍须保留在论断里，不能为了避重复而丢内容。\n\n"
        "# 输出格式\n"
        "只输出一个 JSON 对象，字段与上面一一对应。根据内容丰度二选一：\n"
        "  A. 内容简短（≤2句或仅1个观点）：viewpoints 写 1 条（把结论并入），"
        "actions 写 1 条（把场景并入），conclusion 和 scenarios 留空，不要重复。\n"
        "  B. 内容较丰富：viewpoints/conclusion/scenarios/actions 尽量填实，有几条写几条，绝不硬凑。\n"
        "不要任何解释，只输出 JSON。"
    )
    parts = []
    if transcript:
        parts.append(f"【语音文稿】\n{transcript}")
    if ocr_text:
        parts.append(f"【画面文字】\n{ocr_text}")
    if not parts:
        parts.append("（无可用内容）")
    user = "\n\n".join(parts) + "\n\n请按上述要求输出 JSON。"
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "system", "content": system},
                  {"role": "user", "content": user}],
        response_format={"type": "json_object"},
    )
    return _extract_json(resp.choices[0].message.content)


# ─── 组装笔记 + 写库 + 归档 ────────────────────────────────────────────────────────
def build_note(url, analysis, meta=None, created_at=None):
    meta = meta or {}
    now = int(time.time() * 1000)
    ca = created_at or now
    tags = [t for t in analysis.get("tags", []) if t in PRESET_TAGS]
    # 组装可读 note（多行字符串，前端原样显示）
    lines = []
    cq = analysis.get("main_line")
    if cq:
        lines.append("主线")
        lines.append(cq)
        lines.append("")
    vps = analysis.get("viewpoints") or []
    if vps:
        lines.append("核心观点")
        for v in vps:
            lines.append(f"· {v}")
        lines.append("")
    if analysis.get("conclusion"):
        lines.append("结论")
        lines.append(analysis["conclusion"])
        lines.append("")
    sc = analysis.get("scenarios") or []
    if sc:
        lines.append("适用场景")
        for s in sc:
            lines.append(f"· {s}")
        lines.append("")
    ac = analysis.get("actions") or []
    if ac:
        lines.append("行动建议")
        for a in ac:
            lines.append(f"· {a}")
        lines.append("")
    note = "\n".join(lines).strip()

    is_douyin = "douyin" in (url or "").lower() or "iesdouyin" in (url or "").lower()
    return {
        "gid": str(uuid.uuid4()),
        "title": analysis.get("title") or (url or "抖音素材"),
        "url": url or "",
        "note": note,
        "tags": tags,
        "source": "douyin" if is_douyin else "web",
        "status": "pending",          # 引擎消化出的笔记默认「待消化」，浏览器端标记后才转已消化
        "author": meta.get("author") or "",
        "authorId": meta.get("authorId") or "",
        "publishDate": meta.get("publishDate") or "",
        "contentId": meta.get("contentId") or "",
        "canonicalUrl": meta.get("canonicalUrl") or "",
        "createdAt": ca,
        "updatedAt": now,
    }


def inject_learn_note(note):
    master = load_master()
    master.setdefault("data", {}).setdefault(LEARN_STORE, {})[note["gid"]] = note
    master["updatedAt"] = int(time.time() * 1000)
    save_master(master)
    return note["gid"]


def slugify(s):
    s = re.sub(r"[^\w一-鿿]+", "-", s or "note")
    return s.strip("-")[:30] or "note"


def archive_markdown(note, transcript="", ocr_text=""):
    os.makedirs(ARCHIVE_DIR, exist_ok=True)
    day = datetime.now().strftime("%Y-%m-%d")
    path = os.path.join(ARCHIVE_DIR, f"{day}-{slugify(note['title'])}.md")
    lines = [f"# {note['title']}", ""]
    src_bits = []
    if note.get("author"):
        src_bits.append(f"博主: @{note['author']}")
    if note.get("publishDate"):
        src_bits.append(f"发布: {note['publishDate']}")
    if note.get("url"):
        src_bits.append(f"链接: {note['url']}")
    if src_bits:
        lines.append("> " + " ｜ ".join(src_bits))
        lines.append("")
    lines.append(note.get("note") or "")
    lines.append("")
    if note.get("tags"):
        lines.append("标签: " + " / ".join(note["tags"]))
        lines.append("")
    if transcript:
        lines += ["---", "", "## 原始转写", "", transcript, ""]
    if ocr_text:
        lines += ["---", "", "## 画面文字（OCR）", "", ocr_text, ""]
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return path


# ─── 单条处理 ────────────────────────────────────────────────────────────────────
def process_one(url, args, redfox_key):
    """处理一条抖音链接 → 写库 + 归档。成功返回结果 dict；失败抛异常。"""
    url = (url or "").strip()
    if not url:
        raise ValueError("空链接")
    video_path = None
    tmp_files = []
    ocr_text = ""                       # 画面 OCR 文字（无视频/缺依赖时为空）
    meta = {}                           # 来源元数据（博主/发布日期/作品ID/规范链接）
    parsed_title = None                 # 红狐解析到的原标题（用于直接写库时兜底标题）

    # 1) 取得内容文件（视频 或 图文笔记的图片）
    is_image_note = False
    if args.file:
        video_path = args.file
        step(f"[{url}] 使用本地视频: {video_path}")
    elif not args.skip_download:
        real = resolve_real_url(url) if url.startswith("http") else url
        step(f"[{url}] 解析链接: {real}")
        dl_info = None
        # 主用：红狐
        if redfox_key:
            dl_info = redfox_parse(real, redfox_key)
            if dl_info["success"]:
                step(f"[{url}] 红狐解析成功")
            else:
                warn(f"[{url}] 红狐解析失败: {dl_info.get('error')}，尝试云霆兜底")
        # 兜底：云霆（红狐未配置或失败）
        if not dl_info or not dl_info["success"]:
            yk = os.environ.get("YUNTTS_API_KEY")
            if yk:
                dl_info = yuntts_parse(url, yk)   # 喂原始短链，yuntts 内部短链优先、长链兜底
                if dl_info["success"]:
                    step(f"[{url}] 云霆兜底解析成功")
                else:
                    warn(f"[{url}] 云霆兜底也失败: {dl_info.get('error')}")
            elif not redfox_key:
                raise RuntimeError("缺少红狐 API Key（--redfox-key 或 REDFOX_API_KEY）且未配置云霆 YUNTTS_API_KEY")
        if not dl_info or not dl_info["success"]:
            raise RuntimeError(f"解析失败（红狐+云霆均失败）: {dl_info.get('error') if dl_info else '无可用解析源'}")
        if dl_info.get("title"):
            step(f"[{url}] 标题: {dl_info['title']}")
            parsed_title = dl_info["title"]

        # 来源元数据 + 去重：同一作品（同 content_id 或同规范化链接）已消化过则跳过
        meta = {
            "author": dl_info.get("author") or "",
            "authorId": dl_info.get("author_id") or "",
            "publishDate": dl_info.get("publishDate") or "",
            "contentId": dl_info.get("content_id") or "",
            "canonicalUrl": real,
        }
        cid = dl_info.get("content_id")
        existing = find_existing_learn_note(cid, real, url)
        force_gid = None
        force_created_at = None
        if existing:
            if not args.force:
                who = " / ".join([x for x in (existing.get("author"),
                                               existing.get("publishDate")) if x])
                info(f"[{url}] 检测到该作品已消化过（来源：{who or '未知'}），跳过重复消化")
                return {"ok": True, "dup": True,
                        "title": existing.get("title"),
                        "author": existing.get("author"),
                        "publishDate": existing.get("publishDate"),
                        "existing_gid": existing.get("gid"),
                        "url": url}
            # --force：覆盖已存在笔记（复用 gid 避免新增重复；保持原 createdAt；updatedAt 由 build_note 刷新以触发前端 LWW）
            force_gid = existing.get("gid")
            force_created_at = existing.get("createdAt")
            info(f"[{url}] --force 模式：将覆盖已存在笔记 gid={(force_gid or '')[:8]}")
        if dl_info["type"] == "image":
            # 图文笔记：下载图片 → 本地 OCR 图片文字（无语音转写）
            is_image_note = True
            step(f"[{url}] 检测到图文笔记，下载图片并 OCR 画面文字…")
            image_paths = []
            for idx, img_url in enumerate(dl_info.get("images", [])):
                ip = tempfile.mktemp(suffix=".jpg")
                if download_file(img_url, ip):
                    image_paths.append(ip)
                    tmp_files.append(ip)
                else:
                    warn(f"[{url}] 第 {idx + 1} 张图片下载失败")
            if not image_paths:
                raise RuntimeError("图文笔记未取到任何图片，无法做 OCR 提炼")
            ocr_text = ocr_images(image_paths)
            info(f"[{url}] 图文 OCR 完成（{len(ocr_text)} 字）")
        else:
            # 视频：下载无水印视频
            fd, video_path = tempfile.mkstemp(suffix=".mp4")
            os.close(fd)
            tmp_files.append(video_path)
            step(f"[{url}] 下载无水印视频中…")
            if not download_file(dl_info["download_url"], video_path):
                raise RuntimeError("下载失败")
            info(f"[{url}] 视频已下载")

    # 2) 取得文稿（视频走语音转写；图文笔记无语音，ocr_text 已在第 1 步得到）
    transcript = None
    if is_image_note:
        step(f"[{url}] 图文笔记无需语音转写，直接以图片 OCR 文字送分析")
    elif args.transcript_file:
        with open(args.transcript_file, "r", encoding="utf-8") as f:
            transcript = f.read().strip()
        step(f"[{url}] 已读取文稿（{len(transcript)} 字），跳过下载/转写")
    elif args.skip_download:
        raise RuntimeError("--skip-download 需要配合 --transcript-file 提供文稿")
    else:
        wav_path = video_path + ".wav"
        tmp_files.append(wav_path)
        step(f"[{url}] 抽取音频…")
        extract_audio(video_path, wav_path)
        # 趁临时视频还在，抽帧+OCR 识别画面文字（缺依赖则降级，不影响语音链路）
        try:
            ocr_text = extract_frames_ocr(video_path)
        except Exception as e:
            warn(f"[{url}] 画面 OCR 失败（不影响语音链路）: {e}")
        # 抽取完音频后立刻删临时视频，降低峰值磁盘占用
        if video_path in tmp_files:
            try:
                os.remove(video_path)
                tmp_files.remove(video_path)
                info(f"[{url}] 已清理临时视频，仅保留音频待转写")
            except OSError:
                pass
        step(f"[{url}] 本地 Whisper 转写中（中文）…")
        transcript = transcribe(wav_path)
        # 转写完立刻删临时音频，仅留文本
        if wav_path in tmp_files:
            try:
                os.remove(wav_path)
                tmp_files.remove(wav_path)
                info(f"[{url}] 已清理临时音频，仅保留文本")
            except OSError:
                pass
        info(f"[{url}] 转写完成（{len(transcript)} 字）")

    # 3) 分析 or 直接当 note
    if args.skip_llm:
        warn(f"[{url}] 跳过 LLM 分析，文稿直接作为笔记内容")
        now = int(time.time() * 1000)
        is_douyin = "douyin" in url.lower() or "iesdouyin" in url.lower()
        note = {
            "gid": str(uuid.uuid4()),
            "title": (url or "抖音素材")[:15],
            "url": url,
            "note": transcript or "",
            "tags": [],
            "source": "douyin" if is_douyin else "web",
            "author": meta.get("author") or "",
            "authorId": meta.get("authorId") or "",
            "publishDate": meta.get("publishDate") or "",
            "contentId": meta.get("contentId") or "",
            "canonicalUrl": meta.get("canonicalUrl") or "",
            "createdAt": now,
            "updatedAt": now,
        }
    else:
        step(f"[{url}] AI 提炼观点中（DeepSeek）…")
        client = make_chat_client()
        analysis = analyze(transcript, client, ocr_text)
        note = build_note(url, analysis, meta)
        if force_gid:
            note["gid"] = force_gid
            if force_created_at:
                note["createdAt"] = force_created_at

    # 4) 写库 + 归档
    gid = inject_learn_note(note)
    info(f"[{url}] 已写入 master.json → learn_notes (gid={gid[:8]})")
    md = archive_markdown(note, transcript if not args.skip_llm else "", ocr_text)
    info(f"[{url}] 已归档 Markdown: {md}")

    # 清理临时文件
    for t in tmp_files:
        try:
            os.remove(t)
        except OSError:
            pass

    return {"ok": True, "gid": gid, "title": note["title"],
            "tags": note.get("tags", []), "archive": md, "url": url}


# ─── 批量读取 ────────────────────────────────────────────────────────────────────
def read_urls_file(path):
    """每行一个链接；# 开头或空行跳过。"""
    urls = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            urls.append(s)
    return urls


# ─── 主流程 ──────────────────────────────────────────────────────────────────────
def main():
    p = argparse.ArgumentParser(description="抖音收藏 → 认知笔记 深度提炼")
    p.add_argument("--url", help="抖音分享链接（v.douyin.com 短链或视频页链接）")
    p.add_argument("--file", help="本地视频文件路径（跳过下载）")
    p.add_argument("--transcript-file", help="直接提供文稿文件（跳过下载+转写）")
    p.add_argument("--redfox-key", help="红狐 API Key（覆盖环境变量）")
    p.add_argument("--batch-urls-file", help="批量模式：每行一个抖音链接的文本文件")
    p.add_argument("--fail-log", help="批量模式：把失败的链接写到该文件")
    p.add_argument("--skip-download", action="store_true",
                   help="跳过下载/解析（配合 --transcript-file 做测试）")
    p.add_argument("--skip-llm", action="store_true",
                   help="跳过转写与分析，直接用文稿当 note（测试写库）")
    p.add_argument("--force", action="store_true",
                   help="强制重消化已存在 URL 的笔记（覆盖旧记录，不新增重复）")
    args = p.parse_args()

    redfox_key = args.redfox_key or os.environ.get("REDFOX_API_KEY")

    # 批量模式
    if args.batch_urls_file:
        if not os.path.exists(args.batch_urls_file):
            err(f"批量文件不存在: {args.batch_urls_file}")
            sys.exit(2)
        urls = read_urls_file(args.batch_urls_file)
        if not urls:
            err("批量文件里没有有效链接")
            sys.exit(2)
        step(f"批量模式：共 {len(urls)} 条，开始串行处理…")
        ok_list, fail_list = [], []
        for i, u in enumerate(urls, 1):
            print(f"\n===== [{i}/{len(urls)}] {u} =====")
            try:
                r = process_one(u, args, redfox_key)
                ok_list.append(u)
                info(f"✓ 成功: {r['title']}")
            except Exception as e:
                fail_list.append((u, str(e)))
                err(f"✗ 失败: {e}")
                continue
        # 汇总
        print("\n" + "=" * 56)
        print(f"批量完成：成功 {len(ok_list)} 条 / 失败 {len(fail_list)} 条")
        if fail_list:
            print("失败明细：")
            for u, e in fail_list:
                print(f"  - {u}\n      {e}")
            if args.fail_log:
                with open(args.fail_log, "w", encoding="utf-8") as f:
                    for u, _ in fail_list:
                        f.write(u + "\n")
                info(f"失败链接已写入: {args.fail_log}")
        sys.exit(0)

    # 单条模式
    if not args.url and not args.file:
        err("请提供 --url / --file，或 --batch-urls-file 批量处理")
        sys.exit(2)
    try:
        r = process_one(args.url or "", args, redfox_key)
    except Exception as e:
        err(f"处理失败: {e}")
        sys.exit(1)
    print(json.dumps(r, ensure_ascii=False, indent=2))
    # 供 server.py /api/digest 读取结构化结果（按 gid 精准取回写入的笔记）
    try:
        _rf = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'digest_result.json')
        with open(_rf, 'w', encoding='utf-8') as _f:
            json.dump(r, _f, ensure_ascii=False)
    except Exception:
        pass
    sys.exit(0)


if __name__ == "__main__":
    main()
