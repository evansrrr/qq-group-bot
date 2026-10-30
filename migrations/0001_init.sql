-- 群聊长期记忆。代码里也有幂等建表兜底，正式环境建议用迁移管理
-- 应用：npx wrangler d1 migrations apply qq-group-bot --remote

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  msg_id TEXT,
  role TEXT NOT NULL,
  author TEXT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_group ON messages (group_id, id DESC);

CREATE TABLE IF NOT EXISTS summaries (
  group_id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  upto_id INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  group_id TEXT NOT NULL,
  name TEXT NOT NULL,
  msg_count INTEGER NOT NULL DEFAULT 0,
  char_count INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  last_msg TEXT,
  PRIMARY KEY (group_id, name)
);

CREATE TABLE IF NOT EXISTS seen (
  group_id TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (group_id, msg_id)
);
