import type { Env } from "./env";
import { chatCompletion } from "./llm";

const DECISION_SYSTEM = [
  "你是搜索意图判断器,只输出结论,禁止解释。",
  "判断用户消息回答时是否需要最新联网信息(实时天气、新闻、股价、比赛比分、热搜、日期时间、时效性资讯、产品价格等)。",
  "需要:输出 Y:加一句10-25字的搜索查询,提炼消息关键信息,不要带人名前缀。",
  "不需要(闲聊、玩梗、情感交流、图片、已过时的常识):输出 N。",
].join("\n");

/** 解析判断器输出 → 搜索词或 null */
export function parseSearchDecision(output: string): string | null {
  const s = output.trim();
  const m = s.match(/^Y\s*[:：]\s*(.+)$/i);
  if (m) {
    const query = m[1].trim();
    return query ? query.slice(0, 64) : null;
  }
  if (/^Y\b/i.test(s)) return null;
  return null;
}

/** 先用一次轻量 LLM 调用判断是否需要联网,返回搜索词;失败/不需要返回 null */
export async function needsSearch(env: Env, userText: string): Promise<string | null> {
  try {
    const out = await chatCompletion(
      env,
      [
        { role: "system", content: DECISION_SYSTEM },
        { role: "user", content: userText.slice(0, 500) },
      ],
      { maxTokens: 40, temperature: 0 },
    );
    return parseSearchDecision(out);
  } catch (err) {
    console.warn("needsSearch failed:", err);
    return null;
  }
}

export interface SearchResult {
  title?: string;
  url?: string;
  summary?: string;
  snippet?: string;
  date?: string | null;
}

/** 把搜索结果格式化成一段注入 system 的参考上下文;无结果返回 null */
export function formatSearchResults(results: SearchResult[], searchedAt: string): string | null {
  const top = results.slice(0, 5);
  if (top.length === 0) return null;
  const lines = top.map((r, i) => {
    const date = r.date ? `(${r.date.slice(0, 10)})` : "";
    const body = (r.summary || r.snippet || "").slice(0, 400);
    return `${i + 1}. ${r.title ?? ""} ${date}\n${body}`;
  });
  return [
    `【联网搜索结果 | ${searchedAt}】仅供回答参考:自然融入口语化回复,不要罗列条目和链接。`,
    ...lines,
  ].join("\n");
}

/** 调 DeepSeek Search API;失败/无结果返回 null(不阻塞回复) */
export async function webSearch(
  env: Env,
  query: string,
  originalQuestion: string,
): Promise<string | null> {
  if (!env.DEEPSEEK_API_KEY) return null;
  const base = env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
  try {
    const res = await fetch(`${base}/v1/tools/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        query,
        count: 5,
        ori_question: originalQuestion.slice(0, 128),
        need_content: false,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      results?: SearchResult[];
      error?: { message?: string };
    };
    if (!res.ok) {
      console.warn(`webSearch failed: http=${res.status} error=${data.error?.message}`);
      return null;
    }
    const searchedAt = new Date().toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    return formatSearchResults(data.results ?? [], searchedAt);
  } catch (err) {
    console.warn("webSearch failed:", err);
    return null;
  }
}
