# 兼容入口说明
原 TOOLS.md 的工具名和角色/消息格式保留于 README.md。以下旧行为已安全整改：
- gpt-read 读取当前明确目标的可见 role/text；没有 dump-dom、Cookie 或 Profile 接口。
- gpt-send / codex-send 核心 CDP 注入实现保留，但可能改变编辑焦点。CLI 默认拒绝，配置开关不能代替可信宿主的单次授权。
- codex-status 使用只读 SQLite 连接，不再复制活跃 WAL 数据库到固定 /tmp 文件。
- codex-continue 的原始 Prompt 执行入口关闭，--confirm 不构成来源证明；原能力须通过 PromptPipeline 的受控传输适配器接入。
- relay gpt2codex 不再传递最后 user 消息。DOM 不能证明 GPT-6/high，所以当前拒绝自动投递。
- relay codex2gpt 只返回待审核的 Codex assistant 输出，不自动发送。
发送请求被接受不等于任务执行或独立验收通过。历史“实测可靠”不代表本轮真实桌面验证。
