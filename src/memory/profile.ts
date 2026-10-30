import type { Env } from "../env";
import { chatCompletion } from "../llm";
import { memoryConfig } from "./config";
import { clip } from "./query";
import {
  authorMessages,
  getMemberProfile,
  humanMessages,
  saveGroupStyle,
  saveMemberProfile,
  type ProfileRow,
} from "./store";

/** 画像只看最近这么多条发言,太多会把早期人设和新变化混在一起 */
const PORTRAIT_SAMPLE = 60;
const STYLE_SAMPLE = 200;
const PERSONA_MAX_CHARS = 120;

const PORTRAIT_SYSTEM = [
  "你在为 QQ 群机器人整理某个群成员的画像,供之后聊天时参考。",
  `根据给出的历史发言,写一段 ${PERSONA_MAX_CHARS} 字以内的第三人称画像。`,
  "必须写到:说话长度习惯、语气(客气/直给/阴阳/正经)、常聊话题、口头禅或常用表达。",
  "不要写:真实身份推断、外貌、性别、年龄、职业、住址,以及任何本人没说过的信息。",
  "不要评价好坏,只描述可观察到的表达习惯。",
  "严格按这个格式输出一行:画像|常聊话题(逗号分隔,最多3个)|风格标签(最多3个)",
].join("\n");

const STYLE_SYSTEM = [
  "你在总结一个 QQ 群的说话风格,供机器人模仿节奏(不是模仿内容)。",
  "根据给出的群聊样本和统计数字,写一段 80 字以内的中文描述。",
  "写到:句子长短、语气松紧、称呼习惯、是否爱玩梗、是否常用表情。",
  "只描述整体风格,不要点名具体成员,不要复述聊天内容,不要编造。",
  "只输出这段描述,不要标题、不要前缀。",
].join("\n");

/** 确定性统计,不经过模型,数字必须真实 */
export interface StyleStats {
  samples: number;
  avgLen: number;
  questionRatio: number;
  emojiRatio: number;
}

export function styleStats(texts: string[]): StyleStats {
  const total = texts.length;
  if (total === 0) return { samples: 0, avgLen: 0, questionRatio: 0, emojiRatio: 0 };
  let chars = 0;
  let questions = 0;
  let emoji = 0;
  for (const text of texts) {
    chars += text.length;
    if (/[?？]/.test(text)) questions++;
    // 常见表情/符号区间,不追求完整 Unicode 分类
    if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) emoji++;
  }
  return {
    samples: total,
    avgLen: Math.round(chars / total),
    questionRatio: Math.round((questions / total) * 100),
    emojiRatio: Math.round((emoji / total) * 100),
  };
}

function transcript(rows: { author: string | null; content: string }[], limit: number): string {
  return rows
    .map((row) => `${row.author ?? "某人"}: ${clip(row.content, 200)}`)
    .join("\n")
    .slice(-limit);
}

/** 解析「画像|话题|风格」,格式不对就整段当画像,不让解析失败毁掉这次生成 */
export function parsePortrait(output: string): { persona: string; topics: string; style: string } {
  const line = output.replace(/\s+/g, " ").trim();
  const parts = line.split(/[|｜]/).map((s) => s.trim());
  if (parts.length >= 2 && parts[0]) {
    return {
      persona: clip(parts[0], PERSONA_MAX_CHARS),
      topics: parts[1] ?? "",
      style: parts[2] ?? "",
    };
  }
  return { persona: clip(line, PERSONA_MAX_CHARS), topics: "", style: "" };
}

/** 生成并保存成员画像;消息不足或模型失败时返回 null */
export async function generateMemberPortrait(
  env: Env,
  groupId: string,
  name: string,
): Promise<ProfileRow | null> {
  const rows = await authorMessages(env, groupId, name, PORTRAIT_SAMPLE);
  if (rows.length < memoryConfig(env).portraitMinSamples) return null;

  const out = await chatCompletion(
    env,
    [
      { role: "system", content: PORTRAIT_SYSTEM },
      { role: "user", content: `成员:${name}\n历史发言:\n${transcript(rows, 6000)}` },
    ],
    { maxTokens: 300, temperature: 0.3 },
  );
  const parsed = parsePortrait(out);
  if (!parsed.persona) return null;

  await saveMemberProfile(env, groupId, name, parsed.persona, parsed.topics, parsed.style, rows.length);
  return {
    name,
    persona: parsed.persona,
    topics: parsed.topics,
    style: parsed.style,
    source_count: rows.length,
    updated_at: Date.now(),
  };
}

/** 群里还没画像过就先补一份,避免首次查询空手而归 */
export async function ensureMemberProfile(
  env: Env,
  groupId: string,
  name: string,
): Promise<ProfileRow | null> {
  const existing = await getMemberProfile(env, groupId, name);
  if (existing) return existing;
  try {
    return await generateMemberPortrait(env, groupId, name);
  } catch (err) {
    console.warn("generateMemberPortrait failed:", err);
    return null;
  }
}

/** 生成并保存群风格;返回写入的风格文本 */
export async function generateGroupStyle(env: Env, groupId: string): Promise<string | null> {
  const rows = await humanMessages(env, groupId, STYLE_SAMPLE);
  if (rows.length < memoryConfig(env).styleMinSamples) return null;
  const stats = styleStats(rows.map((row) => row.content));

  const out = await chatCompletion(
    env,
    [
      { role: "system", content: STYLE_SYSTEM },
      {
        role: "user",
        content: [
          `样本条数:${stats.samples}`,
          `平均句长:${stats.avgLen} 字`,
          `带问号的消息占比:${stats.questionRatio}%`,
          `带表情的消息占比:${stats.emojiRatio}%`,
          "群聊样本:",
          transcript(rows, 6000),
        ].join("\n"),
      },
    ],
    { maxTokens: 220, temperature: 0.3 },
  );
  const text = clip(out, 200);
  if (!text) return null;
  // 统计数字由代码拼上,保证和实际样本一致
  const withStats = `${text}(样本 ${stats.samples} 条,平均 ${stats.avgLen} 字,问句 ${stats.questionRatio}%,带表情 ${stats.emojiRatio}%)`;
  await saveGroupStyle(env, groupId, withStats, stats.samples);
  return withStats;
}
