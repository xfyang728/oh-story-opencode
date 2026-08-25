#!/usr/bin/env node
/**
 * upload_chapters.js — 番茄小说作家后台批量存草稿驱动（CDP via agent-browser）
 *
 * 用法：
 *   node upload_chapters.js <chapters.json> <from> <to> <book_id> [startUrl]
 *
 * - chapters.json 由 prep_chapters.py 生成
 * - startUrl 可选：第一章改用指定 URL 打开（如修正已有草稿时传 /publish/{draft_id} 地址）
 * - 中途校验失败即停（不保存脏数据）；修复后从失败章续跑
 *
 * 前置：CDP 调试浏览器已就绪（http://127.0.0.1:9222/json/version 可访问），
 *       且已登录番茄作家后台。详见 SKILL.md「环境准备」。
 */
"use strict";
const { execSync } = require("child_process");
const fs = require("fs");

const chapters = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const from = parseInt(process.argv[3], 10);
const to = parseInt(process.argv[4], 10);
const BOOK_ID = process.argv[5];
if (!BOOK_ID) {
  console.error("用法: node upload_chapters.js <chapters.json> <from> <to> <book_id> [startUrl]");
  process.exit(1);
}
const startUrl = process.argv[6] || null;

const NEW_URL = `https://fanqienovel.com/main/writer/${BOOK_ID}/publish/?enter_from=newchapter_0`;
const MANAGE_URL = `https://fanqienovel.com/main/writer/chapter-manage/${BOOK_ID}&type=1`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** eval JS（stdin 传入，规避 Windows 命令行长度限制与 PowerShell 编码问题） */
function abEval(js) {
  const out = execSync(`agent-browser --cdp 9222 eval --stdin`, {
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 10 * 1024 * 1024,
    input: js,
  });
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  try {
    let v = JSON.parse(last);
    if (typeof v === "string") v = JSON.parse(v); // 页面端 JSON.stringify 的字符串会被再包一层
    return v;
  } catch { return { raw: last }; }
}

/** 导航，失败重试 3 次（beforeunload 拦截/瞬时 CDP 故障） */
function abOpen(url) {
  for (let k = 0; k < 3; k++) {
    try {
      execSync(`agent-browser --cdp 9222 open "${url}"`, { encoding: "utf8", timeout: 60000 });
      return;
    } catch (e) {
      console.log(`  open retry ${k + 1}: ${String(e.message).split("\n")[0]}`);
      try { execSync(`agent-browser --cdp 9222 wait 3000`, { encoding: "utf8", timeout: 30000 }); } catch {}
    }
  }
  throw new Error("open failed after 3 retries: " + url);
}

/** 填充序号+标题+正文，返回回显校验数据 */
const FILL_JS = (num, title, body) => `
(function(){
  try {
    const vis = [...document.querySelectorAll('input')].filter(e => (e.offsetWidth||0) > 20);
    const titleInp = vis.find(e => e.placeholder === '请输入标题');
    if (!titleInp) return JSON.stringify({ok:false, step:'title-input'});
    const numInp = vis.filter(e => e !== titleInp && !e.placeholder && e.offsetWidth < 200)[0] || null;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    if (numInp) { setter.call(numInp, ${JSON.stringify(String(num))}); numInp.dispatchEvent(new Event('input',{bubbles:true})); }
    setter.call(titleInp, ${JSON.stringify(title)});
    titleInp.dispatchEvent(new Event('input',{bubbles:true}));
    const eds = [...document.querySelectorAll('[contenteditable="true"]')].filter(e => e.offsetWidth > 0 || e.offsetHeight > 0);
    if (!eds.length) return JSON.stringify({ok:false, step:'body-editor', editors: 0});
    // 正文编辑器 = 可见且面积最大的 ProseMirror 实例（侧边栏 AI 面板都是小编辑器）
    const ed = eds.reduce((a, b) => (a.offsetWidth * a.offsetHeight >= b.offsetWidth * b.offsetHeight ? a : b));
    ed.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    document.execCommand('insertText', false, ${JSON.stringify(body)});
    return JSON.stringify({
      ok: true,
      numEcho: numInp ? numInp.value : null,
      titleEcho: titleInp.value,
      bodyLen: (ed.innerText||'').replace(/\\s/g,'').length
    });
  } catch(e) { return JSON.stringify({ok:false, err:String(e)}); }
})()`;

