-- Agent Control Bridge — SQLite schema
-- 持久化任务管理系统。核心原则：
--   1. 任务状态由系统事实（真实观察/独立验收）驱动，不由模型文字"已完成"驱动。
--   2. 失去连接 ≠ 完成。
--   3. 所有高风险操作（取消/审批/覆盖）留审计日志。

-- Connection PRAGMAs are applied by db.ts before the migration transaction.

-- ============ 项目 ============
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  root_path  TEXT NOT NULL,
  kind       TEXT NOT NULL,               -- quant | video | bridge | ...
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ============ 会话（Codex thread / ChatGPT 会话 / Pi 会话）============
CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,        -- 本地 uuid
  external_id    TEXT,                    -- 外部 thread id / 会话 id
  project_id     TEXT,
  source         TEXT NOT NULL,           -- codex | chatgpt | pi | manual
  title          TEXT,
  state          TEXT NOT NULL DEFAULT 'unknown',  -- active | archived | unknown
  last_observed_at TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

-- ============ 任务 ============
-- status 合法值：QUEUED / RUNNING / WAITING_APPROVAL / BLOCKED / SUCCEEDED / FAILED / CANCELLED / UNKNOWN
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  project_id  TEXT,
  session_id  TEXT,
  kind        TEXT NOT NULL,              -- dev | review | fix | sync | audit | ...
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'QUEUED',
  executor    TEXT,                       -- codex | pi | chatgpt | hermes
  priority    INTEGER NOT NULL DEFAULT 0,
  claimed_by  TEXT,                       -- 当前执行者身份（防双写）
  claimed_instance TEXT,
  attempt_executor TEXT,
  attempt_instance TEXT,
  created_by TEXT,
  created_instance TEXT,
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
  claim_expires_at TEXT,                  -- 心跳/租约过期时间（失去连接≠完成）
  error       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  started_at  TEXT,
  finished_at TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(session_id)  REFERENCES sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);

-- ============ 任务事件（真实观察，非模型宣称）============
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL,
  type        TEXT NOT NULL,              -- created | claimed | progress | executor_finished | observed_* | verified_* | failed | cancelled
  payload     TEXT,                       -- JSON
  source      TEXT NOT NULL,              -- 事件来源（codex/pi/hermes/system/observer）
  observed_at TEXT NOT NULL,              -- 真实记录时间
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id);

-- ============ 审批 ============
CREATE TABLE IF NOT EXISTS approvals (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL,
  action       TEXT NOT NULL,             -- approve | reject | high_risk_confirm
  requested_by TEXT,
  requested_at TEXT,
  decided_by   TEXT,
  decided_at   TEXT,
  decision     TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  reason       TEXT,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);

-- ============ 交付文件 ============
CREATE TABLE IF NOT EXISTS deliverables (
  id          TEXT PRIMARY KEY,
  task_id     TEXT,
  path        TEXT NOT NULL,
  kind        TEXT,                       -- source | report | render | handoff | ...
  hash        TEXT,                       -- 内容哈希，用于校验
  produced_at TEXT,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);

-- ============ 审计日志 ============
CREATE TABLE IF NOT EXISTS audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL,
  actor  TEXT NOT NULL,                   -- user | hermes | pi | codex | system
  action TEXT NOT NULL,                   -- task_create | task_cancel | approval_decision | ...
  detail TEXT
);

-- ============ 告警 ============
CREATE TABLE IF NOT EXISTS alerts (
  id         TEXT PRIMARY KEY,
  task_id    TEXT,
  severity   TEXT NOT NULL,               -- info | warn | error
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT
);
