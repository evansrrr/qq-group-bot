import type { Env } from "../env";
import {
  MAX_STORED_MESSAGES,
  RECALL_SCAN_LIMIT,
  SEEN_TTL_MS,
  escapeLike,
  scoreHits,
  type MemberRow,
  type MemoryHit,
} from "./query";

/** 建表语句既放在 migrations/0001_init.sql,这里也留一份幂等兜底,本地跑起来不用先执行迁移 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS messages (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     group_id TEXT NOT NULL,
     msg_id TEXT,
     role TEXT NOT NULL,
     author TEXT,
     content TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_group ON messages (group_id, id DESC)`,
  `CREATE TABLE IF NOT EXISTS summaries (
     group_id TEXT PRIMARY KEY,
     summary TEXT NOT NULL,
     upto_id INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS members (
     group_id TEXT NOT NULL,
     name TEXT NOT NULL,
     msg_count INTEGER NOT NULL DEFAULT 0,
     char_count INTEGER NOT NULL DEFAULT 0,
     first_seen INTEGER NOT NULL,
     last_seen INTEGER NOT NULL,
     last_msg TEXT,
     PRIMARY KEY (group_id, name)
   )`,
  `CREATE TABLE IF NOT EXISTS seen (
     group_id TEXT NOT NULL,
     msg_id TEXT NOT NULL,
     ts INTEGER NOT NULL,
     PRIMARY KEY (group_id, msg_id)
   )`,
  `CREATE TABLE IF NOT EXISTS member_profiles (
     group_id TEXT NOT NULL,
     name TEXT NOT NULL,
     persona TEXT NOT NULL,
     topics TEXT,
     style TEXT,
     source_count INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (group_id, name)
   )`,
  `CREATE TABLE IF NOT EXISTS group_style (
     group_id TEXT PRIMARY KEY,
     style TEXT NOT NULL,
     sample_count INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS group_meta (
     group_id TEXT PRIMARY KEY,
     msg_total INTEGER NOT NULL DEFAULT 0,
     last_activity_at INTEGER NOT NULL DEFAULT 0,
     fire_at INTEGER,
     last_proactive_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS embeddings (
     msg_row_id INTEGER PRIMARY KEY,
     group_id TEXT NOT NULL,
     vec TEXT NOT NULL,
     dim INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_embeddings_group ON embeddings (group_id, msg_row_id DESC)`,
];

let schemaReady = false;

/** 幂等建表,每个 isolate 只跑一次;并发重复执行也无副作用 */
export async function ensureSchema(env: Env): Promise<void> {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));
  schemaReady = true;
}

interface MessageRow {
  id: number;
  role: string;
  author: string | null;
  content: string;
  created_at: number;
}

function toHit(row: MessageRow): MemoryHit {
  return {
    id: row.id,
    role: row.role,
    author: row.author,
    content: row.content,
    createdAt: row.created_at,
  };
}

export interface NewMessage {
  msgId: string | null;
  role: "user" | "assistant";
  author: string | null;
  content: string;
}

export interface AppendResult {
  /** 新消息行 id,用于关联向量 */
  id: number;
  /** 该作者累计发言条数(仅 user 消息有值) */
  memberCount: number;
  /** 本群人类消息累计条数(仅 user 消息有值) */
  msgTotal: number;
}

/**
 * 落一条消息 + 更新成员统计 + 刷新群活跃时间 + 裁剪超量历史。
 * 平台会重复推送同一 msg_id,去重由 markSeen 在入口统一处理。
 * 机器人自己的消息不刷新活跃时间(否则冷场计时会被自己说活),也不计入成员统计。
 */
