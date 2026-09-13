#!/usr/bin/env node
'use strict';

/**
 * style-metrics.js — 文风偏离门（"必须像谁"）
 *
 * 分工：
 *   check-ai-patterns.js  管「不许写什么」——AI 味的组合句式（blocking）
 *   style-metrics.js      管「必须像谁」——与对标书文风基线的偏离（默认 advisory，可升 blocking）
 * 两者冲突时，blocking 仍归 check-ai-patterns.js；本脚本只在「对话占比/叹号密度/场次/段长」
 * 这类听感指标上给出可执行的偏离判定。
 *
 * 用法：
 *   node style-metrics.js --profile <文风.md> [--baseline <原文文件|目录>] <正文文件...>
 *   node style-metrics.js --profile <文风.md> --baseline <原文...> --backfill
 *   node style-metrics.js --profile <文风.md> --check --fail-on=blocking <正文文件...>
 *
 * 参数：
 *   --profile <path>     文风.md（读「写作指标带」表 + 「作者指纹词」表）
 *   --baseline <path...> 基线样本（原文/已落盘正文）。省略且文件里没有基线时，自动用
 *                        `--baseline` 目录推算（需显式给出，不做隐式猜测）
 *   --tolerance <n>      容差，默认 0.15（±15%）
 *   --quote-mode <s>     仅校验引号体系是否与文风声明一致；取值 curly|corner|ascii
 *   --check              只报告，不写文件（默认行为；保留该开关以便与其它脚本对齐）
 *   --json <out>         输出机器可读 JSON
 *   --fail-on=blocking   仅当出现 blocking 级偏离时退出 1（默认任何偏离都退出 1）
 *   --backfill           把由 --baseline 实测出的基线值写回 --profile（只填空缺项，
 *                        不覆盖已有数值；文风里的口径说明由人写，本脚本只补数字）
 *
 * 判定口径：
 *   下限类（dialogue_ratio / bang_per_kilo / question_per_kilo / scene_cuts /
 *          numeric_in_quote_per_kilo）
 *       value < baseline × (1 - tolerance)  → 偏离（作者的"音量"被压掉了）
 *   上限类（narrator_explain_ratio）
 *       value > baseline × (1 + tolerance)  → 偏离（叙述者解释变多）
 *   双向类（ellipsis_per_kilo / dash_per_kilo / panel_per_kilo / avg_para_len /
 *          short_para_ratio）
 *       任一侧越界 → 偏离（advisory；标点类偏低于基线不算错，标点上浮才算错，
 *       因此标点类实际只卡上限，见 PUNCT_KEYS）
 *   不适用：baseline 为 0 且为计数类（scene_cuts）→ not-applicable，不判偏离。
 *
 * 作者指纹词（白名单）反向校验：
 *   文风.md 的「作者指纹词」表给出每词每万字频次带。脚本统计正文里的实际频次：
 *     · 低于带下限 → **blocking**（作者的母语口癖被净化掉了，这正是续写最典型的漂移）
 *     · 高于带上限 ×2 → advisory（用过头，注意是否在复读）
 *   该检查只在文风文件确实给了频次带时生效；无表或表为空则整体跳过。
 *
 * 依赖：仅 Node 内置模块。中文与全角字符按「字符」计，与 style_stats.py 口径一致。
 */

const fs = require('fs');
const path = require('path');

const USAGE = `Usage:
  node style-metrics.js --profile <文风.md> [--baseline <原文|目录>] <正文文件...>
  node style-metrics.js --profile <文风.md> --baseline <原文|目录> --backfill
  node style-metrics.js --profile <文风.md> --check --fail-on=blocking <正文文件...>

Options:
  --profile <path>      文风.md（读写作指标带 + 作者指纹词）
  --baseline <path...>  基线样本文件或目录（可多个）
  --tolerance <n>       容差，默认 0.15
  --quote-mode <s>      校验引号体系：curly | corner | ascii
  --check               只报告（默认行为）
  --json <out>          写机器可读 JSON
  --fail-on=blocking    仅 blocking 偏离时退出 1；默认任何偏离即退出 1
  --backfill            用基线实测值回填文风.md 的空缺项
  -h, --help            显示本帮助
`;

const DEFAULT_TOLERANCE = 0.15;

// 指标口径：key -> {label, unit, dir, kind}
//   dir: 'min' 只卡下限 | 'max' 只卡上限 | 'both' 双向
//   kind: 'density' 密度类 | 'count' 计数类 | 'ratio' 比率类 | 'length' 长度类
// tier 决定该指标在报告里的**判定强度**（v4 变更，依据 8 章实测）：
//   'hard'  结构性／绝对线——作者本人也不会违反（段落上限、指纹词被清零、引号混用）→ blocking。
//   'voice' 声纹类——叹号/问号/省略号/破折号/对话占比/场次/面板/段长分布。
//           **作者逐章方差极大**（实测变异系数：叹号 68%、破折号 95%、对话 28%），
//           实测「作者刚写的 467-469」会被均值±15%的带判成 blocking 2 处。
//           故一律只判 advisory，且改用**分位带**（P10-P90）而非 ±15%。
//   'soft'  已属 advisory 的项（概叙比）。
//
// 为什么声纹类不能再判 blocking：门要发现的是"作者不会那么写"，不是"作者不常那么写"。
// 8 章实测：±15% 带只能覆盖作者自己 2/8（叹号）、1/8（破折号）——把作者 75%~87%
// 的正常章节判成偏离，门就失去意义了。
const METRICS = {
  dialogue_ratio: { label: '对话字数占比', unit: '%', dir: 'both', kind: 'ratio', tier: 'voice' },
  bang_per_kilo: { label: '感叹号密度', unit: '/千字', dir: 'both', kind: 'density', tier: 'voice' },
  question_per_kilo: { label: '问号密度', unit: '/千字', dir: 'both', kind: 'density', tier: 'voice' },
  ellipsis_per_kilo: { label: '省略号密度', unit: '/千字', dir: 'both', kind: 'density', tier: 'voice' },
  dash_per_kilo: { label: '破折号密度', unit: '/千字', dir: 'both', kind: 'density', tier: 'voice' },
  scene_cuts: { label: '场次切分符', unit: '次', dir: 'both', kind: 'count', tier: 'voice' },
  panel_per_kilo: { label: '面板行密度', unit: '/千字', dir: 'both', kind: 'density', tier: 'voice' },
  avg_para_len: { label: '平均段长', unit: '字', dir: 'both', kind: 'length', tier: 'voice' },
  median_para_len: { label: '段长中位数', unit: '字', dir: 'both', kind: 'length', tier: 'voice' },
  p90_para_len: { label: '段长 P90', unit: '字', dir: 'both', kind: 'length', tier: 'voice' },
  max_para_len: { label: '最长段', unit: '字', dir: 'max', kind: 'length', tier: 'hard' },
  short_para_ratio: { label: '段长≤15字占比', unit: '%', dir: 'both', kind: 'ratio', tier: 'voice' },
  long_para_ratio: { label: '段长>30字占比', unit: '%', dir: 'both', kind: 'ratio', tier: 'voice' },
  ge60_para_ratio: { label: '段长≥60字占比', unit: '%', dir: 'max', kind: 'ratio', tier: 'voice' },
  multi_beat_para_ratio: { label: '单段≥4拍占比', unit: '%', dir: 'max', kind: 'ratio', tier: 'voice' },
  numeric_in_quote_per_kilo: { label: '引号内数字密度', unit: '/千字', dir: 'both', kind: 'density', tier: 'voice' },
  narrator_explain_ratio: { label: '概叙比', unit: '%', dir: 'max', kind: 'ratio', tier: 'soft' },
};

