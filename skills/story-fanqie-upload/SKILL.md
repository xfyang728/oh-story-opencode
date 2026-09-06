# Skill: story-fanqie-upload

# 番茄小说批量存草稿

通过 CDP 浏览器自动化，把本地章节文件批量上传到番茄小说作家后台并存为草稿。
全流程实战验证（2026-08-22 首批 3–10 章；2026-08-26 全量 3–57 章）。

**触发方式**：`/story-fanqie-upload`、`/发番茄`、「上传番茄」「发布章节到番茄」「把第X章传到番茄」

---

## 前置条件

| 依赖 | 说明 |
|------|------|
| Node.js 18+ | agent-browser 运行环境 |
| `agent-browser` | `npm install -g agent-browser` |
| Microsoft Edge 或 Chrome | 本机 Edge 路径：`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` |
| 番茄作家账号 | 首次需人工扫码登录一次 |

## 环境准备（CDP 调试浏览器）

⚠️ **Chromium 136+/Edge 151 在默认用户数据目录上静默禁用 `--remote-debugging-port`**——进程带参启动但端口不通。必须用独立调试目录，并把登录态文件拷进去。

```powershell
# 1) 杀浏览器（先征得用户同意！用户未保存的标签页会丢失）
Get-Process -Name msedge -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep 4

# 2) 首次：拷贝登录态到独立调试目录
$src = "$env:LOCALAPPDATA\Microsoft\Edge\User Data"
$dst = "$env:USERPROFILE\edge-debug-profile"
# 拷贝清单（Local State 含 Cookie 解密密钥，必须拷）：
#   Local State  Default\Preferences  Default\Network\Cookies (+ -journal)
#   Default\Local Storage\  Default\Session Storage\  （整目录递归）

# 3) 启动（调试目录已存在时直接启动即可，无需重复拷贝）
Start-Process "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  -ArgumentList "--remote-debugging-port=9222", "--user-data-dir=`"$dst`"", `
                "--remote-allow-origins=*", "--no-first-run", "--no-default-browser-check"

# 4) 验证
try { (Invoke-RestMethod -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 5).Browser }
catch { Write-Output "CDP 启动失败" }
```

- **首次使用**：打开 `https://fanqienovel.com/main/writer/home`，若跳转 `/login` 则请用户在调试窗口扫码登录一次；登录态持久保存在调试目录，之后免登录。
- 登录失效时：删除 `$dst` 重新拷贝＋重新扫码。

## 脚本清单

| 脚本 | 用途 |
|------|------|
| `prep_chapters.py` | 从 md 文件提取章节数据 → `chapters.json` |
| `upload_chapters.js` | 批量上传（批量模式，遇错即停） |
| `retry_ch.js` | 单章上传（加长同步等待，更稳健，**推荐**） |
| `ab_eval.js` | Node 中转 agent-browser eval（规避 PowerShell 管道编码问题） |

## 关键 URL

| 页面 | URL |
|------|-----|
| 作家工作台 | `https://fanqienovel.com/main/writer/home` |
| 章节管理 | `https://fanqienovel.com/main/writer/chapter-manage/{book_id}&type=1` |
| 新建章节 | `https://fanqienovel.com/main/writer/{book_id}/publish/?enter_from=newchapter_0` |
| 编辑已有草稿 | `https://fanqienovel.com/main/writer/{book_id}/publish/{draft_id}?enter_from=newchapter_0` |

`book_id` 从工作台页面链接提取（章节管理/创建章节的 href 里都带）。

## 编辑器 DOM 结构（发布页）

| 元素 | 定位方式 |
|------|----------|
| 章节序号输入框 | 可见、**无 placeholder**、宽 <200px（实测 72px），DOM 序在标题框之前 |
| 标题输入框 | `input[placeholder="请输入标题"]` |
| 正文编辑器 | 可见 `[contenteditable="true"]` 中**面积最大**者（ProseMirror；侧边栏 AI 面板都是小编辑器） |
| 存草稿按钮 | `<button>` 文本 === `'存草稿'` |
| 下一步按钮 | 进入发布流程（存草稿模式不碰它） |

