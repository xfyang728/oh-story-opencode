# -*- coding: utf-8 -*-
"""
prep_chapters.py — 提取番茄上传用章节数据

从书籍正文目录读取 md 章节文件，输出 chapters.json 供 upload_chapters.js 使用。
源文件格式：首行 `# 第N章 标题`，其余为正文段落。

用法：
  python prep_chapters.py -BookDir "D:\\novel\\<书名>\\正文" -From 3 -To 10 -Out chapters.json
"""
import argparse
import json
import re
from pathlib import Path


def main():
    ap = argparse.ArgumentParser(description="提取章节标题与正文 -> chapters.json")
    ap.add_argument("-BookDir", required=True, help="正文目录，含 第NNN章_标题.md")
    ap.add_argument("-From", type=int, required=True, help="起始章节号（含）")
    ap.add_argument("-To", type=int, required=True, help="结束章节号（含）")
    ap.add_argument("-Out", default="chapters.json", help="输出 JSON 路径")
    args = ap.parse_args()

    book = Path(args.BookDir)
    if not book.is_dir():
        raise SystemExit(f"目录不存在: {book}")

    chapters = []
    for i in range(args.From, args.To + 1):
        files = list(book.glob(f"第{i:03d}章_*.md")) or list(book.glob(f"第{i}章_*.md"))
        if len(files) != 1:
            raise SystemExit(f"第{i}章: 匹配到 {len(files)} 个文件，预期 1 个")
        raw = files[0].read_text(encoding="utf-8")
        lines = raw.split("\n")
        if not lines[0].startswith("# "):
            raise SystemExit(f"{files[0].name}: 首行不是 '# ' 标题")
        title = lines[0].lstrip("# ").strip()
        body = "\n".join(lines[1:]).strip()
        # 清理 markdown 强调残留，保留内容本身
        body = re.sub(r"\*\*(.+?)\*\*", r"\1", body)
        body = re.sub(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", r"\1", body)
        chapters.append({
            "index": i,
            "file": files[0].name,
            "title": title,
            "body": body,
            "body_chars": len(re.sub(r"\s", "", body)),
        })

    out = Path(args.Out)
    out.write_text(json.dumps(chapters, ensure_ascii=False, indent=1), encoding="utf-8")
    for c in chapters:
        print(f"{c['index']:>3} | {c['title']} | 净字数≈{c['body_chars']}")
    print(f"\n{len(chapters)} 章 -> {out}")


if __name__ == "__main__":
    main()
