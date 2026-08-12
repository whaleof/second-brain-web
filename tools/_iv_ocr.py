#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抖音视频/图文 -> 画面 OCR 文字 + 语音转写（仅提取文字，不写库）。
复用 douyin_digest.py 的下载/OCR/转写函数。
解析层双源容错：红狐(redfox)主用，失败(积分耗尽/解析失败/网络)自动切 yuntts 兜底。
结果打印 stdout 并落盘 workspace/tools/_iv_ocr_output/<标题>.json
"""
import sys, os, json, tempfile, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import douyin_digest as dd

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_iv_ocr_output")
os.makedirs(OUT_DIR, exist_ok=True)

def slug(s, n=40):
    s = re.sub(r'[\\/:*?"<>|]', "_", s or "untitled")
    return s[:n].strip()

def parse_redfox(real, key):
    """红狐解析，归一化为统一结构。失败返回 success=False。"""
    dl = dd.redfox_parse(real, key)
    if not dl.get("success"):
        return {"success": False, "error": dl.get("error")}
    return {"success": True, "type": dl.get("type"), "title": (dl.get("title") or "").strip(),
            "desc": dl.get("desc") or "", "images": dl.get("images") or [],
            "download_url": dl.get("download_url"), "source": "redfox"}

def parse_yuntts(real, key):
    """yuntts 备用解析，归一化为统一结构。失败返回 success=False。
    响应：code==200 成功，data.data.type '1'=图集 '0'=视频；失败返回 code!=200。"""
    import requests
    try:
        r = requests.post("https://www.yuntts.com/api/v1/tiktok",
                          headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                          json={"url": real}, timeout=30)
        j = r.json()
    except Exception as e:
        return {"success": False, "error": f"yuntts_req_err:{e}"}
    if j.get("code") != 200:
        return {"success": False, "error": f"yuntts_{j.get('code')}:{j.get('message')}"}
    d = (j.get("data") or {}).get("data") or {}
    t = str(d.get("type", ""))
    return {"success": True, "type": "image" if t == "1" else "video",
            "title": (d.get("title") or "").strip(), "desc": "",
            "images": d.get("images") or d.get("pics") or [],
            "download_url": d.get("url") or "", "source": "yuntts"}

url = sys.argv[1].strip()
real = dd.resolve_real_url(url) if url.startswith("http") else url
print("REAL:", real, file=sys.stderr)

api_redfox = os.environ.get("REDFOX_API_KEY")
api_yuntts = os.environ.get("YUNTTS_API_KEY")

# 双源容错：红狐主用 -> 失败(积分耗尽/解析失败/网络)自动切 yuntts
dl = None
if api_redfox:
    dl = parse_redfox(real, api_redfox)
    if dl.get("success"):
        print("SOURCE: redfox", file=sys.stderr)
    else:
        print("REDFOX_FAIL:", dl.get("error"), "-> try yuntts", file=sys.stderr)
if not dl or not dl.get("success"):
    if api_yuntts:
        dl = parse_yuntts(real, api_yuntts)
        if dl.get("success"):
            print("SOURCE: yuntts", file=sys.stderr)
        else:
            print("YUNTTS_FAIL:", dl.get("error"), file=sys.stderr)
if not dl or not dl.get("success"):
    print("ALL_PARSE_FAIL", file=sys.stderr); sys.exit(2)

title = dl["title"] or "untitled"
print("TYPE:", dl.get("type"), "TITLE:", title[:40], file=sys.stderr)

ocr = ""
transcript = ""
desc = dl.get("desc") or ""

if dl["type"] == "image":
    # 图文笔记：下载每张图片 -> 直接 OCR 图片（无音频可转写）
    urls = dl.get("images") or []
    print("IMG_COUNT:", len(urls), file=sys.stderr)
    paths = []
    for i, u in enumerate(urls):
        m = re.search(r"\.(jpg|jpeg|png|webp)(?:[?&#]|$)", u, re.I)
        ext = m.group(1).lower() if m else "jpg"
        fd, ip = tempfile.mkstemp(suffix="." + ext)
        os.close(fd)
        if dd.download_file(u, ip):
            paths.append(ip)
        else:
            try: os.remove(ip)
            except OSError: pass
    if paths:
        ocr = dd.ocr_images(paths)
    for p in paths:
        try: os.remove(p)
        except OSError: pass
else:
    # 视频：下载 -> 抽帧 OCR + 语音转写
    fd, vpath = tempfile.mkstemp(suffix=".mp4")
    os.close(fd)
    if not dd.download_file(dl["download_url"], vpath):
        print("DL_FAIL", file=sys.stderr); sys.exit(2)
    ocr = dd.extract_frames_ocr(vpath, max_frames=28)
    wav = vpath + ".wav"
    try:
        dd.extract_audio(vpath, wav)
        transcript = dd.transcribe(wav)
    except Exception as e:
        print("TRANSCRIBE_ERR:", repr(e), file=sys.stderr)
    for p in (vpath, wav):
        try: os.remove(p)
        except OSError: pass

result = {"url": url, "real_url": real, "title": title, "desc": desc,
           "type": dl.get("type"), "source": dl.get("source"),
           "ocr": ocr, "transcript": transcript}
out_path = os.path.join(OUT_DIR, slug(title) + ".json")
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)
print("SAVED:", out_path, file=sys.stderr)
print(json.dumps(result, ensure_ascii=False))