// 分位带回退系数：文风.md 未提供 P10/P90 时，用「基线 × [0.5, 1.6]」这一宽容带。
// 宁可漏报，不要误判作者——偏态重尾分布上用窄带必然天天误报。
const BAND_FALLBACK = { lo: 0.5, hi: 1.6 };

// 段落长尾的**绝对**硬线（不依赖文风基线，任何书都成立）：
//   ≥80 字一段 = 手机上超过 4 行，必然读着累；
//   ≥60 字且 ≥5 拍 = "主语延续式"长段，把多个镜头压进一段，是 AI 续写最典型的段落漂移。
// 实测：某书作者最长段 73 字、60+ 段占 2.2%；AI 续写最长段 108 字、60+ 段占 6.3%，
// 而两者的"平均段长"只差 1.7 字——所以必须有绝对硬线，不能只靠容差门。
const PARA_HARD_MAX = 80;
const PARA_BEAT_MAX = 60;
const PARA_BEAT_COUNT = 5;

// 标点类：偏"少"从来不是问题（去 AI 味本来就在删它们），只有偏"多"才是漂移。
// v4 起它们同时受 tier='voice' 管辖 → 只判 advisory（见 METRICS 注释）。
const PUNCT_KEYS = new Set(['ellipsis_per_kilo', 'dash_per_kilo']);

// advisory 键：由 METRICS 的 tier 决定（v4），不再手工维护两份名单。
// 判定强度映射：tier='hard' → blocking；tier='voice' | 'soft' → advisory。
// 之所以把声纹类整体降为 advisory：作者逐章方差 68%~95%，
// 用它们卡 blocking 会把作者自己的正常章节判成偏离（实测复现）。
function findingLevel(key) {
  const meta = METRICS[key];
  return (meta && meta.tier === 'hard') ? 'blocking' : 'advisory';
}

function die(msg) {
  console.error(msg);
  console.error(USAGE.trimEnd());
  process.exit(2);
}

// ---------------------------------------------------------------- 参数解析

const options = {
  profile: null,
  baseline: [],
  files: [],
  tolerance: DEFAULT_TOLERANCE,
  quoteMode: null,
  json: null,
  failOn: 'all',
  backfill: false,
};

let sawCheck = false;
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  const next = () => {
    const v = process.argv[i + 1];
    if (v === undefined) die(`${arg} requires a value`);
    i += 1;
    return v;
  };
  if (arg === '--profile' || arg.startsWith('--profile=')) {
    options.profile = arg.includes('=') ? arg.slice('--profile='.length) : next();
  } else if (arg === '--baseline' || arg.startsWith('--baseline=')) {
    if (arg.includes('=')) options.baseline.push(arg.slice('--baseline='.length));
    else options.baseline.push(next());
  } else if (arg === '--tolerance' || arg.startsWith('--tolerance=')) {
    const raw = arg.includes('=') ? arg.slice('--tolerance='.length) : next();
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 1) die(`--tolerance must be within [0,1], got: ${raw}`);
    options.tolerance = n;
  } else if (arg === '--quote-mode' || arg.startsWith('--quote-mode=')) {
    const v = arg.includes('=') ? arg.slice('--quote-mode='.length) : next();
    if (!['curly', 'corner', 'ascii'].includes(v)) die(`--quote-mode must be curly|corner|ascii, got: ${v}`);
    options.quoteMode = v;
  } else if (arg === '--json' || arg.startsWith('--json=')) {
    options.json = arg.includes('=') ? arg.slice('--json='.length) : next();
  } else if (arg === '--check') {
    sawCheck = true;
  } else if (arg === '--backfill') {
    options.backfill = true;
  } else if (arg.startsWith('--fail-on=')) {
    const v = arg.slice('--fail-on='.length);
    if (v !== 'blocking' && v !== 'all') die(`--fail-on must be 'blocking' or 'all'`);
    options.failOn = v;
  } else if (arg === '-h' || arg === '--help') {
    process.stdout.write(USAGE);
    process.exit(0);
  } else if (arg.startsWith('-')) {
    die(`Unknown option: ${arg}`);
  } else {
    options.files.push(arg);
  }
}

if (!options.profile) die('--profile <文风.md> is required');
if (!fs.existsSync(options.profile)) die(`profile not found: ${options.profile}`);
if (options.files.length === 0 && !options.backfill) {
  die('no text files provided (pass <正文文件...>, or use --backfill with --baseline)');
}
void sawCheck;

// ---------------------------------------------------------------- 文本指标（与 style_stats.py 同口径）

