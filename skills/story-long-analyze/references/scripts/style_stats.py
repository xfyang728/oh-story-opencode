#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""style_stats.py — 拆文库统一口径文风统计脚本（story-long-analyze Stage 6 / 跨书对比）

用途
    从拆文库书目的 章节/第N章_摘要.md 按统一正则口径提取 基调/主题标签/情节点，
    产出单书统计（book）或多书对比矩阵（compare），供 style-profile-generator.md
    Step 3 / Step 4 与「跨书对比模式」直接消费，替代临时手工 grep/python 统计。

接口
    py style_stats.py book <拆文库书目目录> [--json OUT]
    py style_stats.py compare <目录1> <目录2> [...]

输出字段（book；stdout 为人读摘要，--json OUT 写全量 JSON）
    chapters                   章节摘要文件数
    plot_points                情节点总数
    avg_per_ch                 章均情节点
    tone_dist                  基调分布（占全部情节点 %）
    theme_top                  主题标签 Top4
    intra_switch_rate          章内相邻情节点基调不同次数 / 章内相邻对总数
    other_attribution_warning  「其他」基调占比 >15% 时的归因提示（E2），否则 null
    chapter_mode_sequence      每章众数基调（并列取章内最早出现）

口径（与 SKILL.md 硬门控、output-templates.md Stage 2 模板一致）
    基调     基调：([^ |\\n]+)        —— 全角冒号；值不含空格/竖线/换行
    主题标签 主题标签[：]?([^ |\\n：]+)
    情节点   ^P[0-9]+ （MULTILINE）
    章序     文件名前缀 第(\\d+)章 提取章号升序；无法提取章号的文件跳过并计入 skipped_files

E2 归因规则
    任一书「其他」基调占比 >15% 时，other_attribution_warning 给出归因提示；
    compare 模式在矩阵表下追加脚注。未归因前禁止单调分布直接排名。

情绪引擎定性（仅提示，不作判定）
    喜剧缓冲型（轻松独大 + 低切换）/ 高压权谋型（紧张+压抑合计过半）/ 均衡换挡型（高切换 + 缓冲充足）

