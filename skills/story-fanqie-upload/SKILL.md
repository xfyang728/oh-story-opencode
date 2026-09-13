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
| 编辑已有章节 | `https://fanqienovel.com/main/writer/{book_id}/publish/{draft_id}?enter_from=modifychapter` |
| 编辑草稿 | `https://fanqienovel.com/main/writer/{book_id}/publish/{draft_id}?enter_from=modifydraft` |

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

## 定时发布工作流

章节上传为草稿后，需逐章走发布流程设置定时发布时间。**每章独立操作，不可跳步。**

### 单章发布流程（7 步）

```
编辑页 → 下一步 → [提交] → 仅基础检测 → 设置发布参数 → 确认发布
```

#### Step 1：打开编辑页

草稿编辑 URL 格式：`https://fanqienovel.com/main/writer/{book_id}/publish/{draft_id}?enter_from=modifydraft`

获取草稿编辑链接：

```powershell
agent-browser --cdp 9222 open "https://fanqienovel.com/main/writer/chapter-manage/<book_id>&type=1"
agent-browser --cdp 9222 wait 3000
# 点击「草稿箱」tab
agent-browser --cdp 9222 snapshot -i
# 从 snapshot 找到草稿箱 tab ref，点击
agent-browser --cdp 9222 click "@e{tab_ref}"
agent-browser --cdp 9222 wait 3000
# 提取所有草稿编辑链接
agent-browser --cdp 9222 eval "JSON.stringify([...document.querySelectorAll('a[href*=\"modifydraft\"]')].map(a=>({ch:a.closest('tr')?.querySelector('td')?.textContent?.trim()||'?',href:a.href})))"
```

#### Step 2：点击「下一步」

```powershell
agent-browser --cdp 9222 open "<编辑页URL>"
agent-browser --cdp 9222 wait 5000
agent-browser --cdp 9222 eval "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('下一步')).click()"
agent-browser --cdp 9222 wait 2000
```

#### Step 3：处理「提交」确认弹窗（可能不出现）

若检测到错别字/风险内容，会弹出「发布提示」对话框：

```powershell
agent-browser --cdp 9222 eval "[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='提交')?.click()"
agent-browser --cdp 9222 wait 3000
```

#### Step 4：选择「仅基础检测」

弹出「请选择内容检测方式」对话框：

```powershell
agent-browser --cdp 9222 eval "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('仅基础检测')).click()"
agent-browser --cdp 9222 wait 3000
```

#### Step 5：设置发布参数

发布设置弹窗包含：AI 标记、定时发布开关、日期选择器、时间选择器。

```powershell
# 5a) 勾选「是否使用AI=是」
agent-browser --cdp 9222 eval "(function(){const r=[...document.querySelectorAll('input[type=radio]')].find(r=>r.parentElement&&r.parentElement.textContent.includes('是'));if(r)r.click();return 'ai';})()"
agent-browser --cdp 9222 wait 500

# 5b) 开启「定时发布」开关（关闭状态时需点击开启）
agent-browser --cdp 9222 eval "(function(){const s=[...document.querySelectorAll('[role=switch]')].find(s=>s.parentElement?.textContent?.includes('定时发布'));if(s&&s.getAttribute('aria-checked')!=='true')s.click();return 'sw';})()"
agent-browser --cdp 9222 wait 1000

# 5c) 设置日期 — 点击日期输入框 → 在日历中点击目标日
agent-browser --cdp 9222 eval "(function(){const d=document.querySelector('input[placeholder*=\"日期\"]');if(d)d.click();return 'dc';})()"
agent-browser --cdp 9222 wait 500
agent-browser --cdp 9222 eval "(function(){const cells=[...document.querySelectorAll('[class*=cell]')];const t=cells.find(c=>c.textContent.trim()==='DD'&&!c.className.includes('prev')&&!c.className.includes('next'));if(t)t.click();return 'ok';})()"
agent-browser --cdp 9222 wait 500
# ⚠️ 将 DD 替换为目标日期的日（如14、15、16、17）

# 5d) 设置时间 — 点击时间输入框 → 选择小时00 → 选择分钟01 → 点确定
agent-browser --cdp 9222 eval "(function(){const t=document.querySelector('input[placeholder*=\"时间\"]');if(t)t.click();return 'tc';})()"
agent-browser --cdp 9222 wait 500
agent-browser --cdp 9222 eval "(function(){const items=[...document.querySelectorAll('li')];const h=items.find((li,i)=>li.textContent==='00'&&i<24);if(h)h.click();return 'hr';})()"
agent-browser --cdp 9222 wait 300
agent-browser --cdp 9222 eval "(function(){const items=[...document.querySelectorAll('li')];const m=items.filter(li=>li.textContent==='01');if(m.length>1)m[1].click();else if(m[0])m[0].click();return 'mn';})()"
agent-browser --cdp 9222 wait 300
agent-browser --cdp 9222 eval "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('确定')).click()"
agent-browser --cdp 9222 wait 500
```

#### Step 6：验证参数

```powershell
agent-browser --cdp 9222 eval "JSON.stringify({d:document.querySelector('input[placeholder*=\"日期\"]')?.value,t:document.querySelector('input[placeholder*=\"时间\"]')?.value})"
# 期望输出：{"d":"2026-09-15","t":"00:01"}
```

#### Step 7：确认发布

```powershell
agent-browser --cdp 9222 eval "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('确认发布')).click()"
agent-browser --cdp 9222 wait 5000
# 验证：页面应回到章节管理页，该章显示「审核中」+ 正确时间
agent-browser --cdp 9222 eval "document.body.innerText.substring(0, 500)"
```

### 批量定时发布脚本

逐章执行上述 7 步。每章约 30–40 秒，12 章约 6–8 分钟。

```powershell
# 示例：70-81 章定时发布（每天3章，00:01 发布）
$chapters = @(
  @{ch=70; date="2026-09-14"}, @{ch=71; date="2026-09-14"},
  @{ch=72; date="2026-09-15"}, @{ch=73; date="2026-09-15"}, @{ch=74; date="2026-09-15"},
  @{ch=75; date="2026-09-16"}, @{ch=76; date="2026-09-16"}, @{ch=77; date="2026-09-16"},
  @{ch=78; date="2026-09-17"}, @{ch=79; date="2026-09-17"}, @{ch=80; date="2026-09-17"}, @{ch=81; date="2026-09-17"}
)
# 对每个 $c 执行 Step 1-7
```

### 定时发布坑位

| 坑 | 现象 | 对策 |
|----|------|------|
| 日历选择器遮挡确认按钮 | 设置日期后日历面板仍在，点击确认会被日历拦截 | 先点击日历中的目标日期（关闭面板），再点确认 |
| 定时发布开关未开启 | 发布参数区不显示日期/时间输入框 | 检查 `[role=switch]` 的 `aria-checked`，未开启则点击 |
| 时间选择器列歧义 | 小时和分钟都显示00-23/00-59，选择分钟01时可能选到小时列 | 分钟列用 `filter(li=>li.textContent==='01')` 取第二个（`m[1]`） |
| 草稿编辑链接格式 | 草稿是 `modifydraft`，已发布章节是 `modifychapter` | 提取链接时注意区分 `enter_from` 参数 |
| 「提交」弹窗不一定出现 | 无错别字/风险时直接跳到检测方式选择 | 用 `?.click()` 安全调用，不报错即可 |

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