const CHAPTER_HEAD_RE = /^\s*第\s*[0-9一二三四五六七八九十百千零两]+\s*章/;
const PANEL_RE = /^\s*【[^】]*】\s*$/;
const PANEL_ANY_RE = /【[^】]*】/g;
// 场次切分符形态（v4 变更，A1）：**只认三点 `...`**，不再把中文省略号 `……` 当切分符。
//
// 为什么：`……` 独立成行时会被同时计入 scene_cuts 与 ellipsis 密度（双计），
// 导致"想多切场景就必须推高省略号密度"，二者互相打架。实测本书作者：
//   —— 用 `...`（三点）作切分符：7 处/3章，完全不进省略号密度
//   —— 用 `……`（中文）作语气：5 处/3章，且全在对话/内心
// 而续写端用 `……` 当切分符，被迫在"删切分符"和"省略号超标"之间二选一。
// 切分符形态属排版契约，与引号体系同级，由文风.md 声明（见 style-profile-protocol.md）。
const DIVIDER_RE = /^\s*(?:\.{3,}|[．·]{3,}|[*\-—_]{3,})\s*$/;
const CURLY_PAIR_RE = /[\u201c][^\u201d]*[\u201d]/g;
const CORNER_PAIR_RE = /[\u300c][^\u300d]*[\u300d]/g;
const ASCII_PAIR_RE = /"[^"\n]*"/g;
const SENT_SPLIT_RE = /[。！？!?…]+/;
const NARRATOR_MARKERS = [
  '他知道', '她知道', '他明白', '她明白', '他清楚', '她清楚',
  '不禁想', '心知', '心中暗道', '这才意识到', '终于明白', '忽然明白',
  '仿佛在说', '仿佛在提醒', '或许这就是', '这就是',
];

function countMatches(text, re) {
  const m = text.match(re);
  return m ? m.length : 0;
}

function textMetrics(text) {
  const rawLines = text.split('\n');
  const panelLines = rawLines.filter((ln) => PANEL_RE.test(ln)).length;

  const body = [];
  for (const ln of rawLines) {
    if (!ln.trim()) continue;
    if (CHAPTER_HEAD_RE.test(ln)) continue; // 章节标题是元信息，不计入正文统计
    body.push(ln);
  }

  const joined = body.join('\n');
  // chars：不含标题行、不含段首缩进（缩进是排版不是内容），与 style_stats.py 一致
  let chars = 0;
  for (const ch of body.map((l) => l.replace(/^[\s\u3000]+/, '')).join('\n')) {
    if (!/\s/.test(ch)) chars += 1;
  }
  chars = Math.max(chars, 1);

  const noPanel = body.filter((ln) => !PANEL_RE.test(ln)).join('\n');

  const nCurly = countMatches(joined, CURLY_PAIR_RE);
  const nCorner = countMatches(joined, CORNER_PAIR_RE);
  const nAscii = countMatches(joined, ASCII_PAIR_RE);
  const kinds = [];
  if (nCurly) kinds.push('curly');
  if (nCorner) kinds.push('corner');
  if (nAscii) kinds.push('ascii');
  const quoteStyle = kinds.length === 0 ? 'none' : (kinds.length === 1 ? kinds[0] : `mixed:${kinds.join('+')}`);

  let dialogueChars = 0;
  for (const re of [CURLY_PAIR_RE, CORNER_PAIR_RE, ASCII_PAIR_RE]) {
    const matches = joined.match(new RegExp(re.source, 'g')) || [];
    for (const m of matches) {
      for (const ch of m) if (!/\s/.test(ch)) dialogueChars += 1;
    }
  }

  let numericInQuote = 0;
  for (const re of [CURLY_PAIR_RE, CORNER_PAIR_RE, ASCII_PAIR_RE]) {
    const matches = joined.match(new RegExp(re.source, 'g')) || [];
    for (const m of matches) numericInQuote += countMatches(m, /[0-9０-９]+/g);
  }

  const perKilo = (n) => Math.round((n / chars) * 1000 * 100) / 100;
  const bang = countMatches(joined, /[！!]/g);
  const question = countMatches(joined, /[？?]/g);
  const ellipsis = countMatches(joined, /…+/g);
  const dash = countMatches(joined, /——|—|--+/g);
  const sceneCuts = body.filter((ln) => DIVIDER_RE.test(ln)).length;

  const paras = body.filter((ln) => ln.trim() && !DIVIDER_RE.test(ln));
  const paraLens = paras.map((p) => p.replace(/^[\s\u3000]+/, '').replace(/\s/g, '').length);
  const paraCount = paraLens.length || 1;
  const sum = paraLens.reduce((a, b) => a + b, 0);
  const avgParaLen = Math.round((sum / paraCount) * 100) / 100;
  const shortParaRatio = Math.round((100 * paraLens.filter((n) => n < 15).length / paraCount) * 10) / 10;
  const longParaRatio = Math.round((100 * paraLens.filter((n) => n > 30).length / paraCount) * 10) / 10;

  // ---- 段落长尾（长段才是"读起来累"的真来源；平均值会把它抹平）----
  const sortedLens = [...paraLens].sort((a, b) => a - b);
  const medianParaLen = sortedLens.length ? sortedLens[Math.floor(sortedLens.length / 2)] : 0;
  const p90ParaLen = sortedLens.length
    ? sortedLens[Math.min(Math.floor(sortedLens.length * 0.9), sortedLens.length - 1)] : 0;
  const maxParaLen = sortedLens.length ? sortedLens[sortedLens.length - 1] : 0;
  const ge60ParaRatio = Math.round((100 * paraLens.filter((n) => n >= 60).length / paraCount) * 10) / 10;

  // 只统计叙述段：台词换人、连说多句是对话常态，不算"主语延续式"指纹
  const BEAT_RE = /[。！？!?]|…{2,}/g;
  const quotedRatio = (p) => {
    let q = 0;
    for (const re of [CURLY_PAIR_RE, CORNER_PAIR_RE, ASCII_PAIR_RE]) {
      for (const m of (p.match(new RegExp(re.source, 'g')) || [])) {
        for (const ch of m) if (!/\s/.test(ch)) q += 1;
      }
    }
    const total = p.replace(/\s/g, '').length || 1;
    return q / total;
  };
  const narrativeParas = paras.filter((p) => quotedRatio(p) < 0.5);
  const narrativeCount = narrativeParas.length || 1;
  const longParaSamples = [];
  let multiBeatCount = 0;
  for (const p of narrativeParas) {
    const clean = p.replace(/^[\s\u3000]+/, '').trim();
    const beats = (clean.match(BEAT_RE) || []).length;
    const len = clean.replace(/\s/g, '').length;
    if (beats >= 4) multiBeatCount += 1;
    if (len >= 60 || beats >= PARA_BEAT_COUNT) {
      longParaSamples.push({ len, beats, head: clean.slice(0, 24) });
    }
  }
  longParaSamples.sort((a, b) => b.len - a.len);
  const multiBeatParaRatio = Math.round((100 * multiBeatCount / narrativeCount) * 10) / 10;

  let plain = noPanel.replace(PANEL_ANY_RE, '');
  plain = plain.replace(CURLY_PAIR_RE, '').replace(CORNER_PAIR_RE, '').replace(ASCII_PAIR_RE, '');
  const sents = plain.split(SENT_SPLIT_RE).filter((s) => s.trim());
  const sentCount = sents.length || 1;
  const narratorHits = sents.filter((s) => NARRATOR_MARKERS.some((mk) => s.includes(mk))).length;
  const narratorExplainRatio = Math.round((100 * narratorHits / sentCount) * 10) / 10;

  let indentFull = 0;
  let indentNone = 0;
  for (const p of paras) {
    if (p.startsWith('\u3000\u3000')) indentFull += 1;
    else if (!p.startsWith('\u3000') && !p.startsWith(' ')) indentNone += 1;
  }
  let indentStyle = 'other';
  if (indentFull && !indentNone) indentStyle = 'fullwidth-2';
  else if (indentNone && !indentFull) indentStyle = 'none';
  else if (indentFull && indentNone) indentStyle = 'mixed';

  return {
    chars,
    dialogue_ratio: Math.round((100 * dialogueChars / chars) * 10) / 10,
    bang_per_kilo: perKilo(bang),
    question_per_kilo: perKilo(question),
    ellipsis_per_kilo: perKilo(ellipsis),
    dash_per_kilo: perKilo(dash),
    scene_cuts: sceneCuts,
    panel_per_kilo: perKilo(panelLines),
    para_count: paraCount,
    avg_para_len: avgParaLen,
    median_para_len: medianParaLen,
    p90_para_len: p90ParaLen,
    max_para_len: maxParaLen,
    short_para_ratio: shortParaRatio,
    long_para_ratio: longParaRatio,
    ge60_para_ratio: ge60ParaRatio,
    multi_beat_para_ratio: multiBeatParaRatio,
    long_para_samples: longParaSamples.slice(0, 10),
    narrator_explain_ratio: narratorExplainRatio,
    numeric_in_quote_per_kilo: perKilo(numericInQuote),
    indent_style: indentStyle,
    quote_style: quoteStyle,
    sentence_count: sents.length,
    _raw: { bang, question, ellipsis, dash, panelLines, dialogueChars },
  };
}

