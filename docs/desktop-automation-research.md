> 历史研究记录：不作为当前能力或授权依据。旧直接发送/启动示例未经过当前来源与前台权限门禁；以 README、tools/desktop/README.md 和工作恢复规范为准。

# 桌面应用自动化生态调研（GPT/Codex × 飞书 × Hermes）

> 调研日期 2026-10-09 · 需求：Hermes 实时看 ChatGPT(UWP) 对话 + Codex 项目进度，飞书遥控 GPT/Codex，GPT 提示词 relay 给 Codex
> 验活口径：GitHub stars + pushed 时间（SOCKS 实测 API），全部 2026-10 验证

## 一、需求 → 现成项目匹配矩阵

| 需求点 | 最佳现成项目 | 星/活跃 | 匹配度 |
|---|---|---|---|
| 飞书遥控 Codex（续聊/审批/看进度/成果） | **kxn/codex-remote-feishu** | ★329 / 10-01 | 高 |
| 同上（备选，Windows 专项） | **dizzynote-cell/codex-remote-bridge** | ★101 / 10-06 | 高 |
| 同上（备选，App Server 深集成） | tianniansz/feishu-codex-bridge (npm) | ★1 / 07-30 | 中（文档最全、安全设计最好） |
| 同上（飞书+微信 双通道） | GavinYangAI/Comote | ★19 / 08-31 | 中 |
| 实时读 ChatGPT 桌面对话 | **OpenCLI**（chatgpt-app 适配器 CDP 模式） | ★29,969 / 09-24 | 中-高（macOS 亲测路线，Win 需 POC） |
| 向桌面应用注入提示词 | yorkartur/codex-desktop（CDP 注入桌面聊天） | ★10 / 07-16 | 中（手法可复用） |
| Windows GUI 通用读屏/操控 | **microsoft/UFO³** | ★9,972 / 10-07 | 中（兜底方案） |
| Codex 进度/成果本地直读 | Codex CLI v0.145+ SQLite 会话档案 + App Server | 官方 | 高（零依赖） |

## 二、官方通道（不用第三方就能拿到的能力）

1. **ChatGPT 桌面 Remote connections**（learn.chatgpt.com/docs/remote-connections）
   手机↔桌面官方配对：续聊、审批、看 diffs/测试/终端输出/截图、完成通知。
   限官方 ChatGPT App 作客户端，非公开 API —— Hermes 接不进去，但说明桌面会话数据官方有流。
2. **Codex App Server**（experimental）：会话历史、thread/resume、流式事件。
   feishu-codex-bridge（tianniansz）正是基于它——这是官方认可的深度集成面。
3. **Codex Computer Use**（官方）：Codex 自己操控电脑（YouTube: "How to Automate Any App
   with OpenAI Codex Computer Use"、"Windows Computer Use and mobile access for Codex"）。
4. **Codex 跨端会话同步**：CLI/Desktop/Mobile 共享会话（SQLite 档案可直接读进度）。

## 三、读 ChatGPT 对话的三条技术路线（核心难点）

- **A. CDP 直连（推荐 POC）**：ChatGPT.exe 是 Electron(Chromium 155)，带
  `--remote-debugging-port=9222` 启动即可用 Chrome DevTools Protocol 读 DOM/抓流式响应。
  OpenCLI chatgpt-app 适配器与 grok-bot-cli 的 chatgpt-desktop.md 均记录了此路线。
  ★UWP/MSIX 变数：AUMID 启动不带自定义参数，需直接执行 WindowsApps 内 exe 带旗标——需 5 分钟实测。
- **B. UI Automation 读屏**：microsoft/UFO³ / pywinauto / FlaUI 读无障碍树。Electron 应用暴露
  不稳定，兜底用。
- **C. 官方导出**：静态补充（已实装 chatgpt-import）。

## 四、B 站/小红书/YouTube 检索结论

- B 站：**BV1jKPaz5Eym《Codex 接入飞书教程，手机远程操控电脑写代码》**——完整场景教程实存。
- 飞书官方社区：《Claude Code/Codex 接入飞书教程》(feishu.cn/content/article/7647408304896953549)。
- 小红书：封闭站外检索不到（无公开索引），非项目来源。
- YouTube：Codex Computer Use 系列教程（官方能力演示）。

## 五、推荐落地组合

1. **kxn/codex-remote-feishu（★329）** 装上实测——飞书遥控 Codex、看进度/成果一步到位。
   备选 dizzynote（★101，更新更活跃）。不满足处再看 tianniansz（App Server 深集成+安全设计）。
2. **OpenCLI CDP 路线做 POC**：ChatGPT.exe 带调试端口重启 → CDP 读对话流 → Hermes relay 提示词给 Codex。
3. **编排层用现有家底**：Hermes(飞书 bot) + Agent Control Bridge 状态机管"GPT 提示词→Codex 任务→验收"。
4. 兜底：UFO³ 读屏。

## 六、候选项目验活明细