**标题格式规则**：序号框填纯数字 `N`，标题框填**去掉「第N章」前缀的纯标题**。平台展示时自动组合成「第N章 标题」。把「第N章 xxx」整串塞进标题框会导致草稿名变成「第 章 第N章 xxx」。

## 推荐工作流

### Step 1：准备章节数据

```powershell
python scripts\prep_chapters.py -BookDir "D:\novel\<书名>\正文" -From 37 -To 57 -Out chapters.json
```

- 源文件首行格式：`# 第N章 标题` 或纯文本 `第N章 标题`（两种均可）
- 输出 JSON 数组：`{index, file, title(含前缀), body, body_chars(去空白净字数)}`
- 自动清理 `**加粗**`/`*斜体*` 残留

### Step 2：获取 book_id

```powershell
agent-browser --cdp 9222 open "https://fanqienovel.com/main/writer/home"
agent-browser --cdp 9222 wait 5000
agent-browser --cdp 9222 eval "JSON.stringify([...new Set([...document.querySelectorAll('a[href]')].map(a=>a.getAttribute('href')).filter(h=>h&&/writer\/\d+/.test(h)))].slice(0,5))"
```

### Step 3：检查草稿箱现状

确认目标章节范围无旧草稿残留（避免重复）。草稿箱最多显示 30 行，用标题搜索确认：

```powershell
node scripts\ab_eval.js <(echo 'JSON.stringify((function(){ var txt=document.body.innerText||""; return {has37:txt.includes("第37章"),has38:txt.includes("第38章")}; })())')
```

### Step 4：试传单章（必做）

先用范围内第一章单独跑通全链路：

```powershell
node scripts\retry_ch.js chapters.json 37 <book_id>
```

脚本行为：打开新建章节页 → 填序号/标题/正文 → **等 2.5s** → 点存草稿 → **等 10s** → 检查 URL 是否变为 `/publish/{draft_id}`（落地标志） → 进草稿箱实查标题。失败自动重试 3 次。

### Step 5：批量上传

```powershell
$ok = $true; foreach ($i in 38..57) {
  node scripts\retry_ch.js chapters.json $i <book_id>
  if ($LASTEXITCODE -ne 0) { $ok = $false; break }
}; if ($ok) { Write-Output "=== 全部完成 ===" }
```

每章约 40 秒，20 章约 15 分钟。中途失败即停，修复后从失败章续跑。

### Step 6：草稿箱终验

```powershell
agent-browser --cdp 9222 open "https://fanqienovel.com/main/writer/chapter-manage/<book_id>&type=1"
# 等待加载 → 点击草稿箱 → 逐章核对字数
```

## 字数核验规则

对照平台字数与本地 `body_chars`：

- **一致** = 上传正确 ✓
- **差 1–2 字** = 番茄计数口径差异，**非截断**。番茄不计以下符号字：
  - `〇`（U+3007）→ 差 1
  - `Ⅱ`（U+2161）→ 差 1
  - `·`（U+00B7）→ 差 1
  - 同章多符号累加（如差 2 = 含两个此类字符）
- **差 ≥3 字** = 疑似截断，需重传该章

验证方法：用 Python 对比平台值与本地 `body_chars`，找出差值对应的特殊字符数。

## 坑位清单（全部实测踩过）

