# 开发、验证与发布

使用者安装和操作见 [README](../README.md)；通用规范见 [PROJECT_RULES](PROJECT_RULES.md)。本文集中说明工程过程、质量门禁及未验证范围，不充当独立验收。

## 模块与扩展

CLI 解析输入并调用配置、TaskStore、ConversationRegistry 和 Provider；TaskStore 使用 caller context、CAS、短事务和审计；PromptPipeline 独立负责来源/能力/哈希及不确定投递；Watcher 观察台账，绝不升级验收结果。SQLite Schema 由线性迁移管理，核心使用内置 node:sqlite。

可信宿主安装 `ChatgptAdapter` 和 CodexTransport。生成接口必须独立证明 actualModel、actualReasoningEffort、来源消息和登记会话/名称；投递 target 与回执须属于项目 workspace/Codex 对话。普通 JSON、自报 source 或修改工程文本不会获得授权。当前无可靠真实桌面模型证明适配器，生产自动链路保持拒绝。

不确定投递留 DELIVERING，人工独立检查后才恢复；外部网络发送与 SQLite 没有分布式原子事务。新增执行者类型需同时更新类型、CLI、Schema 兼容迁移及失败合约，避免引入未实际需要的大型编排框架。

## 验证命令

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run test:e2e
npm run test:desktop
npm run check
npm audit
npm run test:install
```

`test` 真实发现 test 文件，零测试失败；`test:e2e` 隔离 CLI 和 Mock 生命周期；`test:desktop` Python Mock/安全/恢复合约，不访问真实桌面；`test:install` 在全新临时路径复制公开源文件，npm ci、编译、测试、Demo，结束清理。Windows/Linux CI 不需要本机盘符、账号、真实 API 或已登录应用。

测试类型与结果分别列 Unit、Integration、Desktop Mock、External Agent。真实桌面、模型、飞书通知、前台效果和 MSIX 恢复未覆盖；不能因为 npm test 通过把它们标为 PASS。Windows 专属系统路径防影子测试在 Linux 显式跳过，跳过不计通过。未配置 Lint，不编造 lint 成功。

## 回归重点

- 配置默认、覆盖顺序、Unicode/空格路径、未知字段及非法值拒绝。
- 双领取 barrier 恰一成功，事件/审计写故障整体回滚，旧 holder/instance/attempt/版本拒绝，执行者不能自验或直接 SQL 置成功。
- 来源缺失/伪造/篡改、未知能力、重复及不确定投递、跨项目会话/名称错配、生产拒绝 Mock。
- Watcher 默认周期、事件、持久去重、重启恢复、慢检测/取消及持续阻塞阈值；续租不得重置阻塞起点。输出/网络发送需要消费者按稳定记录幂等消费。
- 新建、旧版本升级、重复迁移、非法历史数据/未来版本、失败回滚与外键保留。
- 导出同路径/已有输出/大小写扩展名拒绝且原文件 hash 不变；无授权桌面写入在任何输入动作前拒绝，Fake CDP 验证保留算法与异常关闭。

验收探针使用唯一隔离库，清理测试创建的资源，不把模拟来源写进业务库。定期核对已确认残留；未知归属不能删除。多项目应预先分配优先级、应用会话和资源预算，禁止跨项目混用。

## 安全与公开门禁

`check` 检查工作树及全部 Git refs 的独立 blob、常见秘密/本机标识、敏感路径忽略、必要文件可跟踪、CLI help、Markdown 链接、SVG/XML 和打包清单。基础模式扫描不能排除未知凭据或私密业务文本；疑似真实秘密应停止公开操作，由所有者处理。审查只展示脱敏位置，不复制值或使用凭据。

GitHub Actions 最小 contents:read，固定官方 Action commit，Windows/Linux 环境覆盖，默认不调用外部付费 Agent。已授权工具非交互运行，隐藏窗口、超时、有限输出、结构化脱敏错误。认证失败立即停相应操作，不弹登录、不提取 GCM Token，不改认证配置、不强推。

公开前核对 remote/branch/未知修改、完整历史、数据/日志/个人配置、许可、README/图资源、构建及隔离安装。推送后独立比较远端 commit 和交付文件，查询 GitHub 可见性及匿名访问；CI 实际状态单列，配置语法通过不能冒称远端运行成功。

## 版本、交付与验收

package.json 使用 SemVer；行为变化写 [CHANGELOG](../CHANGELOG.md) Unreleased。正式 Release 在 Hermes 独立验收后，给确定 commit 打对应版本 tag 并创建 GitHub Release；本次开发不会自行生成验收结论或用发布代替验收。

原始 [审查](audit/CODE_AUDIT_REPORT.md) 保留，逐项 [整改](audit/REMEDIATION.md) 记录文件、方法、回归和未完成原因。[交付记录](audit/DELIVERY.md) 区分 PASS/FAIL/SKIPPED/NOT_VERIFIED。独立验收固定 [结论 / 证据 / 遗留](ACCEPTANCE_TEMPLATE.md)；最终任务状态由 Hermes 控制。

控制者发现任务持续阻塞超过配置阈值必须如实报备，不能静默无限重试。Watcher 提供本地持久观察；真正用户消息与送达证据由外部控制者负责。默认值及具体部署步骤集中在 [DEPLOYMENT](DEPLOYMENT.md) 和配置样例。