function collectFiles(targets) {
  const out = [];
  const skipped = [];
  for (const t of targets) {
    if (!fs.existsSync(t)) {
      skipped.push(`${t}（不存在）`);
      continue;
    }
    const st = fs.statSync(t);
    if (st.isDirectory()) {
      const walk = (dir) => {
        for (const name of fs.readdirSync(dir).sort()) {
          const p = path.join(dir, name);
          const s = fs.statSync(p);
          if (s.isDirectory()) walk(p);
          else if (/\.(txt|md)$/i.test(name)) out.push(p);
        }
      };
      walk(t);
    } else {
      out.push(t);
    }
  }
  return { files: out, skipped };
}

function mergeTexts(files) {
  const parts = [];
  for (const f of files) {
    try {
      parts.push(fs.readFileSync(f, 'utf8'));
    } catch (err) {
      throw new Error(`unable to read ${f}: ${err.message}`);
    }
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------- 文风.md 解析

/**
 * 解析「## 写作指标带」小节的指标表。
 *
 * v3：双层基线（全书兜底 + 滚动准绳）。
 * v4：表可再带两列 `P10` / `P90`（作者逐章分布的分位点）。给了就用它当判定带，
 *     没给则回退「基线 × [0.5, 1.6]」。**分位带是修正误判的关键**——见 METRICS 的 tier 注释。
 */
function parseMetricBaselines(md) {
  const baselines = {};
  const lines = md.split('\n');
  let inSection = false;
  let rollIdx = -1;
  let p10Idx = -1;
  let p90Idx = -1;
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      inSection = /写作指标带/.test(line);
      rollIdx = -1; p10Idx = -1; p90Idx = -1;
      continue;
    }
    if (!inSection) continue;
    // 表头：定位「滚动基线」「P10」「P90」三列（容错 `|` 空格与 `**加粗**` 标记）
    if (/^\s*\|/.test(line) && /键名/.test(line)) {
      const header = line.split('|').map((c) => c.replace(/\*/g, '').trim());
      const find = (re) => { const i = header.findIndex((c) => re.test(c)); return i > 0 ? i : -1; };
      rollIdx = find(/滚动基线/);
      p10Idx = find(/^P10$/i);
      p90Idx = find(/^P90$/i);
      continue;
    }
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*`?([a-z_]+)`?\s*\|(.*)$/);
    if (!m) continue;
    const key = m[2];
    if (!METRICS[key]) continue;
    const cells = ('|' + m[3]).split('|').map((c) => c.trim());
    const pick = (idx) => {
      const at = idx - 2;
      if (idx < 0 || at < 0 || at >= cells.length) return null;
      const raw = (cells[at] || '').replace(/[^0-9.\-]/g, '');
      if (raw === '' || raw === '-') return null;
      const v = Number(raw);
      return Number.isFinite(v) ? v : null;
    };
    const rolling = pick(rollIdx);
    const full = pick(2);
    const value = rolling !== null ? rolling : full;
    if (value === null) continue;
    const lo = pick(p10Idx);
    const hi = pick(p90Idx);
    const band = (lo !== null && hi !== null && hi > lo) ? { lo, hi, from: 'percentile' } : null;
    baselines[key] = { value, from: rolling !== null ? 'rolling' : 'full', band };
  }
  return baselines;
}

/**
 * 解析「## 作者指纹词」小节的 | 词 | 全书频次带 | 近9章频次 | 门级 | 说明 | 表。
 *
 * v3 变更：白名单门级不再是"一律 blocking"。短窗口下词频方差极大——实测某书 `瞬间`
 * 全书 8.1/万字、最近 6 章只有 3.6/万字，`那个` 从 5.3 掉到 1.2。用全书带卡 3 章窗口，
 * 会把**作者本人**判成"把词压掉了"。故：近9章频次 ≥3.0/万字 才作 blocking，否则只做 advisory。
 */
