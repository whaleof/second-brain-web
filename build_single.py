#!/usr/bin/env python3
"""构建脚本：把工程打包为单文件 bundle.html

将所有 JS/CSS 内联到 index.html 中，生成一个可独立运行的单文件。
当前主力为模块化结构，此脚本属可选历史工具。

用法:
    python3 build_single.py [输出文件名]

默认输出 bundle.html
"""

import os
import re
import sys

WORKSPACE = os.path.dirname(os.path.abspath(__file__))
OUTPUT = sys.argv[1] if len(sys.argv) > 1 else 'bundle.html'


def read_file(path):
    """读取文件内容"""
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()


def inline_css(html, base_dir):
    """内联 CSS 文件"""
    def replace_css(match):
        href = match.group(1)
        # 去掉版本号查询参数
        href = href.split('?')[0]
        css_path = os.path.join(base_dir, href)
        if os.path.exists(css_path):
            css_content = read_file(css_path)
            return f'<style>\n{css_content}\n</style>'
        return match.group(0)

    return re.sub(r'<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"[^>]*>', replace_css, html)


def inline_js(html, base_dir):
    """内联 JS 文件"""
    def replace_js(match):
        src = match.group(1)
        # 去掉版本号查询参数
        src = src.split('?')[0]
        # 跳过 CDN 引用
        if src.startswith('http'):
            return match.group(0)
        js_path = os.path.join(base_dir, src)
        if os.path.exists(js_path):
            js_content = read_file(js_path)
            return f'<script>\n{js_content}\n</script>'
        return match.group(0)

    return re.sub(r'<script[^>]+src="([^"]+)"[^>]*>\s*</script>', replace_js, html)


def build():
    """构建单文件 bundle"""
    print(f"工作目录: {WORKSPACE}")
    print(f"输出文件: {OUTPUT}")

    # 读取 index.html
    index_path = os.path.join(WORKSPACE, 'index.html')
    if not os.path.exists(index_path):
        print("错误: index.html 不存在")
        sys.exit(1)

    html = read_file(index_path)
    print(f"  读取 index.html ({len(html)} chars)")

    # 内联 CSS
    html = inline_css(html, WORKSPACE)
    print("  ✓ 内联 styles.css")

    # 内联 JS（按顺序）
    js_files = [
        'chart.min.js',
        'db.js',
        'app.js',
        'modules/home.js',
        'modules/plans.js',
        'modules/finance.js',
        'modules/dance.js',
        'modules/internship.js',
        'modules/market.js',
        'modules/timeline.js',
        'modules/weight.js',
        'modules/drinks.js',
        'modules/habits.js',
        'modules/okr.js',
        'modules/ai-daily.js',
        'modules/thoughts.js',
    ]

    for js_file in js_files:
        js_path = os.path.join(WORKSPACE, js_file)
        if os.path.exists(js_path):
            print(f"  ✓ 内联 {js_file}")
        else:
            print(f"  ⚠ 跳过 {js_file} (不存在)")

    html = inline_js(html, WORKSPACE)

    # 移除 Service Worker 注册（单文件模式不需要）
    html = re.sub(
        r'<script>\s*if\(\'serviceWorker\' in navigator\)[\s\S]*?</script>',
        '<!-- SW registration removed in bundle mode -->',
        html
    )
    print("  ✓ 移除 Service Worker 注册")

    # 写入输出文件
    out_path = os.path.join(WORKSPACE, OUTPUT)
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(html)

    print(f"\n完成！{OUTPUT} ({os.path.getsize(out_path)} bytes)")


if __name__ == '__main__':
    build()
