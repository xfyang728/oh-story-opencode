#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""check-name-collision.py — 新角色/势力重名检查（v3 新增）

用途
    长篇续写里最容易被四道脚本门漏掉的硬伤是**重名**：起了一个名字，而这个名字在原著里
    已经属于另一个有戏份的角色。实测踩过：续写把「沈青」当作小世界丹师/丹铺东家，
    而该名在原著出现 167 次，是精英班班主任，且她在本批章节的同一个场景里就应当在场。

    style-metrics / check-ai-patterns / check-degeneration / check-outline-copy 都不查名字，
    所以这一步必须单独做，且必须在**落笔之前**做。

用法
    py check-name-collision.py --book <对标书目录> 名字1 名字2 ...
    py check-name-collision.py --book <对标书目录> --from-outline ../大纲/细纲_第467章.md
    py check-name-collision.py --book <对标书目录> --allow 沈青 陆真 名字3   # 白名单：确认复用既有角色

参数
    --book <dir>        拆文库/对标书目录（含 角色/ 与 原文/）
    --from-outline <f>  从细纲里抽取「人物关系/出场顺序」等节里的候选名（可选，替代位置参数）
    --allow <name...>   明确允许复用的既有角色名（确认它本来就是这本书的角色）
    --min-hits <n>      原文命中多少次算"已存在"，默认 1

退出码
    0 = 全部安全；1 = 存在重名需改名；2 = 参数或路径错误

判定
    · 命中 角色/{名}.md            → 既有角色（存量，必须 --allow 或改名）
    · 原文全文命中 >= min-hits 次  → 疑似既有角色/既有事物，一律按重名处理
    · 都未命中                     → 安全，可作新角色名

口径提示
    建议**只检查具名角色/势力**，一次性路人（"药铺掌柜"这类）不必进检查，
    否则会淹没在常用词里（"掌柜""执事""少年"必然在原文出现）。
