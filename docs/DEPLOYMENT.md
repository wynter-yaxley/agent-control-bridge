# 部署、配置与桌面恢复

本文提供具体环境样例；通用规则见 [项目规范](PROJECT_RULES.md)。样例不是本机真实凭据、实际安装位置或已完成部署的证明。

## 配置与支持范围

Node >=24.19.0 使用内置 node:sqlite；核心 CLI 面向 Windows/Linux。Python >=3.10 用于 Windows 桌面工具，CDP WebSocket 依赖通过 `python -m pip install -r tools/desktop/requirements.txt` 显式安装。核心 Demo 无需 Python WebSocket、桌面应用、账号或付费模型。

复制 [config.example.json](../config.example.json) 为 `.bridge.config.json`，按实际环境设置路径。Node 配置优先级是 CLI > ACB_* 环境变量 > 本地文件 > 默认，相对配置路径以文件目录为准；Python 桌面工具共享该文件的 desktop 区段及 `ACB_CONFIG`、`ACB_CDP_URL`，默认从项目根目录找配置。所有输入均需校验。

样例默认：数据库 `./data/bridge.db`；Watcher `60000ms`、检测预算 `10000ms`；持续阻塞报告阈值 `600000ms`，`ACB_BLOCKED_REPORT_MS` 可覆盖。阻塞检查在下轮轮询/本地事件执行，调度延迟另计；通知写台账/stdout，Hermes 消息适配器须实际发送用户消息，不宣称单靠本地记录满足用户送达时限。

模型请求默认 `gpt-6` / `high`。当前只验证配置生效和 Mock 能力，真实模型/强度需可信适配器独立证明。应用界面或 Agent 自报不构成证明；未知能力保持 REVIEW_REQUIRED，生产自动投递拒绝。

## 身份与安全模型

默认 CLI 是当前 OS 主体、固定 local-cli instance、pi 执行者，无 reviewer。生产部署由受信任维护者按 [caller-policy.example.json](../config/caller-policy.example.json) 配置固定 `config/caller-policy.json`；示例没有真实主体，也不会自动启用。Windows 使用实际 SID，Unix 使用 uid 主体。不同 reviewer/executor 必须使用不同身份；保护策略、代码和专用数据库目录，拒绝普通 Users/Authenticated Users 写入。

不要把 reviewer 授权复制给执行者，不用 `--by user`、角色文本、环境变量或业务 JSON 授权。调用上下文和桌面批准是宿主内存句柄；只有受信任宿主可创建。能直接改宿主代码或 DB 的同 OS 代码不受进程沙箱隔离，本项目尚无多租户 IPC 认证服务。

新库 `node dist/cli.js init` 自动建 Schema v2。旧库需先用 SQLite 在线备份 API 或可靠一致快照备份；不要只拷贝正在写入的主 DB 而忽略 WAL。先在副本执行 `node dist/cli.js migrate --db COPY.sqlite`，核查数据/外键和回滚方案，再由维护者决定业务库升级。本次开发不升级真实台账。

## 项目会话登记

由受保护的 Hermes controller/reviewer OS 身份登记真实 ID：

```sh
node dist/cli.js project-register demo-project --name "Demo" --root "."
node dist/cli.js mapping-register demo-project --workspace "." --gpt GPT_CONVERSATION_ID --gpt-name "Demo" --codex CODEX_CONVERSATION_ID
node dist/cli.js mapping-show demo-project
```

这是登记，不创建外部应用或对话。一个项目一个 workspace/一个同名 GPT 对话/N 个 workspace 内 Codex 对话。例如项目名 `Agent Control Bridge` 对应 GPT 对话名也为 `Agent Control Bridge`。实际名称与归属由适配器在生成前、来源回执及投递目标再次核对，不从登记文本推断界面已重命名。

多个项目分别登记并设置任务优先级；控制者事先分配应用会话、并发和资源预算。当前无自动多项目资源调度器，不能以混用另一个项目会话绕过资源不足。

## 桌面工具与受控接口

外部 Agent 应用需由用户安装并登录。默认 desktop.enabled=false，前台与物理输入关闭。读取可见消息可能包含私人业务内容，须获相应访问范围授权；不读取 Cookie/Profile/登录库。发送实现保留原算法但可能改变编辑焦点，只能由可信宿主单次授权调用；裸 CLI 发送默认阻塞。完整工具说明见 [desktop README](../tools/desktop/README.md)。

配置样例 CDP 是 `http://127.0.0.1:9222`，可配置端口；仅允许回环 HTTP/WS，不跟随重定向至外部地址。恢复 origin 样例为 `*`，兼容用户要求，但它扩大调试接口可访问来源；部署者应优先采用实际客户端支持的受限本机 origin，不把端点暴露到公网。不要导出浏览器会话秘密。

## GPT 闪退与恢复部署流程

1. 可信宿主检查进程和调试接口，区分确定退出、仍运行、状态未知。单独 CDP 不可达不能证明闪退。
2. 先向用户报备事件与已知证据；为此事件取得明确、单次恢复授权。不得结束仍运行的应用，也不能切换前台或模拟物理输入。
3. 宿主使用已配置安装入口恢复，参数由配置端点及 origin 生成。采用默认样例时为 `--remote-debugging-port=9222` 与 `--remote-allow-origins=*`；不能把参数写死到业务模块。
4. 在 **Windows 侧 Python** 检查 CDP：`python tools/desktop/recovery.py --check-cdp`。WSL 的回环网络可能无法到达 Windows 回环；不要用 WSL curl 失败推断 Windows 应用已退出。
5. 校验接口、实际模型能力、登记的同名 GPT 会话和 Codex workspace 映射。接口可达不证明登录、模型、会话恢复或任务完成。
6. 恢复来源记录和不确定投递状态，核实后继续；来源或目标错配保持阻塞，不能重复发送已可能投递的 Prompt。

`recovery.py` 提供宿主注入 probe/notify/restart/restore_mapping 的事件授权流程；默认 CLI 仅诊断，不启动应用。实际 MSIX 安装是否接受这些参数、无焦点影响的启动方式及真实模型证明 **尚未验证**，不报告已恢复。本次没有重启任何真实 Agent。

## 故障分类

CLI 输出可诊断的 code 与非零退出码，不输出原始认证/SQL异常。INPUT/CONFIG 检查样例字段；AUTH/OWNER 检查宿主身份；PROVENANCE/UNSUPPORTED 检查来源及实际能力；CONFLICT 先查最新版本；DB/SCHEMA 先备份、副本演练；TIMEOUT 检查检测是否合作取消。取消和恢复仅改台账，不证明外部执行已停止。

业务保留周期、备份 RPO/RTO 和恢复演练由部署者按实际数据要求确定；当前不自动清理业务记录。只清理有归属证据的隔离测试残留。