| 仓库 | ★ | 最近推送 | 备注 |
|---|---|---|---|
| jackwener/OpenCLI | 29,969 | 2026-09-24 | 网站→CLI + 登录态浏览器 agent；桌面适配器 |
| microsoft/UFO | 9,972 | 2026-10-07 | UFO³ Windows GUI 代理 |
| openai/codex | 128,385 | 2026-10-09 | 官方；discussion #9200 远程控制诉求 |
| kxn/codex-remote-feishu | 329 | 2026-10-01 | 飞书×Codex 最高星 |
| dizzynote-cell/codex-remote-bridge | 101 | 2026-10-06 | 飞书+浏览器 遥控 Windows Codex |
| henryjing96/feishu-codex-bridge | 17 | 2026-04-24 | 私聊/群聊/话题、流式卡片 |
| GavinYangAI/Comote | 19 | 2026-08-31 | 飞书+微信×Codex Desktop |
| yorkartur/codex-desktop | 10 | 2026-07-16 | CDP 注入 Codex 桌面聊天 |
| toby1991/chatgpt-cli | 4 | 2026-03-14 | macOS 控 ChatGPT 桌面 + MCP |
| tianniansz/feishu-codex-bridge | 1 | 2026-08-05 | App Server 深集成、安全设计最全 |

---

## 七、落地结论（2026-10-10 实测，非纸面推断）

### P0 CDP 起 ChatGPT.exe —— 成功 ✅
- 直接执行 `WindowsApps\OpenAI.Codex_26.1002.7124.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe`，带参数启动成功。
- **必须参数**：`--remote-debugging-port=9222` 与受限回环 origin（历史记录曾用 `--remote-allow-origins=*`；当前配置校验拒绝通配符，必须用与端点一致的受限 origin，如 `http://127.0.0.1:9222`）。
- **无效参数**：`--remote-debugging-address=0.0.0.0` 不生效（CDP 仍监听 127.0.0.1）。
- 验证：`curl http://127.0.0.1:9222/json/version` 返回 Chrome/155；`/json` 列出 7 个 target。

### CDP 读渲染层 —— 成功 ✅（但结构要点）
- 对话正文在 **chatgpt.com 嵌入 webview**（target type=webview），不在主页面 `app://-/index.html`（那是 Codex 外壳/侧栏）。
- `gpt-read` 能读 webview 的 `document.body.innerText`，拿到真实界面内容（聊天列表、项目名、对话标题等）。
- 对话消息（正文）读取需"打开了具体对话"的前提；停在列表界面时只读到列表，已诚实标注。

### CDP 注入 —— 成功 ✅（已完整闭环）
- 注入手法（yorkartur 式）实测：`document.execCommand('insertText')` + 手动 `InputEvent` 能真正把文本放进 `#prompt-textarea`（`Input.insertText` 对 React contenteditable **不生效**）。
- **新对话流程**：先点"新聊天"按钮 → 轮询等 `#prompt-textarea` 出现 → 再注入 → 点发送按钮。直接注入到历史列表界面会触发"无法加载此 ChatGPT 对话"。
- **实测证据**：注入"测试消息"后，ChatGPT 界面真实出现"你说：测试消息… / ChatGPT 说：收到"；时序差分（发完快照 vs 25s 后快照）能反映新增回复。

### 网络隔离 —— 关键约束 ⚠️
- WSL(NAT) 无法访问 Windows 的 127.0.0.1:9222。
- netsh 端口转发需管理员权限（不可行，且违反"不需要管理员权限"验收项）。
- **解法**：gpt-read/gpt-send 是 WSL shell 包装，内部调 Windows 侧 Python 3.12（`C:\Users\[USER]\AppData\Local\Programs\Python\Python312\python.exe`）访问 CDP。已装 websocket-client 1.9.2。

### 结论
- **CDP 路线完整可用**：起调试端口、读渲染层、新建对话、注入、发送、读回复，全链路实测通过。
- 零凭据泄漏（只读 CDP 渲染层，不碰 Cookie/token）；失败场景如实报错。

## 八、codex-send 与 relay 落地结论（2026-10-10 追加）

### codex-send（Codex 界面可见注入）—— 成功 ✅
- Codex 桌面 composer 是 **ProseMirror** 编辑器（`.ProseMirror[contenteditable=true]`），在 `app://-/index.html` shell 页面。
- 注入手法：`Input.insertText`（ProseMirror 监听 beforeinput，正确接收）+ `Input.dispatchKeyEvent Enter` 提交。
- 实测：注入"你好，请回复收到" → Codex 界面真实显示，回复"收到"（时间戳 3:36），用户可见可接管。
- 与 ChatGPT 的差别：ChatGPT 的 React contenteditable 用 `Input.insertText` 不生效（需 execCommand+input事件）；Codex 的 ProseMirror 用 `Input.insertText` 生效。

### relay（GPT↔Codex 双向中转）—— 成功 ✅
- `relay gpt2codex`：读 chatgpt.com webview 最后一条用户消息 → codex-send 发 Codex。实测通过。
- `relay codex2gpt`：读 app:// Codex 界面最后回复 → gpt-send 发 GPT。实测通过。
- 提取逻辑用 innerText 行解析（"你说："/"ChatGPT 说："标记），DOM 变化时容错降级，解析失败如实报错。

