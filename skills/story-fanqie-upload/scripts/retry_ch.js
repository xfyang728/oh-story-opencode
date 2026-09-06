#!/usr/bin/env node
// retry_ch.js <chapters.json> <index> <book_id> — 单章重传（加长同步等待）
"use strict";
const { execSync } = require("child_process");
const fs = require("fs");
const chapters = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const idx = parseInt(process.argv[3], 10);
const BOOK_ID = process.argv[4];
const c = chapters.find((x) => x.index === idx);
if (!c) { console.error("no chapter " + idx); process.exit(1); }
const plainTitle = c.title.replace(/^第\d+章\s*/, "");
const NEW_URL = `https://fanqienovel.com/main/writer/${BOOK_ID}/publish/?enter_from=newchapter_0`;
const MANAGE_URL = `https://fanqienovel.com/main/writer/chapter-manage/${BOOK_ID}&type=1`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function abEval(js) {
  const out = execSync(`agent-browser --cdp 9222 eval --stdin`, {
    encoding: "utf8", timeout: 60000, maxBuffer: 10 * 1024 * 1024, input: js,
  });
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  try { let v = JSON.parse(last); if (typeof v === "string") v = JSON.parse(v); return v; }
  catch { return { raw: last }; }
}
function abOpen(url) {
  for (let k = 0; k < 3; k++) {
    try { execSync(`agent-browser --cdp 9222 open "${url}"`, { encoding: "utf8", timeout: 60000 }); return; }
    catch (e) { console.log(`  open retry ${k+1}`); try { execSync(`agent-browser --cdp 9222 wait 3000`, { encoding: "utf8", timeout: 30000 }); } catch {} }
  }
  throw new Error("open failed");
}

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
    if (!eds.length) return JSON.stringify({ok:false, step:'body-editor'});
    const ed = eds.reduce((a, b) => (a.offsetWidth * a.offsetHeight >= b.offsetWidth * b.offsetHeight ? a : b));
    ed.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    document.execCommand('insertText', false, ${JSON.stringify(body)});
    // 触发 ProseMirror -> React 状态同步
    ed.dispatchEvent(new Event('input', {bubbles:true}));
    ed.blur(); window.focus(); ed.focus();
    return JSON.stringify({ok:true, bodyLen:(ed.innerText||'').replace(/\\s/g,'').length});
  } catch(e) { return JSON.stringify({ok:false, err:String(e)}); }
})()`;

(async () => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`-- 尝试 ${attempt} --`);
    abOpen(NEW_URL);
    await sleep(5000);
    const fill = abEval(FILL_JS(c.index, plainTitle, c.body));
    console.log("fill:", JSON.stringify(fill));
    if (!fill.ok || (fill.bodyLen || 0) < c.body_chars * 0.9) continue;
    await sleep(2500); // 等 React 状态同步
    // 二次确认编辑器内容仍在
    const recheck = abEval(`JSON.stringify((function(){const eds=[...document.querySelectorAll('[contenteditable="true"]')].filter(e=>e.offsetWidth>0);const ed=eds.reduce((a,b)=>(a.offsetWidth*a.offsetHeight>=b.offsetWidth*b.offsetHeight?a:b));return (ed.innerText||'').replace(/\\s/g,'').length})())`);
    console.log("recheck bodyLen:", recheck);
    const clicked = abEval(`(function(){const btn=[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='存草稿');if(!btn)return JSON.stringify({ok:false});btn.click();return JSON.stringify({ok:true})})()`);
    console.log("save:", JSON.stringify(clicked));
    await sleep(10000); // 等保存请求落地
    // 停留检查：URL 是否变化/出现报错
    const stay = abEval(`JSON.stringify({url:location.href, hasModal:!!document.querySelector('.arco-modal'), modalText:document.querySelector('.arco-modal')?(document.querySelector('.arco-modal').innerText||'').substring(0,150):null})`);
    console.log("stay:", JSON.stringify(stay));
    // 草稿箱实查
    abOpen(MANAGE_URL);
    await sleep(4500);
    abEval(`(function(){const t=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()==='草稿箱');if(t)t.click();return 'OK'})()`);
    await sleep(3000);
    const found = abEval(`JSON.stringify((document.body.innerText||'').includes(${JSON.stringify(plainTitle)}))`);
    console.log("verify:", found);
    if (found === true || found === "true") { console.log(`第${c.index}章 OK`); process.exit(0); }
  }
  console.log(`第${c.index}章 仍失败`);
  process.exit(2);
})();
