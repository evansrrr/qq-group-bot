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

/**
 * 落一条消息 + 更新成员统计 + 裁剪超量历史。
 * 平台会重复推送同一 msg_id,这里不做去重(去重由 markSeen 在入口统一处理)。
 */
export async function appendMessage(
  env: Env,
  groupId: string,
  msg: NewMessage,
): Promise<number> {
  await ensureSchema(env);
  const now = Date.now();
  const statements = [
    env.DB.prepare(
      `INSERT INTO messages (group_id, msg_id, role, author, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(groupId, msg.msgId, msg.role, msg.author, msg.content, now),
  ];

  if (msg.role === "user" && msg.author) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO members (group_id, name, msg_count, char_count, first_seen, last_seen, last_msg)
         VALUES (?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT(group_id, name) DO UPDATE SET
           msg_count = msg_count + 1,
           char_count = char_count + excluded.char_count,
           last_seen = excluded.last_seen,
           last_msg = excluded.last_msg`,
      ).bind(groupId, msg.author, msg.content.length, now, now, msg.content),
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

  const results = await env.DB.batch(statements);
  return Number(results[0]?.meta?.last_row_id ?? 0);
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
  ]);
}