### 最终能力清单（对照用户需求）
1. 飞书 Hermes 实时看 GPT/Codex 对话 → gpt-read + codex 界面读 ✅
2. GPT 提示词 → Codex → relay gpt2codex / codex-send（界面可见）✅
3. Codex 总结 → GPT → relay codex2gpt / gpt-send ✅
4. Codex 运行状态 → codex-status ✅
5. 全程只通过飞书和 Hermes 交流 → 工具全部 CLI 化，供 Hermes 调用 ✅

## 九、返工修复记录（2026-10-10 第二轮，响应 Hermes 验收）

### 修复项（4 项全完成）
1. **relay 结构化提取**：弃用文本行启发式，改 `H4.sr-only`（角色标记："你说："/"ChatGPT 说："）+ 父级 block（正文）+ 过滤 unknown sr-only（UI 文案）。实测 user/assistant 清晰分离、无时间戳噪声。
2. **mismatch 中止**：`codex_send_cdp.py` 注入后验证 composer 文本，`prompt not in composer` 即 `exit 4` 中止，绝不 Enter 提交。
3. **gpt-read 选择器修复**：`data-message-author-role` 在当前 build 不命中，改 `H4.sr-only` 结构化提取（两界面同构）。
4. **负例保护**：`relay.py` 提取为空（无 user/无 assistant）即 `exit 3` 不提交；`codex_send_cdp.py` mismatch 即 `exit 4` 不提交。

### 额外发现的坑（已修）
- **Codex 界面有两个 composer**：`aria="询问 ChatGPT"`（ChatGPT 模式）与 `aria="使用 ChatGPT Work"`（Codex 工作区）。`querySelector('.ProseMirror')` 选到第一个（空），导致注入到错误 composer + 验证读空。修复：优先选 `[aria-label*="Work"] / [aria-label*="Codex"]`。

### 关键事实（两界面同构）
- ChatGPT webview 与 Codex 界面（app://）的对话 UI 结构**完全一致**：`H4.sr-only` 是角色标记，父级 block 是正文。因此 `cdp_messages.py` 一个结构化提取器同时服务两界面（参数 webview/page）。

## 十、返工修复记录（第三轮，响应 Hermes 复验）

### composer 选择器反向修复 → 已改正
- 问题：Codex 界面有两个 `aria-label` **完全相同**的 ProseMirror composer（一个 hidden 0×0，一个 visible 712×44）。`[aria-label*="Work"]` querySelector 永远挑中隐藏的 → insertText 落可见、验证读隐藏 → 全误报 mismatch。
- 修复：按**可见性**选 composer（`offsetParent !== null && getBoundingClientRect().width > 0 && height > 0`），删掉 aria-label 优先。验证逻辑同步用可见性选择器。
- gpt-send 一并改为可见性优先（chatgpt.com 当前只有一个可见输入框，属防御性加固）。
- 实测：codex-send "可见性修复测试" 注入 ok + submitted ok；relay gpt2codex 全链路（读 GPT user → 注入 Codex 可见 composer）打通。

### 本轮教训（写入文档，防止重犯）
- **写选择器前先 DOM 实测**（拿 offsetParent/rect 数据），不要凭 aria-label/class 猜测。
- **可见性优先**：同 aria/class 的隐藏副本（0×0）是 Electron 应用的常见陷阱，一律用可见性过滤。

## 十一、返工修复记录（第四轮，响应 Hermes 第三轮复验）

### 空输入穿透安全闸 → 已修
- 漏洞：`codex-send ""` 时，验证条件 `prompt.strip() not in txt` 中 `"" in 任何文本` 恒真，验证形同虚设，把 composer 残渣误提交。
- 修复（两行）：
  1. 入口拒空：`prompt.strip()` 为空 → `exit 2`，一个字节都不碰 composer（codex-send + gpt-send 双改）。
  2. 验证严格相等：`txt.strip() != prompt.strip()` → mismatch `exit 4`（替代 `not in`）。
- 负例四连测全通过：空串(exit2)、纯空白(exit2)、\r 混入(exit4 mismatch)、超长(exit4 mismatch)；退出码契约正确（2=参数错，4=mismatch）。

## 十二、返工修复记录（第五轮，响应 Hermes 第四轮复验）

### "脏 composer 锁死发送" → 已修
- 缺陷：注入是追加 + 验证严格相等，composer 含任何残渣/草稿时永远 mismatch，发送锁死。
- 修复（推荐方案）：composer **非空即拒绝**（exit 3，`{"error":"composer 非空（含未发送草稿），未触碰"}`），不破坏用户草稿；配 `--force-clear` 旗标供编排层显式清空。
- 三场景实测：干净发送(exit0) / 脏 composer 拒绝(exit3 不碰草稿) / --force-clear 清空发送(exit0)，全通过。
- codex-send 与 gpt-send 双改一致。
