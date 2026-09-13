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
    py style_stats.py metrics <原文文件|目录> [...] [--json OUT] [--min-chars N] [--no-chapter-heads]

输出字段（book；stdout 为人读摘要，--json OUT 写全量 JSON）
    chapters                   章节摘要文件数
    plot_points                情节点总数
    avg_per_ch                 章均情节点
    tone_dist                  基调分布（占全部情节点 %）
    theme_top                  主题标签 Top4
    intra_switch_rate          章内相邻情节点基调不同次数 / 章内相邻对总数
    other_attribution_warning  「其他」基调占比 >15% 时的归因提示（E2），否则 null
    chapter_mode_sequence      每章众数基调（并列取章内最早出现）

输出字段（metrics；供 style-profile-protocol.md「写作指标带」与 scripts/style-metrics.js 消费）
    chars                      非空白字符数（**不含**章节标题行，但**含**面板行）
    dialogue_ratio             对话字数占比（弯引号/角引号/直引号内的字符 / chars）
    bang_per_kilo              感叹号密度（每千字）
    question_per_kilo          问号密度（每千字）
    ellipsis_per_kilo          省略号密度（每千字）
    dash_per_kilo              破折号密度（每千字；正文硬安全线，正常应为 0）
    scene_cuts                 场次切分符次数（独立成行的 ... / … / *** / ---）
    panel_per_kilo             面板行密度（每千字；整行【】计一行）
    avg_para_len / para_count  正文段平均长度 / 段数
    short_para_ratio           段长 <15 字的段落占比（%）
    long_para_ratio            段长 >30 字的段落占比（%）
    ge60_para_ratio            **段长 ≥60 字的段落占比（%）——长尾主指标**
    para_bucket_ratio          段落分桶占比：le8 / 8_15 / 15_25 / 25_40 / 40_60 / ge60
    median_para_len            **段长中位数**
    p90_para_len               **段长 P90（长尾刻度）**
    max_para_len               **最长段字数**
    multi_beat_para_ratio      **单段 ≥4 个句号级单句的段落占比（%，"主语延续式"代理）**
    long_para_samples          多拍长段样例（按段长倒序，最多 8 条）
    narrator_explain_ratio     叙述者解释句占比（%，启发式；见 NARRATOR_MARKERS）
    numeric_in_quote_per_kilo  引号内**阿拉伯数字**串密度（每千字；中文数字不计）
    indent_style / indent_ratio 缩进形态（fullwidth-2 / none / mixed）与占比
    quote_style                引号体系（curly “” / corner 「」 / ascii " \" / mixed / none）
    chapter_heads              **原文文件**里识别到的章节标题行数（未按 --min-chars 过滤）
    files / skipped            实际统计的文件数与跳过项

口径说明
    · 对话占比按「引号区间的字符数 / 非空白字符数」计；引号体系自动识别，不要求统一。
    · **章节标题行不计入 chars**：它是元信息不是正文。多章拼接文件（如 `461-463.txt`）
      会带 3+ 个标题行，不排除会稀释密度类指标。`--no-chapter-heads` 只决定是否把标题行
      计入段长/句长统计，`chars` 恒不含标题行。
    · `numeric_in_quote_per_kilo` 只数阿拉伯数字。原作惯用中文数字（"两千个名额"），
      该值为 0 属正常，**不代表"原作者不用数字说话"**——判读时请读原文而非只看数值。
    · `narrator_explain_ratio` 是启发式，只用于「只卡上限」的软门，不参与 blocking；
      标记词表偏保守（宁漏不误报），**绝对值会系统性偏低**，只用于趋势对比，
      命中样例可在 `--json` 的 `narrator_samples` 里回查。
    · `scene_cuts` 只数显式切分符。原作若靠视角硬切而不写切分符，该值天然为 0，
      下游 style-metrics.js 会把 0 判为 `advisory/not-applicable`，不当作偏离。



口径（与 SKILL.md 硬检查、output-templates.md Stage 2 模板一致）
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

# ---- metrics 子命令用的正则与常量 ----

