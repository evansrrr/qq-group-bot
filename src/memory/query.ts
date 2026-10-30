/**
 * 记忆层的纯函数:关键词提取、命中打分、上下文格式化。
 * 不依赖 D1 / 网络,便于单测。
 */

export const RECENT_LIMIT = 20;
/** 未摘要消息达到该条数触发一次滚动摘要 */
export const COMPACT_AFTER = 40;
export const SUMMARY_MAX_CHARS = 400;
export const RECALL_LIMIT = 5;
/** 关键词召回在 SQL 侧最多扫多少条,避免大群全表扫 */
export const RECALL_SCAN_LIMIT = 200;
/** 每群最多保留的原始消息条数,超出删最旧(信息已进摘要) */
export const MAX_STORED_MESSAGES = 500;
export const SEEN_TTL_MS = 10 * 60 * 1000;

export interface MemoryHit {
  id: number;
  role: string;
  author: string | null;
  content: string;
  createdAt: number;
}

export interface MemberRow {
  name: string;
  msg_count: number;
  char_count: number;
  first_seen: number;
  last_seen: number;
  last_msg: string | null;
}

/** 高频虚词:由它们组成的二元组做搜索词没有区分度 */
const STOP_CHARS = new Set(
  "的了是我你他她它吗呢吧啊呀哦嗯在有这那就都也还么什怎为和与及但或如果因所以个一上下来去说讲要会能可对给把被让很太更最又已再才只没过着得嘛呗咯喔诶".split(
    "",
  ),
);

export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function isStopword(word: string): boolean {
  return [...word].every((ch) => STOP_CHARS.has(ch));
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * 从一句话里抽 SQL 可用的检索词。
 * 中文没有分词器,退化为:短词整体保留,长句切二元组(过滤纯虚词二元组)。
 * 噪声词只是匹配不到,不会影响打分排序,成本远低于引一个分词库。
 */
export function extractKeywords(text: string, max = 10): string[] {
  const cleaned = text
    .replace(/<@[^>]*>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\[[^\]]*\]/g, " ");
  const tokens = cleaned.split(/[^\p{Script=Han}A-Za-z0-9]+/u).filter(Boolean);

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (word: string): void => {
    const key = word.toLowerCase();
    if (key.length < 2 || seen.has(key) || isStopword(key)) return;
    seen.add(key);
    out.push(key);
  };

  for (const token of tokens) {
    if (out.length >= max) break;
    if (/^[A-Za-z0-9]+$/.test(token) || token.length <= 4) {
      push(token);
      continue;
    }
    for (let i = 0; i < token.length - 1 && out.length < max; i++) {
      push(token.slice(i, i + 2));
    }
  }
  return out.slice(0, max);
}

/** 按命中关键词个数打分(单关键词最多计 3 次,防刷屏长文本霸榜) */
export function scoreHits(hits: MemoryHit[], keywords: string[]): MemoryHit[] {
  const scored = hits.map((hit) => {
    const content = hit.content.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      let from = 0;
      let times = 0;
      while (times < 3) {
        const at = content.indexOf(kw, from);
        if (at < 0) break;
        times++;
        from = at + kw.length;
      }
      score += times;
    }
    return { hit, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.hit.id - a.hit.id)
    .map((s) => s.hit);
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatRecallHits(hits: MemoryHit[], limit = RECALL_LIMIT): string | null {
  const top = hits.slice(0, limit);
  if (top.length === 0) return null;
  const lines = top.map((h, i) => {
    const who = h.author ?? "机器人";
    return `${i + 1}. ${formatTime(h.createdAt)} ${who}: ${clip(h.content, 120)}`;
  });
  return [
    "【群聊历史片段 | 仅作参考:自然并入回答,别逐字复述,也别说明你在查记录】",
    ...lines,
  ].join("\n");
}

export function formatSummaryBlock(summary: string | null): string | null {
  if (!summary) return null;
  return `【群聊长期记忆摘要 | 供你理解群内人和事,不要直接复述】\n${summary}`;
}

export function shouldCompact(pending: number): boolean {
  return pending >= COMPACT_AFTER;
}

export function formatMemberStats(row: MemberRow | null): string {
  if (!row) return "还没记到这个人,多聊两句吧~";
  const avg = row.msg_count > 0 ? Math.round(row.char_count / row.msg_count) : 0;
  const lines = [
    `${row.name}: 说过 ${row.msg_count} 句,平均 ${avg} 字`,
    `首次 ${formatTime(row.first_seen)} / 最近 ${formatTime(row.last_seen)}`,
  ];
  if (row.last_msg) lines.push(`最近一句: ${clip(row.last_msg, 80)}`);
  return lines.join("\n");
}

export function formatRecallReply(hits: MemoryHit[]): string {
  if (hits.length === 0) return "没翻到相关的聊天记录~";
  const lines = hits
    .slice(0, RECALL_LIMIT)
    .map((h, i) => `${i + 1}. ${formatTime(h.createdAt)} ${h.author ?? "机器人"}: ${clip(h.content, 80)}`);
  return [`翻到 ${hits.length} 条:`, ...lines].join("\n");
}
