/**
 * 自然语言意图识别。
 *
 * 设计约束:群里没有斜杠指令,所有能力都要靠「@机器人 + 一句话」触发。
 * 因此这里全部是确定性正则,不走 LLM——每条消息都过一遍模型太贵,而且判断结果不可预测。
 * 只在 @ 机器人的消息上调用,所以误判面很小。
 */

export type IntentKind = "reset" | "reprofile" | "profile" | "recall" | "summary" | "help";

export interface Intent {
  kind: IntentKind;
  /** profile / reprofile 的成员名,recall 的检索词 */
  arg: string;
  /** 需要管理员 openid 才能执行 */
  adminOnly: boolean;
}

const RESET_IMPERATIVE =
  /(清空|重置|清除|清理|删除|删掉|抹掉|忘掉|忘记)\s*(?:一下|掉)?\s*.{0,6}?(记忆|记录|历史|上下文|聊天记录)/;
const RESET_BA = /(?:把|给|帮).{0,8}(记忆|记录|历史|上下文).{0,6}(?:清|删|重置|抹|忘)/;
const MEMORY_NOUN = /(记忆|记录|历史|聊天|上下文|聊天记录)/;
const SUMMARY_VERB = /(总结|概括|摘要|归纳|回顾|复盘)/;
const SUMMARY_NOUN = /(群|群里|聊天|记录|记忆|话题|最近|大家|这段|之前|都聊)/;
const RECALL_VERB = /(查|搜|找|翻|回忆|记得|查查|翻翻)/;
const RECALL_NOUN = /(记录|聊天|说过|历史|记忆|之前|上次|以前)/;
const PROFILE_NOUN = /(画像|人设|什么性格|什么样的人|什么人|了解一下)/;

/** 句子太长基本是在正常聊天,不做意图判断 */
const MAX_INTENT_LEN = 60;

const TRIM_CHARS = /[\s,，。.!！?？~、;；:："'“”‘’()（）]/g;

function clean(text: string): string {
  return text
    .replace(/<@[^>]*>/g, " ")
    .replace(TRIM_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 抓取「X的画像」「了解一下X」「X 是什么样的人」里的 X */
export function extractName(text: string): string {
  const patterns = [
    /(?:给|帮|看看|查一下)\s*([^\s,，。]{1,12}?)\s*(?:做|画|出)?\s*(?:个|一下)?\s*(?:画像|人设)/,
    /([^\s,，。]{1,12})\s*的\s*(?:画像|人设)/,
    /(?:重新|重做|再|重来)\s*(?:一下)?\s*([^\s,，。]{1,12}?)\s*的?\s*(?:画像|人设)/,
    /([^\s,，。]{1,12}?)\s*(?:这人|这个人)?\s*(?:是)?\s*(?:什么性格|什么样的人|什么人|怎么样)/,
    /了解一下\s*([^\s,，。]{1,12})/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    const name = m?.[1]?.trim();
    if (name && name.length >= 1) return name;
  }
  return "";
}

function cleanQuery(text: string): string {
  return clean(clean(text).replace(/^(的|了|过)\s*/, ""));
}

/** 抓取「查一下之前的记录 日本旅游」「还记得日本旅游吗」里的检索词 */
export function extractRecallQuery(text: string): string {
  const remembered = text.match(/还记得(.{1,24}?)(?:吗|么|嘛|不)/);
  if (remembered) return cleanQuery(remembered[1]);
  return cleanQuery(
    text
      .replace(/^(帮我|帮忙|你|给我|能不能|可以|麻烦你?)\s*/, " ")
      .replace(/(查查|搜搜|找找|翻翻|查一下|搜一下|找一下|翻一下|查|搜|找|翻|回忆|记得)/g, " ")
      .replace(/(一下|下|看看|吧)/g, " ")
      .replace(/(聊天记录|记录|历史|聊天|记忆|上下文)/g, " ")
      .replace(/(关于|有关|之前|上次|以前|说过|提到)/g, " "),
  );
}

/**
 * 解析一句话的意图。命中返回 Intent,null 表示这是普通聊天。
 * 判定顺序:重置 > 重做画像 > 画像 > 总结 > 检索 > 帮助,避免「总结一下群里聊的记录」被当成检索。
 */
export function parseIntent(rawText: string): Intent | null {
  const text = clean(rawText);
  if (!text || text.length > MAX_INTENT_LEN) return null;

  if (RESET_IMPERATIVE.test(text) || (RESET_BA.test(text) && MEMORY_NOUN.test(text))) {
    return { kind: "reset", arg: "", adminOnly: true };
  }

  if (/(重新|重做|重来|再)/.test(text) && /(画像|人设)/.test(text)) {
    return { kind: "reprofile", arg: extractName(text), adminOnly: true };
  }

  if (PROFILE_NOUN.test(text)) {
    return { kind: "profile", arg: extractName(text), adminOnly: false };
  }

  if (SUMMARY_VERB.test(text) && (SUMMARY_NOUN.test(text) || text.length <= 12)) {
    return { kind: "summary", arg: "", adminOnly: false };
  }

  if (/还记得/.test(text)) {
    return { kind: "recall", arg: extractRecallQuery(text), adminOnly: false };
  }

  if (RECALL_VERB.test(text) && RECALL_NOUN.test(text)) {
    return { kind: "recall", arg: extractRecallQuery(text), adminOnly: false };
  }

  if (/(会什么|能做什么|能干啥|怎么用|有啥功能|有什么功能|你能干嘛|帮助)/.test(text)) {
    return { kind: "help", arg: "", adminOnly: false };
  }

  return null;
}

/** 管理员判定:openid 白名单(QQ 群消息事件不返回群主/管理员角色) */
export function isAdmin(env: { ADMIN_OPENIDS?: string }, memberOpenId?: string): boolean {
  if (!memberOpenId) return false;
  const list = (env.ADMIN_OPENIDS ?? "")
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes(memberOpenId);
}

/** 不依赖斜杠的能力说明,直接念给群友听 */
export const HELP_TEXT = [
  "我能记住这个群的聊天,你直接问我:",
  "· 之前谁说过 XX / 还记得 XX 吗 —— 翻旧记录",
  "· 总结一下群里最近聊的 —— 出长期摘要",
  "· 张三是什么样的人 —— 看他的画像",
  "管理员还能说:清空这个群的记忆、重新给张三做个画像",
].join("\n");