纯标准库；开头重配 stdout 为 UTF-8；兼容 Windows py launcher。
"""

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

# TextIOWrapper.reconfigure 为 CPython 3.7+ 运行时方法，静态检查器误报
sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]

TONE_RE = re.compile(r"基调：([^ |\n]+)")
THEME_RE = re.compile(r"主题标签[：]?([^ |\n：]+)")
PLOT_POINT_RE = re.compile(r"^P[0-9]+ ", re.M)
CHAPTER_FILE_RE = re.compile(r"^第(\d+)章")

OTHER_RATIO_THRESHOLD = 15.0  # E2：「其他」基调占比告警阈值（%)


def iter_chapter_files(book_dir):
    """返回 [(章号:int, Path)]，按章号升序；无法提取章号的文件计入 skipped。

    只扫描 第N章_摘要.md（黄金三章的 第N章_深度拆解.md 不在统计口径内）。
    """
    ch_dir = Path(book_dir) / "章节"
    if not ch_dir.is_dir():
        raise SystemExit(f"[style_stats] 错误：目录不存在或缺「章节」子目录：{book_dir}")
    named, skipped = [], []
    for p in sorted(ch_dir.glob("*_摘要.md")):
        m = CHAPTER_FILE_RE.match(p.name)
        if m:
            named.append((int(m.group(1)), p))
        else:
            skipped.append(p.name)
    named.sort(key=lambda x: x[0])
    return named, skipped


def parse_chapter(path):
    """单章解析：返回 (情节点数, 基调序列, 主题标签序列)。"""
    text = path.read_text(encoding="utf-8", errors="replace")
    n_pp = len(PLOT_POINT_RE.findall(text))
    tones = TONE_RE.findall(text)
    themes = THEME_RE.findall(text)
    return n_pp, tones, themes


def chapter_mode(tones):
    """章众数基调；并列取章内最早出现者。无基调返回 None。"""
    if not tones:
        return None
    counts = Counter(tones)
    first_idx = {}
    for i, t in enumerate(tones):
        if t not in first_idx:
            first_idx[t] = i
    best = max(counts, key=lambda t: (counts[t], -first_idx[t]))
    return best


def collect_stats(book_dir):
    """单书全量统计，返回 dict（即 --json 的内容）。"""
    named, skipped = iter_chapter_files(book_dir)
    if not named:
        raise SystemExit(f"[style_stats] 错误：「章节」下未找到 第N章_摘要.md：{book_dir}")

    total_pp = 0
    tone_counter = Counter()
    theme_counter = Counter()
    switch_diffs = 0
    switch_pairs = 0
    mode_sequence = []

    for ch_no, path in named:
        n_pp, tones, themes = parse_chapter(path)
        total_pp += n_pp
        tone_counter.update(tones)
        theme_counter.update(themes)
        for a, b in zip(tones, tones[1:]):
            switch_pairs += 1
            if a != b:
                switch_diffs += 1
        mode = chapter_mode(tones)
        if mode is not None:
            mode_sequence.append([ch_no, mode])

    chapters = len(named)
    tone_dist = {t: round(c * 100.0 / total_pp, 1) for t, c in tone_counter.most_common()}
    theme_top = [[t, c] for t, c in theme_counter.most_common(4)]
    switch_rate = round(switch_diffs / switch_pairs, 3) if switch_pairs else 0.0

    warning = None
    other_pct = tone_dist.get("其他", 0.0)
    if other_pct > OTHER_RATIO_THRESHOLD:
        warning = (
            f"「其他」基调占比 {other_pct}% > {OTHER_RATIO_THRESHOLD}%：须先做归因分析"
            f"（典型：【】面板文字等非叙事行混入基调统计），并在对比表加脚注；"
            f"未归因前禁止单调分布直接排名（E2）"
        )

    return {
        "book": Path(book_dir).name,
        "source_dir": str(book_dir),
        "chapters": chapters,
        "plot_points": total_pp,
        "avg_per_ch": round(total_pp / chapters, 1) if chapters else 0.0,
        "tone_dist": tone_dist,
        "theme_top": theme_top,
        "intra_switch_rate": switch_rate,
        "other_attribution_warning": warning,
        "chapter_mode_sequence": mode_sequence,
        "skipped_files": skipped,
    }


def classify_engine(tone_dist, switch_rate):
    """情绪引擎定性参考：据基调配比 + 切换率给提示型标签（非判定）。"""
    tense = tone_dist.get("紧张", 0.0)
    depress = tone_dist.get("压抑", 0.0)
    light = tone_dist.get("轻松", 0.0)
    if light >= 30.0 and switch_rate < 0.45:
        return "喜剧缓冲型"
    if tense + depress >= 50.0:
        return "高压权谋型"
    if switch_rate >= 0.48:
        return "均衡换挡型"
    return "混合型（不足显性特征，仅供参考）"


def print_book(stats):
    print(f"书目：{stats['book']}")
    print(
        f"chapters={stats['chapters']}  plot_points={stats['plot_points']}"
        f"  avg_per_ch={stats['avg_per_ch']}"
    )
    dist = "  ".join(f"{t}{v}%" for t, v in stats["tone_dist"].items())
    print(f"tone_dist: {dist}")
    top = "  ".join(f"{t}{c}" for t, c in stats["theme_top"])
    print(f"theme_top: {top}")
    print(f"intra_switch_rate={stats['intra_switch_rate'] * 100:.1f}%")
    if stats["other_attribution_warning"]:
        print(f"other_attribution_warning: {stats['other_attribution_warning']}")
    seq = " ".join(f"第{ch}章:{m}" for ch, m in stats["chapter_mode_sequence"])
    print(f"chapter_mode_sequence: {seq}")
    if stats["skipped_files"]:
        print(f"skipped_files(无法提取章号): {', '.join(stats['skipped_files'])}")


def cmd_book(args):
    stats = collect_stats(args.book_dir)
    print_book(stats)
    if args.json:
        out = Path(args.json)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"[json] 已写入 {out}")


def cmd_compare(args):
    stats_list = [collect_stats(d) for d in args.book_dirs]

    print("## 跨书对比\n")
    header = "| 书目 | chapters | plot_points | avg_per_ch | 章内切换率 | 引擎提示 |"
    sep = "|------|----------|-------------|------------|-----------|---------|"
    print(header)
    print(sep)
    for s in stats_list:
        engine = classify_engine(s["tone_dist"], s["intra_switch_rate"])
        print(
            f"| {s['book']} | {s['chapters']} | {s['plot_points']} "
            f"| {s['avg_per_ch']} | {s['intra_switch_rate'] * 100:.1f}% "
            f"| {engine} |"
        )
    print("\n（引擎提示仅为切换率+基调配比的定性参考，不作判定）\n")

    # 基调分布对比矩阵（行=基调并集，按全体总量降序）
    all_tones = Counter()
    for s in stats_list:
        all_tones.update({t: v for t, v in s["tone_dist"].items()})
    tone_order = [t for t, _ in all_tones.most_common()]

    print("### 基调分布对比（占各书全部情节点 %）\n")
    books_header = "| 基调 | " + " | ".join(s["book"] for s in stats_list) + " |"
    books_sep = "|------" + "|--------" * len(stats_list) + "|"
    print(books_header)
    print(books_sep)
    for t in tone_order:
        row = "| " + t + " | " + " | ".join(
            f"{s['tone_dist'].get(t, 0.0)}" for s in stats_list
        ) + " |"
        print(row)

    # E2 脚注
    footnotes = [
        s for s in stats_list if s["other_attribution_warning"]
    ]
    if footnotes:
        print()
        for s in footnotes:
            pct = s["tone_dist"].get("其他", 0.0)
            print(f"> \\* {s['book']}「其他」{pct}%：{s['other_attribution_warning']}")

    # 主题标签 Top4 对照
    print("\n### 主题标签 Top4 对照\n")
    print("| 排序 | " + " | ".join(s["book"] for s in stats_list) + " |")
    print("|------" + "|--------" * len(stats_list) + "|")
    depth = max(len(s["theme_top"]) for s in stats_list) if stats_list else 0
    for i in range(depth):
        cells = []
        for s in stats_list:
            if i < len(s["theme_top"]):
                t, c = s["theme_top"][i]
                cells.append(f"{t}{c}")
            else:
                cells.append("—")
        print(f"| {i + 1} | " + " | ".join(cells) + " |")


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="style_stats.py",
        description="拆文库统一口径文风统计（book 单书 / compare 跨书对比）",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_book = sub.add_parser("book", help="单书统计")
    p_book.add_argument("book_dir", help="拆文库书目目录（含 章节/ 子目录）")
    p_book.add_argument("--json", metavar="OUT", help="将全量统计写入 JSON 文件")
    p_book.set_defaults(func=cmd_book)

    p_cmp = sub.add_parser("compare", help="跨书对比矩阵（≥2 个书目目录）")
    p_cmp.add_argument("book_dirs", nargs="+", help="拆文库书目目录列表")
    p_cmp.set_defaults(func=cmd_compare)

    args = parser.parse_args(argv)
    if args.cmd == "compare" and len(args.book_dirs) < 2:
        parser.error("compare 至少需要 2 个书目目录")
    args.func(args)


if __name__ == "__main__":
    main()
