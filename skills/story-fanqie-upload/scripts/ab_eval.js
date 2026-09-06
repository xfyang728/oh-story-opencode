#!/usr/bin/env node
// ab_eval.js <jsfile> — 执行 JS 文件内容（经 agent-browser eval --stdin），回显原始输出
"use strict";
const { execSync } = require("child_process");
const fs = require("fs");
const file = process.argv[2];
if (!file) { console.error("usage: node ab_eval.js <jsfile>"); process.exit(1); }
const js = fs.readFileSync(file, "utf8");
try {
  const out = execSync(`agent-browser --cdp 9222 eval --stdin`, {
    encoding: "utf8", input: js, timeout: 60000, maxBuffer: 10 * 1024 * 1024,
  });
  console.log(out.trim());
} catch (e) {
  console.error("EVAL FAIL:", String(e.message).split("\n")[0]);
  if (e.stdout) console.log("STDOUT:", e.stdout.toString().trim());
  process.exit(1);
}