CHAPTER_HEAD_RE = re.compile(r"^\s*第\s*[0-9一二三四五六七八九十百千零两]+\s*章")
PANEL_RE = re.compile(r"^\s*【[^】]*】\s*$")
PANEL_ANY_RE = re.compile(r"【[^】]*】")
# 场次切分符：独立成行、且不是 Markdown 表格/列表
# 场次切分符形态（v4，A1）：只认三点 `...`，不把中文省略号 `……` 当切分符——
# `……` 独立成行会同时进 scene_cuts 与 ellipsis 密度（双计），导致二者互相打架。
# 实测本书作者：切分符用 `...`（7处/3章，不进省略号密度），`……` 只作对话语气（5处/3章）。
DIVIDER_RE = re.compile(r"^\s*(?:\.{3,}|[．·]{3,}|[\*\-—_]{3,})\s*$")
CURLY_PAIR_RE = re.compile(r"[\u201c][^\u201d]*[\u201d]")
CORNER_PAIR_RE = re.compile(r"[\u300c][^\u300d]*[\u300d]")
ASCII_PAIR_RE = re.compile(r'"[^"\n]*"')
# 叙述者解释句（启发式）：只用于「只卡上限」的软门
NARRATOR_MARKERS = [
    "他知道", "她知道", "他明白", "她明白", "他清楚", "她清楚",
    "不禁想", "心知", "心中暗道", "这才意识到", "终于明白", "忽然明白",
    "仿佛在说", "仿佛在提醒", "或许这就是", "这就是",
]
SENT_SPLIT_RE = re.compile(r"[。！？!?…]+")


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def _is_body_line(line: str) -> bool:
    """正文行判定：排除章节标题与【】面板行以外的空行由调用方处理。"""
    return not CHAPTER_HEAD_RE.match(line) and not PANEL_RE.match(line)


