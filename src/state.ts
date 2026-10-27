import type { ChatMessage, Env } from "./env";

const HISTORY_MAX_MESSAGES = 20;
const HISTORY_TTL_MS = 30 * 60 * 1000;
const SEEN_MAX_ENTRIES = 1000;
const SEEN_TTL_MS = 10 * 60 * 1000;

/** 默认被叫到就必接话的昵称;可用 BOT_ALIASES 环境变量整体覆盖 */
export const DEFAULT_ALIASES = ["小鲸", "鲸鱼", "机器人"];

const histories = new Map<string, { messages: ChatMessage[]; updatedAt: number }>();
const seenMsgIds = new Map<string, number>();

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 解析机器人昵称(逗号 / 中文逗号 / 空白分隔) */
export function resolveAliases(env: Env): string[] {
  const custom = (env.BOT_ALIASES ?? "")
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return custom.length > 0 ? custom : DEFAULT_ALIASES;
}

/**
 * 非 @ 消息是否主动插话:提到机器人昵称必接;
 * 否则按 CHIME_RATE 概率随机插话(无冷却)。
 */
export function shouldChimeIn(env: Env, text: string): boolean {
  const named = resolveAliases(env).some((alias) =>
    new RegExp(escapeRegExp(alias), "i").test(text),
  );
  if (named) return true;
  return Math.random() < Number(env.CHIME_RATE ?? "0.3");
}

function pruneHistories(now: number): void {
  for (const [key, entry] of histories) {
    if (now - entry.updatedAt > HISTORY_TTL_MS) histories.delete(key);
  }
}

/** 消息去重:平台可能重复推送相同 msg_id,首次见到时记录并返回 false */
export function isDuplicateMessage(msgId: string): boolean {
  const now = Date.now();
  for (const [id, ts] of seenMsgIds) {
    if (now - ts > SEEN_TTL_MS) seenMsgIds.delete(id);
  }
  if (seenMsgIds.has(msgId)) return true;
  seenMsgIds.set(msgId, now);
  if (seenMsgIds.size > SEEN_MAX_ENTRIES) {
    const oldest = seenMsgIds.keys().next().value;
    if (oldest !== undefined) seenMsgIds.delete(oldest);
  }
  return false;
}

export function getHistory(groupId: string): ChatMessage[] {
  return histories.get(groupId)?.messages ?? [];
}

export function pushHistory(groupId: string, ...messages: ChatMessage[]): void {
  const now = Date.now();
  pruneHistories(now);
  const entry = histories.get(groupId) ?? { messages: [], updatedAt: now };
  entry.messages.push(...messages);
  while (entry.messages.length > HISTORY_MAX_MESSAGES) entry.messages.shift();
  entry.updatedAt = now;
  histories.set(groupId, entry);
}

export function resetHistory(groupId: string): void {
  histories.delete(groupId);
}
