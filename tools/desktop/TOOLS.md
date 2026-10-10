# 兼容入口说明
原 TOOLS.md 的工具名和角色/消息格式保留于 README.md。以下旧行为已安全整改：
- gpt-read 读取当前明确目标的可见 role/text；没有 dump-dom、Cookie 或 Profile 接口。
- gpt-send / codex-send 核心 CDP 注入实现保留，但可能改变编辑焦点。CLI 默认拒绝，配置开关不能代替可信宿主的单次授权。
- 项目对话投递需要桥接登记映射与页面侧会话/项目标识一致；最近列表漂移仅在页面提供会话 ID/项目 ID 绑定的移动控件及独立单次授权时尝试修复，随后必须重读验证。
- Codex 项目投递需要本地执行位、当前 thread/project/workspace 与 Codex app state 全部一致，并在提交前重查；Work、未知状态与冲突一律阻止。
- `route-execution-guard` 是只读观察入口，不授权写入；`gpt-rename` 使用受信任宿主 API、target-bound DesktopAuthority、剪贴板文本精确读回和有界提交验证。
- 剪贴板模块只覆盖能保留的 Unicode 文本状态；发现不支持的富格式内容、焦点丢失、读回不匹配或恢复失败会明确失败。
- codex-status 使用只读 SQLite 连接，不再复制活跃 WAL 数据库到固定 /tmp 文件。
- codex-continue 的原始 Prompt 执行入口关闭，--confirm 不构成来源证明；原能力须通过 PromptPipeline 的受控传输适配器接入。
- relay gpt2codex 不再传递最后 user 消息。DOM 不能证明 GPT-6/high，所以当前拒绝自动投递。
- relay codex2gpt 只返回待审核的 Codex assistant 输出，不自动发送。
发送请求被接受不等于任务执行或独立验收通过。历史“实测可靠”不代表本轮真实桌面验证。