def text_metrics(text: str, keep_chapter_heads: bool = False) -> dict:
    """对一段原文/正文做确定性写作指标统计。纯标准库，无第三方依赖。"""
    raw_lines = text.split("\n")
    chapter_heads = sum(1 for ln in raw_lines if CHAPTER_HEAD_RE.match(ln))
    panel_lines = sum(1 for ln in raw_lines if PANEL_RE.match(ln))

    body = []
    for ln in raw_lines:
        if not ln.strip():
            continue
        if CHAPTER_HEAD_RE.match(ln):
            if keep_chapter_heads:
                body.append(ln)
            continue
        body.append(ln)

    # 非空白字符数（含面板行内的字符，因为面板也是读者读到的字）
    chars = sum(1 for c in text if not c.isspace())
    chars = max(chars, 1)

    joined = "\n".join(body)
    no_panel = "\n".join(ln for ln in body if not PANEL_RE.match(ln))

    # ---- 引号体系与对话占比 ----
    n_curly = len(CURLY_PAIR_RE.findall(joined))
    n_corner = len(CORNER_PAIR_RE.findall(joined))
    n_ascii = len(ASCII_PAIR_RE.findall(joined))
    kinds = [k for k, n in (("curly", n_curly), ("corner", n_corner), ("ascii", n_ascii)) if n]
    if not kinds:
        quote_style = "none"
    elif len(kinds) == 1:
        quote_style = kinds[0]
    else:
        quote_style = "mixed:" + "+".join(kinds)

    dialogue_chars = 0
    for rx in (CURLY_PAIR_RE, CORNER_PAIR_RE, ASCII_PAIR_RE):
        for m in rx.findall(joined):
            dialogue_chars += sum(1 for c in m if not c.isspace())

    # 引号内数字串
    numeric_in_quote = 0
    for rx in (CURLY_PAIR_RE, CORNER_PAIR_RE, ASCII_PAIR_RE):
        for m in rx.findall(joined):
            numeric_in_quote += len(re.findall(r"[0-9０-９]+", m))

    # ---- 标点密度 ----
    def per_kilo(n: int) -> float:
        return round(n / chars * 1000, 2)

    bang = joined.count("！") + joined.count("!")
    question = joined.count("？") + joined.count("?")
    ellipsis = len(re.findall(r"…+", joined))
    dash = len(re.findall(r"——|—|--+", joined))

    scene_cuts = sum(1 for ln in body if DIVIDER_RE.match(ln))

    # ---- 段落长度 ----
    paras = [ln.strip() for ln in body if ln.strip() and not DIVIDER_RE.match(ln)]
    para_lens = [len(re.sub(r"\s", "", p)) for p in paras]
    para_count = len(para_lens) or 1
    avg_para_len = round(sum(para_lens) / para_count, 2) if para_lens else 0.0
    short_para_ratio = round(100 * sum(1 for n in para_lens if n < 15) / para_count, 1)
    long_para_ratio = round(100 * sum(1 for n in para_lens if n > 30) / para_count, 1)

    # ---- 缩进形态 ----
    indent_full = sum(1 for p in paras if p.startswith("\u3000\u3000"))
    indent_none = sum(1 for p in paras if not p.startswith(("\u3000", " ")))
    indent_ratio = round(100 * indent_full / para_count, 1)
    if indent_full and not indent_none:
        indent_style = "fullwidth-2"
    elif indent_none and not indent_full:
        indent_style = "none"
    elif not indent_full and not indent_none:
        indent_style = "other"
    else:
        indent_style = "mixed"

    # ---- 叙述者解释句（启发式，只用于软门）----
    # 先剔除引号区间：台词里的"他知道""这就是"是人物说话，不是叙述者解释。
    plain = PANEL_ANY_RE.sub("", no_panel)
    for rx in (CURLY_PAIR_RE, CORNER_PAIR_RE, ASCII_PAIR_RE):
        plain = rx.sub("", plain)
    sents = [s for s in SENT_SPLIT_RE.split(plain) if s.strip()]
    narrator_samples = []
    for s in sents:
        seg = s.strip()
        if any(mk in seg for mk in NARRATOR_MARKERS):
            narrator_samples.append(seg[:40])
    sent_count = len(sents) or 1
    narrator_explain_ratio = round(100 * len(narrator_samples) / sent_count, 1)

    # ---- 段落长尾分桶（长段才是"读起来累"的真正来源）----
    # avg / short_ratio / long_ratio(>30) 会把长尾抹平：60+ 字段在样本里只占 1%-6%，
    # 但正是它们决定"读起来像不像本书"。实测某书作者最长段 66 字、60+ 段仅 1.4%，
    # 而 AI 续写最长段 108 字、60+ 段 5.7%——平均值几乎看不出差别。
    def bucket_of(n: int) -> str:
        if n < 8:
            return "le8"
        if n < 15:
            return "8_15"
        if n < 25:
            return "15_25"
        if n < 40:
            return "25_40"
        if n < 60:
            return "40_60"
        return "ge60"

    para_buckets = {k: 0 for k in ("le8", "8_15", "15_25", "25_40", "40_60", "ge60")}
    for n in para_lens:
        para_buckets[bucket_of(n)] += 1
    para_bucket_ratio = {k: round(100 * v / para_count, 1) for k, v in para_buckets.items()}
    sorted_lens = sorted(para_lens)
    median_para_len = sorted_lens[len(sorted_lens) // 2] if sorted_lens else 0
    p90_para_len = sorted_lens[min(int(len(sorted_lens) * 0.9), len(sorted_lens) - 1)] if sorted_lens else 0
    max_para_len = sorted_lens[-1] if sorted_lens else 0

    # ---- 多拍长段（"主语延续式"AI 指纹的机械代理）----
    # 一段里堆 >=4 个句号级单句，等于把 4 个镜头塞进一段。作者通常一拍一段。
    # 只统计**叙述段**：台词换人、连说多句是对话常态，不算 AI 指纹（否则误报一片）。
    BEAT_RE = re.compile(r"[。！？!?]|…{2,}")

    def quoted_ratio(p: str) -> float:
        q = 0
        for rx in (CURLY_PAIR_RE, CORNER_PAIR_RE, ASCII_PAIR_RE):
            for m in rx.findall(p):
                q += len(re.sub(r"\s", "", m))
        total = len(re.sub(r"\s", "", p)) or 1
        return q / total

    multi_beat_lens = []
    for p in paras:
        if quoted_ratio(p) >= 0.5:  # 台词占一半以上 → 视为对话段，跳过
            continue
        beats = len(BEAT_RE.findall(p))
        if beats >= 4:
            multi_beat_lens.append((len(re.sub(r"\s", "", p)), beats, p.strip()[:24]))
    narrative_para_count = sum(1 for p in paras if quoted_ratio(p) < 0.5) or 1
    multi_beat_para_ratio = round(100 * len(multi_beat_lens) / narrative_para_count, 1)
    long_para_samples = [
        f"{ln}字/{bt}拍：{head}" for ln, bt, head in
        sorted(multi_beat_lens, reverse=True)[:8]
    ]

    return {
        "chars": chars,
        "dialogue_ratio": round(100 * dialogue_chars / chars, 1),
        "bang_per_kilo": per_kilo(bang),
        "question_per_kilo": per_kilo(question),
        "ellipsis_per_kilo": per_kilo(ellipsis),
        "dash_per_kilo": per_kilo(dash),
        "scene_cuts": scene_cuts,
        "panel_per_kilo": per_kilo(panel_lines),
        "panel_lines": panel_lines,
        "para_count": para_count,
        "avg_para_len": avg_para_len,
        "short_para_ratio": short_para_ratio,
        "long_para_ratio": long_para_ratio,
        "ge60_para_ratio": para_bucket_ratio["ge60"],
        "para_bucket_ratio": para_bucket_ratio,
        "median_para_len": median_para_len,
        "p90_para_len": p90_para_len,
        "max_para_len": max_para_len,
        "multi_beat_para_ratio": multi_beat_para_ratio,
        "long_para_samples": long_para_samples,
        "narrator_explain_ratio": narrator_explain_ratio,
        "narrator_samples": narrator_samples[:15],
        "numeric_in_quote_per_kilo": per_kilo(numeric_in_quote),
        "indent_style": indent_style,
        "indent_ratio": indent_ratio,
        "quote_style": quote_style,
        "quote_counts": {"curly": n_curly, "corner": n_corner, "ascii": n_ascii},
        "chapter_heads": chapter_heads,
        "sentence_count": len(sents),
    }


def collect_metrics(targets, min_chars: int = 0, keep_chapter_heads: bool = False) -> dict:
    """targets 为文件或目录列表；目录递归取 .txt/.md。返回聚合指标。"""
    files, skipped = [], []
    for t in targets:
        p = Path(t)
        if p.is_dir():
            found = sorted([q for q in p.rglob("*") if q.suffix.lower() in (".txt", ".md")])
            if not found:
                skipped.append(f"{p}（目录内无 .txt/.md）")
            files.extend(found)
        elif p.is_file():
            files.append(p)
        else:
            skipped.append(f"{p}（不存在）")

    total_chars = 0
    agg = Counter()
    merged_samples = []
    weights = {}
    text_all = []
    for f in files:
        try:
            text = _read_text(f)
        except OSError as exc:
            skipped.append(f"{f}（读取失败：{exc}）")
            continue
        if len(re.sub(r"\s", "", text)) < min_chars:
            skipped.append(f"{f}（字符数低于 --min-chars {min_chars}）")
            continue
        text_all.append(text)
        m = text_metrics(text, keep_chapter_heads=keep_chapter_heads)
        total_chars += m["chars"]
        for k in ("dialogue_ratio", "bang_per_kilo", "question_per_kilo", "ellipsis_per_kilo",
                  "dash_per_kilo", "scene_cuts", "panel_per_kilo", "panel_lines",
                  "para_count", "avg_para_len", "short_para_ratio", "long_para_ratio",
                  "narrator_explain_ratio", "numeric_in_quote_per_kilo", "chapter_heads",
                  "sentence_count"):
            agg[k] += m[k]
        weights.setdefault("quote_style", Counter())[m["quote_style"]] += m["chars"]
        weights.setdefault("indent_style", Counter())[m["indent_style"]] += m["chars"]
        merged_samples.extend(m["narrator_samples"])

    # 密度类与比率类由合并文本统一重算（等价于按字符加权，避免短文件被放大）；
    # 计数类（chapter_heads 等）用逐文件求和，与合并重算一致。
    merged = text_metrics("\n".join(text_all), keep_chapter_heads=keep_chapter_heads) if text_all else {}
    result = dict(merged)
    result["files"] = [str(f) for f in files]
    result["skipped"] = skipped
    result["chapter_heads"] = agg["chapter_heads"]
    if merged:
        result["narrator_samples"] = merged_samples[:15]
        for axis in ("quote_style", "indent_style"):
            counter = weights.get(axis) or Counter()
            if len(counter) == 1:
                result[axis] = next(iter(counter))
            elif counter:
                result[axis] = "mixed(" + ", ".join(f"{k}:{v}" for k, v in counter.most_common()) + ")"
    return result



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


METRIC_ORDER = [
    ("chars", "非空白字符数"),
    ("dialogue_ratio", "对话字数占比 %"),
    ("bang_per_kilo", "感叹号 /千字"),
    ("question_per_kilo", "问号 /千字"),
    ("ellipsis_per_kilo", "省略号 /千字"),
    ("dash_per_kilo", "破折号 /千字（正文应为 0）"),
    ("scene_cuts", "场次切分符次数"),
    ("panel_per_kilo", "面板行 /千字"),
    ("para_count", "段数"),
    ("avg_para_len", "平均段长（字）"),
    ("median_para_len", "段长中位数（字）"),
    ("p90_para_len", "段长 P90（字）"),
    ("max_para_len", "最长段（字）"),
    ("short_para_ratio", "段长<15字占比 %"),
    ("long_para_ratio", "段长>30字占比 %"),
    ("ge60_para_ratio", "段长≥60字占比 %（长尾主指标）"),
    ("multi_beat_para_ratio", "单段≥4拍占比 %（主语延续式代理）"),
    ("narrator_explain_ratio", "叙述者解释句占比 %（软门）"),
    ("numeric_in_quote_per_kilo", "引号内数字 /千字"),
    ("chapter_heads", "章节标题行数"),
    ("sentence_count", "句子数"),
]


def cmd_metrics(args):
    stats = collect_metrics(args.targets, min_chars=args.min_chars,
                            keep_chapter_heads=not args.no_chapter_heads)
    if not stats.get("files"):
        print("没有可统计的文件", file=sys.stderr)
        for s in stats.get("skipped", []):
            print(f"  跳过：{s}", file=sys.stderr)
        return 1
    print(f"metrics 样本文件 {len(stats['files'])} 个")
    if len(stats["files"]) <= 8:
        for f in stats["files"]:
            print(f"  · {f}")
    for s in stats.get("skipped", []):
        print(f"  跳过：{s}")
    print()
    for key, label in METRIC_ORDER:
        if key in stats:
            print(f"{label:<28} {stats[key]}")
    for axis in ("quote_style", "indent_style"):
        if axis in stats:
            print(f"{axis:<28} {stats[axis]}")
    if stats.get("para_bucket_ratio"):
        print("\n段落分桶（段长占比 %）：")
        for k in ("le8", "8_15", "15_25", "25_40", "40_60", "ge60"):
            print(f"  {k:<8} {stats['para_bucket_ratio'][k]}")
    if stats.get("long_para_samples"):
        print("\n多拍长段样例（按段长倒序，最多 8 条；定位要拆段的段落）：")
        for s in stats["long_para_samples"]:
            print(f"  - {s}")
    if stats.get("narrator_samples"):
        print("\n叙述者解释句样例（最多 15 条，供人工复核是否为误报）：")
        for s in stats["narrator_samples"]:
            print(f"  - {s}")
    if args.json:
        out = Path(args.json)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n[json] 已写入 {out}")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="style_stats.py",
        description="拆文库统一口径文风统计（book 单书 / compare 跨书对比 / metrics 正文指标）",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_book = sub.add_parser("book", help="单书统计")
    p_book.add_argument("book_dir", help="拆文库书目目录（含 章节/ 子目录）")
    p_book.add_argument("--json", metavar="OUT", help="将全量统计写入 JSON 文件")
    p_book.set_defaults(func=cmd_book)

    p_cmp = sub.add_parser("compare", help="跨书对比矩阵（≥2 个书目目录）")
    p_cmp.add_argument("book_dirs", nargs="+", help="拆文库书目目录列表")
    p_cmp.set_defaults(func=cmd_compare)

    p_m = sub.add_parser("metrics", help="正文写作指标（对话占比/标点密度/段长/场次/引号体系）")
    p_m.add_argument("targets", nargs="+", help="原文或正文文件，或包含它们的目录")
    p_m.add_argument("--json", metavar="OUT", help="将全量指标写入 JSON 文件")
    p_m.add_argument("--min-chars", type=int, default=0,
                     help="单个文件低于该字符数则跳过（默认 0，不过滤）")
    p_m.add_argument("--no-chapter-heads", action="store_true",
                     help="统计时不把章节标题行计入正文行")
    p_m.set_defaults(func=cmd_metrics)

    args = parser.parse_args(argv)
    if args.cmd == "compare" and len(args.book_dirs) < 2:
        parser.error("compare 至少需要 2 个书目目录")
    code = args.func(args)
    sys.exit(code or 0)


if __name__ == "__main__":
    main()