export async function appendMessage(
  env: Env,
  groupId: string,
  msg: NewMessage,
): Promise<AppendResult> {
  await ensureSchema(env);
  const now = Date.now();
  const statements = [
    env.DB.prepare(
      `INSERT INTO messages (group_id, msg_id, role, author, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(groupId, msg.msgId, msg.role, msg.author, msg.content, now),
  ];
  let memberIdx = -1;
  let metaIdx = -1;

  if (msg.role === "user" && msg.author) {
    memberIdx = statements.length;
    statements.push(
      env.DB.prepare(
        `INSERT INTO members (group_id, name, msg_count, char_count, first_seen, last_seen, last_msg)
         VALUES (?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT(group_id, name) DO UPDATE SET
           msg_count = msg_count + 1,
           char_count = char_count + excluded.char_count,
           last_seen = excluded.last_seen,
           last_msg = excluded.last_msg
         RETURNING msg_count`,
      ).bind(groupId, msg.author, msg.content.length, now, now, msg.content),
    );

    metaIdx = statements.length;
    statements.push(
      env.DB.prepare(
        `INSERT INTO group_meta (group_id, msg_total, last_activity_at, fire_at)
         VALUES (?, 1, ?, NULL)
         ON CONFLICT(group_id) DO UPDATE SET
           msg_total = msg_total + 1,
           last_activity_at = excluded.last_activity_at,
           fire_at = NULL
         RETURNING msg_total`,
      ).bind(groupId, now),
    );
  }

  statements.push(
    env.DB.prepare(
      `DELETE FROM messages
        WHERE group_id = ?
          AND id NOT IN (
            SELECT id FROM messages WHERE group_id = ? ORDER BY id DESC LIMIT ?
          )`,
    ).bind(groupId, groupId, MAX_STORED_MESSAGES),
  );

  statements.push(
    env.DB.prepare(
      `DELETE FROM embeddings
        WHERE group_id = ?
          AND msg_row_id NOT IN (SELECT id FROM messages WHERE group_id = ?)`,
    ).bind(groupId, groupId),
  );

  const results = await env.DB.batch(statements);
  const row = (idx: number): Record<string, number> | undefined =>
    idx < 0 ? undefined : (results[idx]?.results?.[0] as Record<string, number> | undefined);

  return {
    id: Number(results[0]?.meta?.last_row_id ?? 0),
    memberCount: Number(row(memberIdx)?.msg_count ?? 0),
    msgTotal: Number(row(metaIdx)?.msg_total ?? 0),
  };
}

/** 消息去重:首次见到返回 false,重复返回 true。作用域是单个群,不同群同 id 互不影响 */
export async function markSeen(env: Env, groupId: string, msgId: string): Promise<boolean> {
  await ensureSchema(env);
  const hit = await env.DB.prepare(
    "SELECT msg_id FROM seen WHERE group_id = ? AND msg_id = ?",
  )
    .bind(groupId, msgId)
    .first();
  if (hit) return true;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO seen (group_id, msg_id, ts) VALUES (?, ?, ?)").bind(
      groupId,
      msgId,
      now,
    ),
    env.DB.prepare("DELETE FROM seen WHERE ts < ?").bind(now - SEEN_TTL_MS),
  ]);
  return false;
}

/** 最近 N 条消息,按时间正序返回 */
export async function recentMessages(
  env: Env,
  groupId: string,
  limit: number,
): Promise<MemoryHit[]> {
  await ensureSchema(env);
  const { results } = await env.DB.prepare(
    `SELECT id, role, author, content, created_at FROM messages
      WHERE group_id = ? ORDER BY id DESC LIMIT ?`,
  )
    .bind(groupId, limit)
    .all<MessageRow>();
  return (results ?? []).map(toHit).reverse();
}

/**
 * 关键词召回:过滤下推到 SQL(LIKE),打分排序在内存(仅 <=200 行)。
 * 调用方传入的 excludeIds 通常是已经在上下文里的最近消息。
 */
export async function recallMessages(
  env: Env,
  groupId: string,
  keywords: string[],
  excludeIds: number[] = [],
  limit = 5,
): Promise<MemoryHit[]> {
  if (keywords.length === 0) return [];
  await ensureSchema(env);
  const where = keywords.map(() => "content LIKE ? ESCAPE '\\'").join(" OR ");
  const params: (string | number)[] = keywords.map((kw) => `%${escapeLike(kw)}%`);
  const { results } = await env.DB.prepare(
    `SELECT id, role, author, content, created_at FROM messages
      WHERE group_id = ? AND (${where})
      ORDER BY id DESC LIMIT ?`,
  )
    .bind(groupId, ...params, RECALL_SCAN_LIMIT)
    .all<MessageRow>();

  const skip = new Set(excludeIds);
  const rows = (results ?? []).map(toHit).filter((row) => !skip.has(row.id));
  return scoreHits(rows, keywords).slice(0, limit);
}

export interface SummaryState {
  summary: string | null;
  uptoId: number;
  pending: number;
}

export async function readSummary(env: Env, groupId: string): Promise<SummaryState> {
  await ensureSchema(env);
  const row = await env.DB.prepare(
    "SELECT summary, upto_id FROM summaries WHERE group_id = ?",
  )
    .bind(groupId)
    .first<{ summary: string; upto_id: number }>();
  const uptoId = row?.upto_id ?? 0;
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS pending FROM messages WHERE group_id = ? AND id > ?",
  )
    .bind(groupId, uptoId)
    .first<{ pending: number }>();
  return { summary: row?.summary ?? null, uptoId, pending: Number(count?.pending ?? 0) };
}

export async function pendingMessages(
  env: Env,
  groupId: string,
  uptoId: number,
  limit: number,
): Promise<MemoryHit[]> {
  await ensureSchema(env);
  const { results } = await env.DB.prepare(
    `SELECT id, role, author, content, created_at FROM messages
      WHERE group_id = ? AND id > ? ORDER BY id ASC LIMIT ?`,
  )
    .bind(groupId, uptoId, limit)
    .all<MessageRow>();
  return (results ?? []).map(toHit);
}

export async function writeSummary(
  env: Env,
  groupId: string,
  summary: string,
  uptoId: number,
): Promise<void> {
  await ensureSchema(env);
  await env.DB.prepare(
    `INSERT INTO summaries (group_id, summary, upto_id, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(group_id) DO UPDATE SET
       summary = excluded.summary,
       upto_id = excluded.upto_id,
       updated_at = excluded.updated_at`,
  )
    .bind(groupId, summary, uptoId, Date.now())
    .run();
}

/** 精确昵称优先,查不到再按包含匹配 */
export async function memberStats(
  env: Env,
  groupId: string,
  name: string,
): Promise<MemberRow | null> {
  await ensureSchema(env);
  const exact = await env.DB.prepare(
    "SELECT name, msg_count, char_count, first_seen, last_seen, last_msg FROM members WHERE group_id = ? AND name = ?",
  )
    .bind(groupId, name)
    .first<MemberRow>();
  if (exact) return exact;
  return await env.DB.prepare(
    `SELECT name, msg_count, char_count, first_seen, last_seen, last_msg FROM members
      WHERE group_id = ? AND name LIKE ? ESCAPE '\\'
      ORDER BY last_seen DESC LIMIT 1`,
  )
    .bind(groupId, `%${escapeLike(name)}%`)
    .first<MemberRow>();
}

/** 清空本群记忆(消息 / 摘要 / 成员统计) */
export async function resetGroup(env: Env, groupId: string): Promise<void> {
  await ensureSchema(env);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages WHERE group_id = ?").bind(groupId),
    env.DB.prepare("DELETE FROM summaries WHERE group_id = ?").bind(groupId),
    env.DB.prepare("DELETE FROM members WHERE group_id = ?").bind(groupId),
    env.DB.prepare("DELETE FROM member_profiles WHERE group_id = ?").bind(groupId),
    env.DB.prepare("DELETE FROM group_style WHERE group_id = ?").bind(groupId),
    env.DB.prepare("DELETE FROM embeddings WHERE group_id = ?").bind(groupId),
  ]);
}

/** 某人最近 N 条发言(用于生成画像) */
export async function authorMessages(
  env: Env,
  groupId: string,
  name: string,
  limit: number,
): Promise<MemoryHit[]> {
  await ensureSchema(env);
  const { results } = await env.DB.prepare(
    `SELECT id, role, author, content, created_at FROM messages
      WHERE group_id = ? AND author = ? AND role = 'user'
      ORDER BY id DESC LIMIT ?`,
  )
    .bind(groupId, name, limit)
    .all<MessageRow>();
  return (results ?? []).map(toHit).reverse();
}

/** 群里最近的真人消息(用于统计/生成群风格) */
export async function humanMessages(env: Env, groupId: string, limit: number): Promise<MemoryHit[]> {
  await ensureSchema(env);
  const { results } = await env.DB.prepare(
    `SELECT id, role, author, content, created_at FROM messages
      WHERE group_id = ? AND role = 'user'
      ORDER BY id DESC LIMIT ?`,
  )
    .bind(groupId, limit)
    .all<MessageRow>();
  return (results ?? []).map(toHit).reverse();
}

export interface ProfileRow {
  name: string;
  persona: string;
  topics: string | null;
  style: string | null;
  source_count: number;
  updated_at: number;
}

export async function getMemberProfile(
  env: Env,
  groupId: string,
  name: string,
): Promise<ProfileRow | null> {
  await ensureSchema(env);
  return await env.DB.prepare(
    `SELECT name, persona, topics, style, source_count, updated_at
       FROM member_profiles WHERE group_id = ? AND name = ?`,
  )
    .bind(groupId, name)
    .first<ProfileRow>();
}

export async function saveMemberProfile(
  env: Env,
  groupId: string,
  name: string,
  persona: string,
  topics: string,
  style: string,
  sourceCount: number,
): Promise<void> {
  await ensureSchema(env);
  await env.DB.prepare(
    `INSERT INTO member_profiles (group_id, name, persona, topics, style, source_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(group_id, name) DO UPDATE SET
       persona = excluded.persona,
       topics = excluded.topics,
       style = excluded.style,
       source_count = excluded.source_count,
       updated_at = excluded.updated_at`,
  )
    .bind(groupId, name, persona, topics, style, sourceCount, Date.now())
    .run();
}

export async function getGroupStyle(
  env: Env,
  groupId: string,
): Promise<{ style: string; sampleCount: number } | null> {
  await ensureSchema(env);
  const row = await env.DB.prepare(
    "SELECT style, sample_count FROM group_style WHERE group_id = ?",
  )
    .bind(groupId)
    .first<{ style: string; sample_count: number }>();
  return row ? { style: row.style, sampleCount: Number(row.sample_count ?? 0) } : null;
}

export async function saveGroupStyle(
  env: Env,
  groupId: string,
  style: string,
  sampleCount: number,
): Promise<void> {
  await ensureSchema(env);
  await env.DB.prepare(
    `INSERT INTO group_style (group_id, style, sample_count, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(group_id) DO UPDATE SET
       style = excluded.style,
       sample_count = excluded.sample_count,
       updated_at = excluded.updated_at`,
  )
    .bind(groupId, style, sampleCount, Date.now())
    .run();
}

export async function saveEmbedding(
  env: Env,
  groupId: string,
  msgRowId: number,
  vec: string,
  dim: number,
): Promise<void> {
  await ensureSchema(env);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO embeddings (msg_row_id, group_id, vec, dim, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(msgRowId, groupId, vec, dim, Date.now())
    .run();
}

export interface EmbeddedRow extends MemoryHit {
  vec: string;
  dim: number;
}

/** 取本群最近的向量(带原文),用于语义检索 */
export async function loadEmbeddings(
  env: Env,
  groupId: string,
  limit: number,
): Promise<EmbeddedRow[]> {
  await ensureSchema(env);
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.role, m.author, m.content, m.created_at, e.vec, e.dim
       FROM embeddings e JOIN messages m ON m.id = e.msg_row_id
      WHERE e.group_id = ?
      ORDER BY e.msg_row_id DESC LIMIT ?`,
  )
    .bind(groupId, limit)
    .all<MessageRow & { vec: string; dim: number }>();
  return (results ?? []).map((row) => ({ ...toHit(row), vec: row.vec, dim: Number(row.dim) }));
}

/**
 * 给满足条件的群安排一次主动发言时间点:
 * fire_at = 最后一条人类消息 + 静默阈值 + 随机(0~上限)。
 * 只在「没排过」且「上次主动发言之后又有人说过话」时排,避免对着空气自言自语。
 */
export async function planIdleGroups(
  env: Env,
  now: number,
  afterMs: number,
  maxWaitMs: number,
  minMsgs: number,
): Promise<void> {
  await ensureSchema(env);
  await env.DB.prepare(
    `UPDATE group_meta
        SET fire_at = last_activity_at + ? + (ABS(RANDOM()) % ?)
      WHERE fire_at IS NULL
        AND msg_total >= ?
        AND last_activity_at <= ?
        AND last_activity_at > COALESCE(last_proactive_at, 0)`,
  )
    .bind(afterMs, Math.max(1, maxWaitMs), minMsgs, now - afterMs)
    .run();
}

/** 到点该说话的群 */
export async function dueIdleGroups(env: Env, now: number, limit: number): Promise<string[]> {
  await ensureSchema(env);
  const { results } = await env.DB.prepare(
    `SELECT group_id FROM group_meta
      WHERE fire_at IS NOT NULL AND fire_at <= ?
      ORDER BY fire_at ASC LIMIT ?`,
  )
    .bind(now, limit)
    .all<{ group_id: string }>();
  return (results ?? []).map((row) => row.group_id);
}

/** 无论发没发出去都清掉本次计划,避免同一群每分钟重试把额度打光 */
export async function markProactiveSpoken(
  env: Env,
  groupId: string,
  now: number,
): Promise<void> {
  await ensureSchema(env);
  await env.DB.prepare(
    "UPDATE group_meta SET fire_at = NULL, last_proactive_at = ? WHERE group_id = ?",
  )
    .bind(now, groupId)
    .run();
}
