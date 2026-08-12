"""一次性脚本：给已存在的 08-10 融合页补「看见」段（前6段不动）。

用法：python append_seeing.py --date 2026-08-10
逻辑：
  1. 读本地缓存拿到「看见」内容（已是第5版·事实行+叙事标杆风）
  2. 在 Notion 找到该日同名页面
  3. 防重复：读页面现有块，若已有「看见」段头则跳过
  4. 只把「看见」三块（段头quote + 内容paragraph + 空行）追加到末尾
"""
import sys
import argparse

sys.path.insert(0, r'G:\_06_项目代码\工作台\workspace\tools')
import daily_fusion as df
import notion_common as nc


def page_has_seeing(page_id, token):
    """读页面块，判断是否已有「看见」段头（防重复追加）。"""
    res, _ = nc.api_call('GET', f'/blocks/{page_id}/children', token,
                         body=None)
    for blk in res.get('results', []):
        if blk.get('type') != 'quote':
            continue
        txt = ''.join(t.get('plain_text', '')
                      for t in blk.get('quote', {}).get('rich_text', []))
        if txt.strip() == '看见':
            return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--date', required=True)
    args = ap.parse_args()
    date = args.date

    # 1) 缓存拿「看见」内容
    cache = df.load_cache(date)
    if not cache:
        print('本地无缓存，请先 --fresh 跑一次日中融合')
        return
    title = cache['title']
    seeing = cache['sections'].get('看见', [])
    if isinstance(seeing, list):
        items = [str(x).strip() for x in seeing if str(x).strip()]
    else:
        items = [str(seeing).strip()] if seeing else []
    if not items:
        print('缓存里「看见」为空，不追加')
        return
    print(f'缓存「看见」内容（{len(items)} 行）：')
    for x in items:
        print('  •', x)

    # 2) 定位页面（按日期查，不靠标题匹配——老页面标题与新版缓存标题可能不同）
    token, db_id = nc.load_config()
    if not token:
        print('no token')
        return
    page_id = nc.query_existing(db_id, token, date, name_match=None)
    if not page_id:
        print(f'未在 Notion 找到 {date} 页面（按日期查无结果），中止')
        return
    print(f'找到页面 page_id={page_id}')

    # 3) 防重复
    if page_has_seeing(page_id, token):
        print('该页面已有「看见」段，跳过（不重复追加）')
        return

    # 4) 只拼「看见」三块并追加
    blocks = []
    blocks.append(nc.block_quote_title('看见'))
    blocks.extend(nc.block_paragraphs(items))
    blocks.append(nc.block_empty())
    nc.append_blocks(page_id, token, blocks)
    print(f'已追加「看见」段（{len(blocks)} 块）到 {date} 页面末尾，前6段未改动')


if __name__ == '__main__':
    main()