| 坑 | 现象 | 对策 |
|----|------|------|
| 默认 profile 禁调试 | 进程带参启动但 9222 不通 | 独立 `--user-data-dir` ＋拷登录态（见环境准备） |
| beforeunload 离开拦截 | 未保存就导航 → `ERR_ABORTED`，残留模态框卡死后续 CDP（10060 超时） | 点完存草稿**等 10 秒**再导航；导航失败重试 3 次 |
| 保存无 toast 信号 | 轮询「保存成功」等文案永远空 | 放弃信号检测，以草稿箱列表为准做终验 |
| save-click 成功 ≠ 已保存 | 点击返回 ok，但保存请求未落地就被导航取消（agent-browser 默认自动接受 beforeunload＝直接离开），草稿静默丢失 | **每章保存后必须进草稿箱实查标题**，缺失自动重传（脚本已内置，最多 3 次） |
| React 受控输入 | 直接赋 value 不生效 | native value setter ＋ `dispatchEvent(new Event('input',{bubbles:true}))` |
| ProseMirror 同步延迟 | fill 后 bodyLen 正确但点存草稿时 React state 仍为空 → 创建 0 字「未命名草稿」 | fill 后 dispatch input ＋ blur/focus，**等 2.5 秒**再点存草稿 |
| Windows 命令行长度限制 | `eval -b <base64>` 传整章正文报 "command line is too long" | 一律走 `eval --stdin`（Node `execSync` 的 `input` 传入） |
| PowerShell 管道编码 | 中文 JS 经 PowerShell 管道给 stdin 变 `null`/乱码 | 用 `ab_eval.js` 中转执行所有 eval，不经 PowerShell 管道 |
| 双层 JSON 返回 | eval 结果是字符串化的 JSON 再被包一层引号 | 解析后若 `typeof v === 'string'` 再 parse 一次 |
| 占位符选择器失效 | 正文填过后「请输入正文」文本消失，按 placeholder 找不到编辑器 | 用「可见且面积最大」选 ProseMirror，不依赖占位文本 |
| CDP 瞬时断连 | 偶发 10060 读超时 | 重试即可；`/json/version` 由浏览器主进程响应，可用来判活 |
| 源文件首行无 `# ` 前缀 | prep_chapters.py 报「首行不是标题」 | 已容错：纯文本「第N章 标题」首行也可解析 |
| 平台字数比本地少 1–2 字 | 净字数对不上但仅差极小数目 | 非截断：番茄计数不含 `〇`(U+3007)、`Ⅱ`(U+2161)、`·`(U+00B7) 等符号字 |
| 草稿箱分页 | 管理页表格最多显示 30 行，草稿超 24 篇时部分不在可见行中 | 用 `document.body.innerText.includes('第N章')` 搜索确认存在，不依赖表格行数 |
| 未命名空草稿残留 | 保存失败时产生 0 字「未命名草稿」，占草稿箱位 | 点击行尾 `icon-delete` 图标 → 确认弹窗点「删除」 |
| book_id 提取 | eval 管道返回 null | 用 `agent-browser --cdp 9222 eval "..."` 直接传参（短 JS），长 JS 用 `ab_eval.js` 中转 |

## 脚本参数说明

### prep_chapters.py

```
python prep_chapters.py -BookDir <正文目录> -From <起始章号> -To <结束章号> -Out <输出json>
```

### retry_ch.js（推荐）

```
node retry_ch.js <chapters.json> <章节index> <book_id>
```

- 单章上传，含填入→同步等待→保存→10s 落地检查→草稿箱实查全流程
- 失败自动重试 3 次，以 URL 变为 `/publish/{draft_id}` 判断保存落地
- 每章约 40 秒

### upload_chapters.js

```
node upload_chapters.js <chapters.json> <from> <to> <book_id> [startUrl]
```

- 批量模式，一次处理 from-to 范围
- `startUrl` 可选：修正已有草稿时传 `/publish/{draft_id}` 地址
- 中途校验失败即停；修复后从失败章续跑

### ab_eval.js

```
node ab_eval.js <jsfile>
```

- 从文件读取 JS 代码，经 `agent-browser eval --stdin` 执行
- 规避 PowerShell 管道编码导致的中文 JS 变乱码问题
- 内置 `execSync input` 方式传参，支持长文本（整章正文）

## 语言

跟随用户的语言回复；中文回复遵循《中文文案排版指北》。
