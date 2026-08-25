#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""verify_gates.py — chapter-extractor 产物的可机械校验硬门控（story-long-analyze Stage 2）

用途
    对 章节/第N章_摘要.md 逐文件执行 SKILL.md「可机械校验的硬门控」四项检查，
    主线程落盘后直接运行（或由 fixer lane prompt 附带的 verify_gates 步骤调用），
    不依赖 agent 自报。任一文件 FAIL 即退出码 1。

接口
    py verify_gates.py <章节目录或单个摘要md>...
    （参数可混合：目录会展开为其下全部 .md；可一次传多个路径）

检查项（与 SKILL.md 硬门控一致）
    1. 情节点数 N = 匹配 ^P[0-9]+ （行首）的行数，N >= 10
    2. 「基调：」（全角冒号）出现次数必须 == N
       —— 少于 N = 有情节点漏「基调：」或漏全角冒号（下游 Stage 6 按全角 grep 会静默漏章）
    3. 基调值去重后 ⊆ {紧张,轻松,悲伤,热血,爽,甜,温馨,恐怖,压抑,其他}
    4. 主题标签值（去掉「主题标签」前缀与可选冒号）⊆
       {爱情,亲情,友情,权力,金钱,成长,复仇,悬念,搞笑,热血,日常,其他}；
       出现「主题标签：」带冒号、或值为基调词均判失败

输出
    逐文件 [PASS]/[FAIL] + 原因清单；末尾汇总；任一 FAIL 退出码 1。

纯标准库；开头重配 stdout 为 UTF-8；兼容 Windows py launcher。
"""

import re
import sys
from pathlib import Path

# TextIOWrapper.reconfigure 为 CPython 3.7+ 运行时方法，静态检查器误报
sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]

PLOT_POINT_RE = re.compile(r"^P[0-9]+ ", re.M)
TONE_VALUE_RE = re.compile(r"基调：([^ |\n]+)")
THEME_VALUE_RE = re.compile(r"主题标签[：]?([^ |\n：]+)")

MIN_PLOT_POINTS = 10

ALLOWED_TONES = {"紧张", "轻松", "悲伤", "热血", "爽", "甜", "温馨", "恐怖", "压抑", "其他"}
ALLOWED_THEMES = {
    "爱情", "亲情", "友情", "权力", "金钱", "成长",
    "复仇", "悬念", "搞笑", "热血", "日常", "其他",
}


def check_file(path):
    """单文件门控：返回 (passed: bool, reasons: list[str])。"""
    reasons = []
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return False, [f"无法读取文件：{exc}"]

    # 1. 情节点数
    n_pp = len(PLOT_POINT_RE.findall(text))
    if n_pp < MIN_PLOT_POINTS:
        reasons.append(f"情节点数 N={n_pp} < {MIN_PLOT_POINTS}")

    # 2. 全角「基调：」次数 == N
    n_tone_mark = text.count("基调：")
    if n_tone_mark != n_pp:
        reasons.append(
            f"「基调：」出现 {n_tone_mark} 次 ≠ 情节点数 {n_pp}"
            f"（有情节点漏基调行或漏全角冒号）"
        )

    # 3. 基调值枚举
    tone_values = TONE_VALUE_RE.findall(text)
    bad_tones = sorted(set(tone_values) - ALLOWED_TONES)
    if bad_tones:
        reasons.append(f"基调值超出枚举：{'、'.join(bad_tones)}")
    if len(tone_values) != n_tone_mark:
        reasons.append("存在「基调：」后无有效值的空基调行")

    # 4a. 主题标签带冒号即失败
    if "主题标签：" in text:
        reasons.append("出现带冒号的「主题标签：」（应为无冒号的 主题标签X）")

    # 4b. 主题标签值枚举 + 禁止基调独有词
    #     「热血」「其他」同时存在于基调/主题两枚举（output-templates.md Stage 2），
    #     作主题值合法；只有基调独有词（紧张/轻松/悲伤/爽/甜/温馨/恐怖/压抑）
    #     出现在主题位才算主题/基调混用。
    theme_values = THEME_VALUE_RE.findall(text)
    if not theme_values and n_pp > 0:
        reasons.append("未提取到任何主题标签值")
    bad_themes = sorted(set(theme_values) - ALLOWED_THEMES)
    if bad_themes:
        reasons.append(f"主题标签值超出枚举：{'、'.join(bad_themes)}")
    tone_only_words = ALLOWED_TONES - ALLOWED_THEMES
    tone_like = sorted(set(theme_values) & tone_only_words)
    if tone_like:
        reasons.append(f"主题标签出现基调词（主题/基调混用）：{'、'.join(tone_like)}")

    return (not reasons), reasons


def expand_targets(raw_paths):
    """把命令行路径展开为待检文件列表。

    目录模式只取 第N章_摘要.md（*_摘要.md）——硬门控对象是 chapter-extractor
    产物；同目录下的 第N章_深度拆解.md / 汇总文件不在门控范围。单文件模式照检。
    """
    files = []
    for raw in raw_paths:
        p = Path(raw)
        if p.is_dir():
            files.extend(sorted(p.glob("*_摘要.md")))
        elif p.is_file():
            files.append(p)
        else:
            print(f"[SKIP] 路径不存在：{p}")
    return files


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if not args:
        print("用法：py verify_gates.py <章节目录或单个摘要md>...")
        return 2

    files = expand_targets(args)
    if not files:
        print("没有可检查的 .md 文件")
        return 2

    passed = failed = 0
    for f in files:
        ok, reasons = check_file(f)
        if ok:
            passed += 1
            print(f"[PASS] {f}")
        else:
            failed += 1
            print(f"[FAIL] {f}")
            for r in reasons:
                print(f"       - {r}")

    print(f"\n汇总：共 {len(files)} 文件 | PASS {passed} | FAIL {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
