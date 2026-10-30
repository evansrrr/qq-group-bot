-- 成员画像 / 群风格 / 冷场计划 / 语义向量
-- 应用：npx wrangler d1 migrations apply qq-group-bot --remote

CREATE TABLE IF NOT EXISTS member_profiles (
  group_id TEXT NOT NULL,
  name TEXT NOT NULL,
  persona TEXT NOT NULL,
  topics TEXT,
  style TEXT,
  source_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, name)
);

CREATE TABLE IF NOT EXISTS group_style (
  group_id TEXT PRIMARY KEY,
  style TEXT NOT NULL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_meta (
  group_id TEXT PRIMARY KEY,
  msg_total INTEGER NOT NULL DEFAULT 0,
  last_activity_at INTEGER NOT NULL DEFAULT 0,
  fire_at INTEGER,
  last_proactive_at INTEGER
);

CREATE TABLE IF NOT EXISTS embeddings (
  msg_row_id INTEGER PRIMARY KEY,
  group_id TEXT NOT NULL,
  vec TEXT NOT NULL,
  dim INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_embeddings_group ON embeddings (group_id, msg_row_id DESC);
