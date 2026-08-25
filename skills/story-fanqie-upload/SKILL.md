# Skill: story-fanqie-upload

# 番茄小说批量存草稿

通过 CDP 浏览器自动化，把本地章节文件批量上传到番茄小说作家后台并存为草稿。
已在真实后台全流程验证（2026-08-22，《全民修仙，我狂点科技树》第 3–10 章）。

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
Get-Process -Name msedge -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep 3

# 2) 拷贝登录态到独立调试目录（Local State 含 Cookie 解密密钥，必须拷）
$src = "$env:LOCALAPPDATA\Microsoft\Edge\User Data"
$dst = "$env:USERPROFILE\edge-debug-profile"
# 拷贝清单：
#   Local State                          （根目录，密钥）
#   Default\Preferences
#   Default\Network\Cookies (+ -journal)
#   Default\Local Storage\  Default\Session Storage\   （整目录递归）

# 3) 启动
Start-Process "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  -ArgumentList "--remote-debugging-port=9222", "--user-data-dir=`"$dst`"", `
                "--remote-allow-origins=*", "--no-first-run", "--no-default-browser-check"

# 4) 验证：GET http://127.0.0.1:9222/json/version 应返回 Browser=Edg/xxx
```

- **首次使用**：打开 `https://fanqienovel.com/main/writer/home`，若跳转 `/login` 则请用户在调试窗口扫码登录一次；登录态持久保存在调试目录，之后免登录。
- 登录失效时：删除 `$dst` 重新拷贝＋重新扫码。

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

## 上传流程

### Step 1：准备章节数据

```powershell
python scripts\prep_chapters.py -BookDir "D:\novel\<书名>\正文" -From 3 -To 10 -Out chapters.json
```

- 源文件格式：首行 `# 第N章 标题`，其余为正文段落
- 输出 JSON 数组：`{index, file, title(含前缀), body, body_chars(去空白净字数)}`
- 自动清理 `**加粗**`/`*斜体*` 残留

### Step 2：试传单章（必做）

先用第一章单独跑通全链路，确认草稿箱出现该章后再批量：

```powershell
node scripts\upload_chapters.js chapters.json 3 3 <book_id>
```

脚本行为：打开新建章节页 → 填序号/标题/正文 → 回显校验 → 点存草稿 → 等 5 秒 → 打开下一章页面；结束后自动进草稿箱列出结果。

### Step 3：批量上传

```powershell
node scripts\upload_chapters.js chapters.json 4 10 <book_id>
```

### Step 4：草稿箱核验

对照平台字数与本地 `body_chars`：**两者应完全一致**（番茄按去空白字符计数）。不一致＝截断/丢段，重跑该章。

## 坑位清单（全部实测踩过）

| 坑 | 现象 | 对策 |
|----|------|------|
| 默认 profile 禁调试 | 进程带参启动但 9222 不通 | 独立 `--user-data-dir` ＋拷登录态（见环境准备） |
| beforeunload 离开拦截 | 未保存就导航 → `ERR_ABORTED`，残留模态框卡死后续 CDP（10060 超时） | 点完存草稿**等 5 秒**再导航；导航失败重试 3 次 |
| 保存无 toast 信号 | 轮询「保存成功」等文案永远空 | 放弃信号检测，以草稿箱列表为准做终验 |
| save-click 成功 ≠ 已保存 | 点击返回 ok，但保存请求未落地就被导航取消（agent-browser 默认自动接受 beforeunload＝直接离开），草稿静默丢失 | **每章保存后必须进草稿箱实查标题**，缺失自动重传（脚本已内置，最多 3 次） |
| Windows 命令行长度限制 | `eval -b <base64>` 传整章正文报 "command line is too long" | 一律走 `eval --stdin`（Node `execSync` 的 `input` 传入） |
| PowerShell 管道编码 | 中文 JS 经 PowerShell 管道给 stdin 变 `null`/乱码 | 用 Node 脚本中转执行所有 eval，不经 PowerShell 管道 |
| 双层 JSON 返回 | eval 结果是字符串化的 JSON 再被包一层引号 | 解析后若 `typeof v === 'string'` 再 parse 一次 |
| 占位符选择器失效 | 正文填过后「请输入正文」文本消失，按 placeholder 找不到编辑器 | 用「可见且面积最大」选 ProseMirror，不依赖占位文本 |
| React 受控输入 | 直接赋 value 不生效 | native value setter ＋ `dispatchEvent(new Event('input',{bubbles:true}))` |
| CDP 瞬时断连 | 偶发 10060 读超时 | 重试即可；`/json/version` 由浏览器主进程响应，可用来判活 |

## 参数说明

`upload_chapters.js <chapters.json> <from> <to> <book_id> [startUrl]`

- `startUrl` 可选：第一章改用指定 URL 打开（如修正已有草稿时传草稿的 `/publish/{draft_id}` 地址）
- 中途校验失败即停（不保存脏数据），已成功章节不受影响；修复后从失败章续跑

## 语言

跟随用户的语言回复；中文回复遵循《中文文案排版指北》。