const SAVE_JS = `
(function(){
  const btn = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === '存草稿');
  if (!btn) return JSON.stringify({ok:false, err:'no-save-btn'});
  btn.click();
  return JSON.stringify({ok:true});
})()`;

(async () => {
  const targets = chapters.filter((c) => c.index >= from && c.index <= to);
  if (!targets.length) { console.error("章节范围内无数据"); process.exit(1); }
  const results = [];
  let failIndex = null;

  /** 打开草稿箱并检查指定标题是否在列表中 */
  async function verifyInDraftBox(plainTitle) {
    abOpen(MANAGE_URL);
    await sleep(4000);
    abEval(`(function(){const t=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()==='草稿箱');if(t)t.click();return 'OK'})()`);
    await sleep(2500);
    const r = abEval(`JSON.stringify((document.body.innerText||'').includes(${JSON.stringify(plainTitle)}))`);
    return r === true || r === "true";
  }

  for (let i = 0; i < targets.length; i++) {
    const c = targets[i];
    const plainTitle = c.title.replace(/^第\d+章\s*/, "");
    console.log(`\n===== 第${c.index}章 ${plainTitle} =====`);
    let verified = false;

    for (let attempt = 1; attempt <= 3 && !verified; attempt++) {
      if (attempt > 1) console.log(`  -- 第 ${attempt} 次尝试 --`);
      abOpen(NEW_URL);
      await sleep(4500);

      const fill = abEval(FILL_JS(c.index, plainTitle, c.body));
      console.log("fill:", JSON.stringify(fill));
      const numOk = fill.numEcho === String(c.index);
      const titleOk = fill.titleEcho === plainTitle;
      const bodyOk = (fill.bodyLen || 0) >= c.body_chars * 0.9;
      if (!fill.ok || !numOk || !titleOk || !bodyOk) {
        console.log(`!! 校验失败 num=${numOk} title=${titleOk} body=${bodyOk}`);
        continue;
      }
      await sleep(800);
      const clicked = abEval(SAVE_JS);
      console.log("save-click:", JSON.stringify(clicked));
      if (!clicked.ok) continue;
      await sleep(5000); // 等保存请求落地，避免 beforeunload 拦截导航

      // 保存无可靠页面信号，必须以草稿箱实查为准；缺失即重传
      verified = await verifyInDraftBox(plainTitle);
      console.log(`verify-in-draftbox: ${verified}`);
    }

    results.push({ index: c.index, ok: verified });
    if (!verified) { failIndex = c.index; break; }
  }

  // 终验：草稿箱列表（保存无 toast 信号，以草稿箱为准）
  try {
    abOpen(MANAGE_URL);
    await sleep(4000);
    abEval(`(function(){const t=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()==='草稿箱');if(t)t.click();return 'OK'})()`);
    await sleep(2500);
    const text = abEval(`JSON.stringify((document.body.innerText||'').substring(0,1600))`);
    console.log("\n===== 草稿箱 =====");
    console.log(typeof text === "string" ? text : JSON.stringify(text));
  } catch (e) {
    console.log("\n草稿箱核验导航失败（可手动检查）:", String(e.message).split("\n")[0]);
  }

  console.log("===== RESULT =====");
  console.log(JSON.stringify(results, null, 1));
  if (failIndex !== null) {
    console.log(`\n第 ${failIndex} 章失败。排查后从该章续跑：node upload_chapters.js ${process.argv[2]} ${failIndex} ${to} ${BOOK_ID}`);
    process.exit(2);
  }
})();
