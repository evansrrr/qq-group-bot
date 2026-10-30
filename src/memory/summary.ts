import type { Env } from "../env";
import { chatCompletion } from "../llm";
import { COMPACT_AFTER, SUMMARY_MAX_CHARS, clip } from "./query";
import { pendingMessages, readSummary, writeSummary } from "./store";

const SUMMARY_SYSTEM = [
  "你在为一个 QQ 群维护长期记忆摘要,供聊天机器人之后参考。",
  `把【已有摘要】与【新增聊天】合并成一段不超过 ${SUMMARY_MAX_CHARS} 字的中文摘要。`,
  "保留:群成员的性格 / 说话习惯 / 口头禅 / 擅长或关心的事、常聊话题、约定或承诺过的事、重要事件与结论。",
  "丢弃:寒暄、重复、无信息量的斗嘴、机器人自己的客套话。",
  "用第三人称陈述,分「成员」「话题」「事件」三块写;不要模仿聊天语气,不要编造。",
  "只输出摘要正文,不要标题、不要前缀、不要 Markdown。",
].join("\n");

/**
 * 滚动摘要:未摘要消息够多时,把旧聊天压进长期摘要。
 * 失败(没有 key、上游全挂)直接向上抛,由调用方 waitUntil 里吞掉,不能影响回复主链路。
 */
export async function compactGroupMemory(
  env: Env,
  groupId: string,
  force = false,
): Promise<string | null> {
  const { summary, uptoId, pending } = await readSummary(env, groupId);
  if (pending === 0) return summary;
  if (!force && pending < COMPACT_AFTER) return summary;

  const rows = await pendingMessages(env, groupId, uptoId, Math.min(pending, COMPACT_AFTER * 2));
  if (rows.length === 0) return summary;

  const transcript = rows
    .map((row) => `${row.author ?? "机器人"}: ${clip(row.content, 200)}`)
    .join("\n")
    .slice(-6000);

  const out = await chatCompletion(
    env,
    [
      { role: "system", content: SUMMARY_SYSTEM },
      {
        role: "user",
        content: `【已有摘要】\n${summary ?? "(暂无)"}\n\n【新增聊天】\n${transcript}`,
      },
    ],
    { maxTokens: 600, temperature: 0.3 },
  );

  const merged = clip(out, SUMMARY_MAX_CHARS);
  if (!merged) return summary;
  await writeSummary(env, groupId, merged, rows[rows.length - 1].id);
  return merged;
}