function parseWhitelist(md) {
  const words = [];
  const lines = md.split('\n');
  let inSection = false;
  let inTable = false;
  let nearColIdx = -1;
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      inSection = /作者指纹词/.test(line);
      inTable = false;
      continue;
    }
    if (!inSection) continue;
    // 表头必须同时含「词」列与频次列（兼容「每万字频次带」与「近6章实测」两种排布），
    // 否则该表不是白名单表。「近期腔调词」那张表没有「词」列头，会被自动排除。
    if (/^\s*\|/.test(line) && /频次/.test(line) && /\|\s*词\s*\|/.test(line)) {
      inTable = true;
      // v3：识别「近 N 章频次」列的位置；没有该列时全部降为 advisory（防静态基线误报）
      const headerCells = line.split('|').map((c) => c.trim());
      const rollIdx = headerCells.findIndex((c) => /近\s*\d*\s*章/.test(c));
      nearColIdx = rollIdx > 0 ? rollIdx : -1;
      continue;
    }
    if (/^\s*\|/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // 分隔行
    if (!/^\s*\|/.test(line)) {
      inTable = false; // 表结束（后续表头不匹配即不再计入）
      continue;
    }
    if (!inTable) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 4) continue;
    const word = cells[1].replace(/[{}`]/g, '');
    if (!word || word === '词' || /^-+$/.test(word)) continue;
    if (word.length > 6) continue; // 只收词，不收句子
    const band = cells[2].replace(/[{}]/g, '');
    const nums = (band.match(/\d+(?:\.\d+)?/g) || []).map(Number);
    if (nums.length === 0) continue;
    const low = Math.min(...nums);
    const high = nums.length > 1 ? Math.max(...nums) : Math.max(low * 2, low + 1);
    // 近9章实测频次（v3）：门级判定依据；无该列 → 视为未知，降 advisory。
    // 列形如 | 词 | 全书频次带 | 近6章实测 | 判定带 | 门级 | 证据 | → split('|') 后 cells[3] = 近N章实测
    let rolling = null;
    for (const cand of [nearColIdx, 3]) {
      if (cand > 0 && cells[cand]) {
        // 跳过「判定带（0.6×~1.6×）」这类含 × 或区间的单元，只取单值
        const cellText = cells[cand];
        if (/×|~|-/.test(cellText)) continue;
        const rn = (cellText.match(/\d+(?:\.\d+)?/g) || []).map(Number);
        if (rn.length > 0) { rolling = rn[0]; break; }
      }
    }
    // 门级：近 N 章频次 ≥3.0/万字 才允许 blocking（短窗口方差过大，否则会把作者本人判成漂移）
    const gate = (rolling !== null && rolling >= 3.0) ? 'blocking' : 'advisory';
    words.push({ word, low, high, raw: band, rolling, gate });
  }
  return words;
}

function parseQuoteStyle(md) {
  const m = md.match(/引号体系[：:]\s*([^\n]*)/);
  if (!m) return null;
  const seg = m[1];
  if (/弯引号|“”/.test(seg)) return 'curly';
  if (/角引号|「」/.test(seg)) return 'corner';
  if (/直引号|半角双引号/.test(seg)) return 'ascii';
  return null;
}

function countWord(text, word) {
  if (!word) return 0;
  let n = 0;
  let idx = 0;
  for (;;) {
    const at = text.indexOf(word, idx);
    if (at === -1) break;
    n += 1;
    idx = at + word.length;
  }
  return n;
}

// ---------------------------------------------------------------- 判定

// 噪声下限：极小基线（如 density 0.02/千字）上用百分比判偏离毫无意义——
// 少一次就 -100%。低于下限的指标判 not-applicable，改由人工/大纲层面把关。
const NOISE_FLOOR = { density: 0.2, ratio: 1.0, length: 1.0, count: 1.0 };

function judge(key, value, baseline, band) {
  const meta = METRICS[key];
  if (baseline === 0 && meta.kind === 'count') {
    return { status: 'not-applicable', reason: '基线为 0（原作不使用该形态）' };
  }
  if (baseline === 0) {
    // 作者完全不用某形态（如破折号=0）时，不能用百分比判——给他一个绝对余量：
    // 实测作者破折号逐章 0~2.08‰，所以 0 基线不能理解为"永远不许出现"。
    const absAllow = NOISE_FLOOR[meta.kind] !== undefined ? NOISE_FLOOR[meta.kind] : 0.2;
    return value > absAllow
      ? { status: 'over', reason: `基线为 0，实测 ${value} > 绝对余量 ${absAllow}` }
      : { status: 'ok', reason: '基线为 0，实测在绝对余量内' };
  }
  const floor = NOISE_FLOOR[meta.kind] !== undefined ? NOISE_FLOOR[meta.kind] : 0.2;
  if (meta.kind === 'density' && baseline < floor) {
    return { status: 'not-applicable', reason: `基线 ${baseline} 低于噪声下限 ${floor}，百分比判定无意义` };
  }
  // v4：用分位带（若文风给了 P10/P90）或宽容回退带，取代 ±15%。
  // 理由：作者章节分布是偏态重尾的，±15% 只能覆盖作者自身 12%~50% 的章节。
  const lo = (band && Number.isFinite(band.lo)) ? band.lo : baseline * BAND_FALLBACK.lo;
  const hi = (band && Number.isFinite(band.hi)) ? band.hi : baseline * BAND_FALLBACK.hi;
  const ratio = value / baseline;
  const dev = ratio - 1;
  const bounds = { lo, hi };
  if (value < lo) return { status: 'under', dev, ratio, bounds };
  if (value > hi) return { status: 'over', dev, ratio, bounds };
  return { status: 'ok', dev, ratio, bounds };
}

function bandText(lo, hi) {
  const f = (n) => (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(2).replace(/\.?0+$/, ''));
  return `${f(lo)} ~ ${f(hi)}`;
}

/**
 * 分布诊断（v4 新增，对应 C'3）：
 * 不报"偏离基线 X%"，而报"落在作者历史区间的第几百分位"。
 *
 * 为什么需要它：声纹指标逐章方差 68%~95%，"偏离均值 20%"可能完全正常
 * （作者自己也那样写）。百分位能区分"正常波动"与"真的离群"。
 * 分位参考点由 --baseline-dist 传入（作者历史各章或各批的实测值集合）。
 */
function percentileRank(value, samples) {
  if (!samples || samples.length === 0) return null;
  const below = samples.filter((s) => s <= value).length;
  return Math.round((below / samples.length) * 100);
}

function distVerdict(pct) {
  if (pct === null) return '无分布参考';
  if (pct <= 5) return '低于作者历史区间（罕见）';
  if (pct >= 95) return '高于作者历史区间（罕见）';
  if (pct <= 20) return '偏低但在作者常见范围内';
  if (pct >= 80) return '偏高但在作者常见范围内';
  return '典型区间内';
}

function fmt(n) {
  if (typeof n !== 'number') return String(n);
  return Math.abs(n) >= 100 ? n.toFixed(0) : String(Math.round(n * 100) / 100);
}

function pad(s, width) {
  const str = String(s);
  let len = 0;
  for (const ch of str) len += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return str + ' '.repeat(Math.max(0, width - len));
}

// ---------------------------------------------------------------- 主流程

// 统一行尾：文风文件常是 CRLF（Windows 编辑器写出来的），而解析正则用 `(.*)$` 收行——
// `$` 在非 multiline 下匹配串尾，行尾的 `\r` 会让整行匹配失败，表现为「文风表里明明有数值，
// 脚本却报全部无基线」。实测踩过：解析到 0 条基线。
const profileText = fs.readFileSync(options.profile, 'utf8').replace(/\r\n/g, '\n');
const profileQuote = parseQuoteStyle(profileText);
const whitelist = parseWhitelist(profileText);
let baselines = parseMetricBaselines(profileText);

// 基线样本（可选）
let baselineMetrics = null;
if (options.baseline.length > 0) {
  const { files: bFiles, skipped: bSkipped } = collectFiles(options.baseline);
  if (bSkipped.length) for (const s of bSkipped) console.error(`警告：基线样本跳过 ${s}`);
  if (bFiles.length === 0) die('--baseline 未匹配到任何 .txt/.md 文件');
  baselineMetrics = textMetrics(mergeTexts(bFiles));
  baselineMetrics._files = bFiles;
}

// --backfill：用基线实测值填空缺项
let backfilled = [];
if (options.backfill) {
  if (!baselineMetrics) die('--backfill 需要同时提供 --baseline');
  // 写入目标是「滚动基线」列（判定准绳）。不能盲写第一格——那会覆盖「全书基线（兜底）」列。
  // 实测踩过：backfill 写错列，把兜底值全刷成了近批实测值。
  const linesAll = profileText.split('\n');
  let hdrIdx = -1;
  let inMetricSection = false;
  for (let i = 0; i < linesAll.length; i += 1) {
    if (/^##\s/.test(linesAll[i])) inMetricSection = /写作指标带/.test(linesAll[i]);
    if (inMetricSection && /滚动基线/.test(linesAll[i]) && /键名/.test(linesAll[i])) { hdrIdx = i; break; }
  }
  if (hdrIdx < 0) {
    die('--backfill 找不到「滚动基线」列表头：请先用 style-profile-protocol.md 的 v3 模板重建文风指标表');
  }
  const hdrCells = linesAll[hdrIdx].split('|').map((c) => c.trim());
  const rollCol = hdrCells.findIndex((c) => /滚动基线/.test(c));
  let changed = 0;
  for (let i = hdrIdx + 1; i < linesAll.length; i += 1) {
    const line = linesAll[i];
    if (!/^\s*\|/.test(line)) { if (line.trim() === '') break; continue; }
    const m = line.match(/^\|\s*[^|]*\s*\|\s*`?([a-z_]+)`?\s*\|/);
    if (!m) continue;
    const key = m[1];
    if (!METRICS[key]) continue;
    const value = baselineMetrics[key];
    if (typeof value !== 'number') continue;
    const parts = line.split('|');
    const at = rollCol - 2; // m[3] 左侧比表头少两个前导空位
    if (at < 0 || at >= parts.length) continue;
    const cur = (parts[at] || '').replace(/[^0-9.\-]/g, '');
    if (cur !== '' && cur !== '-') continue; // 已有数值：不覆盖
    parts[at] = ` **${value}** `;
    linesAll[i] = parts.join('|');
    backfilled.push(`${key} = ${value}`);
    changed += 1;
  }
  if (changed > 0) {
    const out = linesAll.join('\n');
    fs.writeFileSync(options.profile, out, 'utf8');
    baselines = parseMetricBaselines(out);
    console.log(`[backfill] 已回填 ${changed} 项到「滚动基线」列：${options.profile}`);
  } else {
    console.log('[backfill] 无需回填（滚动基线列已有数值，或表结构不匹配）');
  }
  for (const b of backfilled) console.log(`  · ${b}`);
  if (options.files.length === 0) process.exit(0);
}

const findings = [];
const textFiles = options.files;
const { files, skipped } = collectFiles(textFiles);
if (files.length === 0) die('未匹配到任何待检查的 .txt/.md 文件');
for (const s of skipped) console.error(`警告：跳过 ${s}`);

const actual = textMetrics(mergeTexts(files));

// 1) 引号体系一致性
const declaredQuote = options.quoteMode || profileQuote;
if (declaredQuote) {
  if (actual.quote_style.startsWith('mixed')) {
    findings.push({
      level: 'blocking',
      kind: 'quote-mixed',
      key: 'quote_style',
      message: `引号体系混用：${actual.quote_style}；文风声明为 ${declaredQuote}。须统一（见 banned-words.md「角引号」节）`,
    });
  } else if (actual.quote_style !== 'none' && actual.quote_style !== declaredQuote) {
    findings.push({
      level: 'blocking',
      kind: 'quote-mismatch',
      key: 'quote_style',
      message: `引号体系与文风不一致：实测 ${actual.quote_style}，文风声明 ${declaredQuote}`,
    });
  }
}

// 2) 缩进契约
const declaredIndent = (profileText.match(/缩进与段间[：:]\s*([^\n]*)/) || [])[1] || '';
if (/缩进\s*=\s*2\s*个全角|fullwidth-2/.test(declaredIndent)) {
  if (actual.indent_style === 'none') {
    findings.push({
      level: 'blocking',
      kind: 'indent-missing',
      key: 'indent_style',
      message: '文风声明段首用 2 个全角空格缩进，实测无缩进（平台默认不得覆盖文风契约）',
    });
  } else if (actual.indent_style === 'mixed') {
    findings.push({
      level: 'advisory',
      kind: 'indent-mixed',
      key: 'indent_style',
      message: '缩进形态混用（部分段有缩进、部分没有）',
    });
  }
}

// 3a) 段落长尾的绝对硬线（不依赖文风基线，任何书都成立）
const paraSamples = actual.long_para_samples || [];
const overLong = paraSamples.filter((s) => s.len >= PARA_HARD_MAX);
const multiBeat = paraSamples.filter((s) => s.len >= PARA_BEAT_MAX && s.beats >= PARA_BEAT_COUNT);
if (overLong.length > 0) {
  findings.push({
    level: 'blocking',
    kind: 'para-overlong',
    key: 'max_para_len',
    message: `超长段 ${overLong.length} 处（单段 ≥${PARA_HARD_MAX} 字，手机上超过 4 行必须拆）：`
      + overLong.map((s) => `${s.len}字「${s.head}…」`).join('；')
      + ' → 按句号拆段，不是删句',
  });
}
if (multiBeat.length > 0) {
  findings.push({
    level: 'blocking',
    kind: 'para-multi-beat',
    key: 'multi_beat_para_ratio',
    message: `主语延续式长段 ${multiBeat.length} 处（单段 ≥${PARA_BEAT_MAX} 字且 ≥${PARA_BEAT_COUNT} 拍）：`
      + multiBeat.map((s) => `${s.len}字/${s.beats}拍「${s.head}…」`).join('；')
      + ' → 一段一拍，把同一主语的多句拆成独立段落（作者常用手法，不是删词）',
  });
}

// 3b) 指标偏离
const rows = [];
for (const key of Object.keys(METRICS)) {
  const b = baselines[key];
  const value = actual[key];
  if (typeof value !== 'number') continue;
  if (!b) {
    rows.push({ key, label: METRICS[key].label, value, baseline: null, status: 'no-baseline' });
    continue;
  }
  const j = judge(key, value, b.value, b.band);
  const row = {
    key,
    label: METRICS[key].label,
    unit: METRICS[key].unit,
    value,
    baseline: b.value,
    band: j.bounds ? bandText(j.bounds.lo, j.bounds.hi) : '—',
    bandFrom: b.band ? b.band.from : 'fallback',
    tier: METRICS[key].tier || 'voice',
    status: j.status,
    dev: j.dev,
    reason: j.reason,
  };
  rows.push(row);
  if (j.status === 'under' || j.status === 'over') {
    const pct = Math.round(j.dev * 1000) / 10;
    const tier = METRICS[key].tier || 'voice';
    const tierTag = tier === 'hard' ? 'hard' : (tier === 'soft' ? 'soft' : 'voice');
    findings.push({
      level: findingLevel(key),
      kind: j.status === 'under' ? 'metric-under' : 'metric-over',
      key,
      message: `[${tierTag}] ${METRICS[key].label} 偏离：实测 ${fmt(value)}${METRICS[key].unit}，基线 ${fmt(b.value)}，`
        + `带 ${row.band}${b.band ? '（分位带 P10-P90）' : '（回退带 0.5×~1.6×，文风未给 P10/P90）'}，`
        + `偏离 ${pct > 0 ? '+' : ''}${pct}%`
        + (tier === 'hard' ? '' : '——声纹类只作提示，不阻断'),
    });
  }
}

// 4) 作者指纹词（白名单）反向校验
let actualTextCache = null;
function actualText() {
  if (actualTextCache === null) actualTextCache = mergeTexts(files);
  return actualTextCache;
}

const wordRows = [];
if (whitelist.length > 0) {
  const text = actualText();
  // 探测窗口：被测样本的章数。滚动基线取自 N 章，被测只有 M 章时方差按 sqrt(N/M) 放大——
  // 实测作者 6 章 `瞬间` 3.6/万字，其中最后 3 章只有 2.4/万字。用 6 章的下限直接卡 3 章，
  // 会把作者本人判成"把词压掉了"。故对短窗口按比例放宽下限（上限不动）。
  const probeChapters = Math.max(1, (text.match(/^\s*第\s*[0-9一二三四五六七八九十百千零两]+\s*章/gm) || []).length);
  // 与文风.md 声明的滚动窗口一致。判定窗口对齐：单章=近3章、3章批=近6~9章；
  // 探测窗口小于基线窗口时，词频的窗口间方差可达 7 倍（实测 `一旁`: 461-463 约 7.3/万字 vs 464-466 仅 1.2/万字），
  // 此时**一律不做 blocking**——包括去卡作者本人。
  const rollingChapters = 6;
  const windowFactor = Math.sqrt(rollingChapters / Math.min(rollingChapters, probeChapters));
  const windowTag = probeChapters < rollingChapters
    ? `；探测窗口 ${probeChapters} 章 < 基线窗口 ${rollingChapters} 章，下限按 √(N/M) 放宽 ×${windowFactor.toFixed(2)}`
    : '';
  for (const w of whitelist) {
    const n = countWord(text, w.word);
    const perKilo = Math.round((n / actual.chars) * 10000 * 10) / 10;
    // 判定带以「基线窗口实测值」为准（rolling × 0.6 ~ ×1.6），无 rolling 时退回静态带。
    // 探测窗口更短则下限按 √(N/M) 再放宽，但不得低于 rolling × 0.30（保底，防完全失效）。
    const base = w.rolling !== null ? w.rolling : w.low;
    const lowRaw = Math.round((w.rolling !== null ? w.rolling * 0.6 : w.low) * 10) / 10;
    const highDyn = w.rolling !== null ? Math.round(w.rolling * 1.6 * 10) / 10 : w.high;
    const adjLow = w.rolling !== null
      ? Math.round(Math.max(lowRaw / windowFactor, base * 0.30) * 10) / 10
      : lowRaw;
    const row = {
      word: w.word, count: n, per_ten_kilo: perKilo,
      low: adjLow, lowRaw, high: highDyn, band: `${adjLow}-${highDyn}`,
      rolling: w.rolling, gate: w.gate, status: 'ok',
    };
    if (perKilo < adjLow) {
      row.status = 'under';
      // 三个条件同时成立才判 blocking（v3 实测校准，防把作者本人判成漂移）：
      //   ① 该词在基线窗口频次 ≥3.0/万字（gate=blocking）
      //   ② 探测窗口 ≥ 基线窗口（窗口对齐；见 style-profile-protocol.md「判定窗口对齐」）
      //   ③ 实测 < 基线窗口实测的 50%（不是"低于带下限"，而是"明显塌了"）
      const bigEnoughWindow = probeChapters >= rollingChapters;
      const collapse = w.rolling !== null && perKilo < w.rolling * 0.5;
      const isBlocking = w.gate === 'blocking' && bigEnoughWindow && collapse;
      findings.push({
        level: isBlocking ? 'blocking' : 'advisory',
        kind: 'whitelist-under',
        key: w.word,
        message: `作者指纹词「${w.word}」偏低：实测每万字 ${perKilo}，判定带 ${adjLow}-${highDyn}`
          + (w.rolling !== null ? `，基线窗口实测 ${w.rolling}/万字` : '')
          + (isBlocking
            ? '——该词是作者母语级口癖，不得作为 AI 味清除（见 banned-words.md「判定优先级」）'
            : `——只作提示不阻断（${!bigEnoughWindow
              ? `探测窗口 ${probeChapters} 章 < 基线窗口 ${rollingChapters} 章（单章/短批词频不算数，见文风协议）`
              : '未跌破基线的一半'}）`),
      });
    } else if (perKilo > highDyn * 2) {
      row.status = 'over';
      findings.push({
        level: 'advisory',
        kind: 'whitelist-over',
        key: w.word,
        message: `作者指纹词「${w.word}」超用：实测每万字 ${perKilo}，判定带上限 ${highDyn} 的两倍以上`,
      });
    }
    wordRows.push(row);
  }
}

// ---------------------------------------------------------------- 报告
console.log(`文风基线：${options.profile}`);
if (baselineMetrics) {
  console.log(`基线样本：${baselineMetrics._files.length} 个文件，`
    + `${baselineMetrics.chars} 字符（用于回填/参考，判定仍以文风表内数值为准）`);
}
console.log(`待检样本：${files.length} 个文件，${actual.chars} 字符`);
console.log('');

console.log('## 指标偏离（声纹类用分位带 或 回退带 0.5×~1.6×；hard 类才阻断）');
console.log(`| ${pad('指标', 22)} | ${pad('实测', 10)} | ${pad('基线', 10)} | ${pad('判定带', 18)} | ${pad('强度', 8)} | 判定 |`);
console.log(`|${'-'.repeat(24)}|${'-'.repeat(12)}|${'-'.repeat(12)}|${'-'.repeat(20)}|${'-'.repeat(10)}|------|`);
for (const r of rows) {
  const verdict = {
    ok: '一致',
    under: '偏低',
    over: '偏高',
    'not-applicable': '不适用',
    'no-baseline': '无基线',
  }[r.status] || r.status;
  const mark = (r.status === 'under' || r.status === 'over')
    ? (r.tier === 'hard' ? ' ✗阻断' : ' ·提示')
    : '';
  const bandLabel = r.band && r.band !== '—'
    ? `${r.band}${r.bandFrom === 'percentile' ? '(P10-90)' : '(回退)'}`
    : '—';
  console.log(`| ${pad(r.label, 22)} | ${pad(r.baseline === null ? fmt(r.value) : fmt(r.value) + (r.unit || ''), 10)} `
    + `| ${pad(r.baseline === null ? '—' : fmt(r.baseline), 10)} | ${pad(bandLabel, 18)} `
    + `| ${pad(r.tier || 'voice', 8)} | ${verdict}${mark} |`);
}

console.log('');
console.log('## 段落长尾（长段是"读起来累"的真来源，平均值会掩盖它）');
console.log(`段数 ${actual.para_count}　中位段长 ${fmt(actual.median_para_len)} 字　`
  + `P90 ${fmt(actual.p90_para_len)} 字　最长段 ${fmt(actual.max_para_len)} 字`);
console.log(`段长≥60字占比 ${fmt(actual.ge60_para_ratio)}%　单段≥4拍占比 ${fmt(actual.multi_beat_para_ratio)}%`);
if (paraSamples.length > 0) {
  console.log('');
  console.log(`最长的 ${Math.min(paraSamples.length, 6)} 个叙述段（用于定位要拆的段）：`);
  for (const s of paraSamples.slice(0, 6)) {
    const flag = s.len >= PARA_HARD_MAX ? '超长段 ✗' : (s.beats >= PARA_BEAT_COUNT ? '多拍长段 ✗' : '—');
    console.log(`  · ${String(s.len).padStart(3)}字/${s.beats}拍  ${flag}  「${s.head}…」`);
  }
}

if (wordRows.length > 0) {
  console.log('');
  console.log('## 作者指纹词（白名单）校验');
  console.log(`| ${pad('词', 8)} | ${pad('实测/万字', 10)} | ${pad('基线带', 12)} | ${pad('近9章', 8)} | ${pad('门级', 8)} | 判定 |`);
  console.log(`|${'-'.repeat(10)}|${'-'.repeat(12)}|${'-'.repeat(14)}|${'-'.repeat(10)}|${'-'.repeat(10)}|------|`);
  for (const r of wordRows) {
    const verdict = r.status === 'ok' ? '在带内' : (r.status === 'under' ? '被压掉 ✗' : '超用 !');
    const gateLabel = r.gate === 'blocking' ? 'blocking' : 'advisory';
    console.log(`| ${pad(r.word, 8)} | ${pad(r.per_ten_kilo, 10)} | ${pad(r.band, 12)} | `
      + `${pad(r.rolling === null ? '—' : r.rolling, 8)} | ${pad(gateLabel, 8)} | ${verdict} |`);
  }
  const advOnly = wordRows.filter((r) => r.gate !== 'blocking').length;
  if (advOnly > 0) {
    console.log(`> ${advOnly} 个词的近9章频次 <3.0/万字 → 只作 advisory（短窗口方差大，避免把作者本人判成漂移）。`);
  }
} else {
  console.log('');
  console.log('（文风未提供「作者指纹词」表：跳过白名单校验。'
    + '若这是仿写任务，请先按 style-profile-generator.md Step 4b 补表。）');
}

const blocking = findings.filter((f) => f.level === 'blocking');
const advisory = findings.filter((f) => f.level === 'advisory');

console.log('');
if (findings.length === 0) {
  console.log('## 结论：无偏离（blocking 0，advisory 0）');
} else {
  console.log(`## 结论：blocking ${blocking.length}，advisory ${advisory.length}`);
  for (const f of findings) {
    console.log(`  [${f.level}] ${f.kind} ${f.message}`);
  }
}

if (options.json) {
  const payload = {
    profile: options.profile,
    tolerance: options.tolerance,
    files,
    actual,
    baselines,
    rows,
    whitelist: wordRows,
    findings,
    summary: { blocking: blocking.length, advisory: advisory.length },
  };
  fs.writeFileSync(options.json, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`\n[json] 已写入 ${options.json}`);
}

const shouldFail = options.failOn === 'blocking' ? blocking.length > 0 : findings.length > 0;
process.exit(shouldFail ? 1 : 0);