"""

import argparse
import re
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:  # pragma: no cover
    pass

# 细纲里可能含候选名的表头关键词
OUTLINE_SECTION_RE = re.compile(r"(人物关系|出场顺序|出场人物|角色|新增人物)")
# 候选名：2-4 个汉字，且不像普通名词（用停用词过滤）
STOPWORDS = {
    "主角", "反派", "配角", "路人", "弟子", "长老", "执事", "掌柜", "少年", "少女",
    "男子", "女子", "众人", "对方", "此人", "那人", "这伙", "他们", "她们", "自己",
    "阵法", "丹药", "门派", "宗门", "家族", "势力", "世界", "大陆", "城池", "坊市",
    "一条", "两人", "三人", "众人", "全场", "台上", "台下", "远处", "近处",
}


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def collect_outline_names(outline: Path) -> list:
    """从细纲的「人物关系/出场顺序」等小节抽候选具名角色。

    两种形态都收：
      ① 引号包裹的名字（如 “沈青”）
      ② 该小节内的裸写 2-4 字中文块（细纲常写成「出场顺序：沈青→顾长风→武天」）
    ②必然带噪声（"目标情绪"这类也会被切出来），但候选名清单是给人过目的，
    宁可多报也不漏报——漏报的代价是撞名进正文。
    """
    names = []
    text = read_text(outline)
    in_section = False
    for line in text.split("\n"):
        if re.match(r"^#{1,4}\s", line):
            in_section = bool(OUTLINE_SECTION_RE.search(line))
            if not in_section:
                continue
        # 细纲的出场名单多半是裸行「- 出场顺序：丹堂执事→沈青→霍青→武天」，
        # 并不总落在带关键词的小节标题下，所以「行内含关键词」也直接解析。
        if not in_section and not OUTLINE_SECTION_RE.search(line):
            continue
        body = re.sub(r"^[-\s*]+", "", line)
        body = re.split(r"[：:]", body, maxsplit=1)[-1]
        for m in re.findall(r"[“\"「『]([\u4e00-\u9fa5]{2,4})[”\"」』]", body):
            names.append(m)
        for chunk in re.split(r"[、，,／/→\-—\s（）()\[\]【】|]+", body):
            chunk = chunk.strip()
            if 2 <= len(chunk) <= 4 and re.fullmatch(r"[\u4e00-\u9fa5]+", chunk):
                names.append(chunk)
    return names


def check(book: Path, names: list, allow: set, min_hits: int) -> int:
    role_dir = book / "角色"
    role_names = set()
    if role_dir.is_dir():
        role_names = {p.stem for p in role_dir.glob("*.md")}

    # 原文全文（可能很大，只读一次；文件不存在则跳过该维度）
    origin_text = ""
    origin_path = book / "原文" / "原文.txt"
    if origin_path.is_file():
        origin_text = read_text(origin_path)
    else:
        alt = sorted((book / "原文").glob("*.txt")) if (book / "原文").is_dir() else []
        origin_text = "\n".join(read_text(p) for p in alt)

    bad = 0
    print(f"对标书：{book}")
    print(f"既有角色档：{len(role_names)} 个；原文可用：{'是' if origin_text else '否'}")
    print()
    for name in names:
        if not name or name in STOPWORDS:
            continue
        if name in allow:
            print(f"  [允许]  {name}  —— 已确认是本书既有角色，按复用处理")
            continue
        in_role = name in role_names
        hits = origin_text.count(name) if origin_text else 0
        if in_role or hits >= min_hits:
            bad += 1
            why = []
            if in_role:
                why.append(f"角色/{name}.md 已存在")
            if hits:
                why.append(f"原文出现 {hits} 次")
            print(f"  [重名]  {name}  —— {'；'.join(why)}。**必须改名并回写细纲**")
        else:
            print(f"  [安全]  {name}  —— 未在角色档与原文中出现，可作新角色名")
    print()
    if bad:
        print(f"结论：{bad} 个候选名撞车。改名后重跑本检查再落笔。")
        return 1
    print("结论：无重名，可落笔。")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        prog="check-name-collision.py",
        description="新角色/势力重名检查（对标书既有角色与原文双向比对）",
    )
    ap.add_argument("--book", required=True, help="对标书目录（含 角色/ 与 原文/）")
    ap.add_argument("--from-outline", metavar="FILE", help="从细纲抽取候选名")
    ap.add_argument("--min-hits", type=int, default=1, help="原文命中多少次算已存在（默认 1）")
    ap.add_argument("--allow", metavar="NAME", help="明确允许复用的既有角色名（逗号/空格分隔，可重复传）")
    ap.add_argument("names", nargs="*", help="候选新角色/势力名")
    args, extra = ap.parse_known_args()

    book = Path(args.book)
    if not book.is_dir():
        print(f"对标书目录不存在：{book}", file=sys.stderr)
        return 2

    # `names` 是 nargs="*"，会吞掉一切位置参数——包括 `--allow a b` 里的 b 与裸写的细纲路径。
    # 这里用 parse_known_args 的 extra 兜住，再按 allow / .md 路径回认，避免"白名单吃掉候选名"。
    raw_names = list(args.names) + [x for x in extra if not x.startswith("--")]
    if not args.from_outline:
        for cand in list(raw_names):
            if cand.endswith(".md") and Path(cand).is_file():
                args.from_outline = cand
                raw_names.remove(cand)
                break

    allow = set()
    if args.allow:
        for part in re.split(r"[,\s]+", args.allow):
            if part:
                allow.add(part)

    names = [n for n in raw_names if n not in allow]
    if args.from_outline:
        outline = Path(args.from_outline)
        if not outline.is_file():
            print(f"细纲不存在：{outline}", file=sys.stderr)
            return 2
        names.extend(collect_outline_names(outline))

    if not names and not allow:
        print("没有候选名可查（给位置参数、--from-outline，或 --allow）", file=sys.stderr)
        return 2
    if not names:
        print(f"候选名全部在 --allow 白名单内：{', '.join(sorted(allow))}")
        print("结论：无重名，可落笔（均为确认复用的既有角色）。")
        return 0

    # 去重保序
    seen = set()
    uniq = [n for n in names if not (n in seen or seen.add(n))]
    return check(book, uniq, allow, args.min_hits)


if __name__ == "__main__":
    sys.exit(main())
