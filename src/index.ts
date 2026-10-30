import { signCallbackValidation, verifyCallbackSignature } from "./crypto";
import { HELP_TEXT, isAdmin, parseIntent } from "./intent";
import { buildSystemPrompt, chatCompletion } from "./llm";
import type { ChatMessage, ContentPart, Env } from "./env";
import { sendGroupMessage } from "./qq";
import { needsSearch, webSearch } from "./search";
import { resolveAliases, shouldChimeIn } from "./state";
import { collectImageParts } from "./vision";
import { memoryConfig, type MemoryConfig } from "./memory/config";
import {
  RECALL_LIMIT,
  RECENT_LIMIT,
  clip,
  extractKeywords,
  formatMemberStats,
  formatRecallHits,
  formatRecallReply,
  formatSummaryBlock,
  shouldCompact,
  type MemoryHit,
} from "./memory/query";
import { runIdleTick } from "./memory/idle";
import { ensureMemberProfile, generateGroupStyle, generateMemberPortrait } from "./memory/profile";
import { compactGroupMemory } from "./memory/summary";
import {
  appendMessage,
  getGroupStyle,
  getMemberProfile,
  markSeen,
  memberStats,
  readSummary,
  recallMessages,
  recentMessages,
  resetGroup,
  saveEmbedding,
  type AppendResult,
} from "./memory/store";
import { embedText, mergeHits, semanticRecall, toBase64Int8 } from "./memory/vector";

interface WebhookPayload {
  id?: string;
  op: number;
  s?: number;
  t?: string;
  d?: Record<string, unknown>;
}

/** GROUP_AT_MESSAGE_CREATE 与 GROUP_MESSAGE_CREATE 共用的事件体 */
interface MsgElement {
  content?: string;
  message_type?: number;
  author?: { username?: string };
  msg_elements?: MsgElement[];
}

interface GroupMessageEvent {
  id: string;
  content?: string;
  message_type?: number;
  group_openid: string;
  author?: { username?: string; member_openid?: string; bot?: boolean };
  attachments?: { content_type?: string; filename?: string; url?: string }[];
  mentions?: { bot?: boolean }[];
  msg_elements?: MsgElement[];
}

const WEBHOOK_PATH = "/qq/webhook";
const MAX_CHUNK_LEN = 500;
const MAX_CHUNKS = 4;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/**
 * 拆分回复用于多条发送:
 * 1) 模型按“单独一行 ---”拆成的多条消息,逐条发送(模拟真人连续打字)
 * 2) 单条超 500 字再按长度切分;总量上限 4 条(QQ 被动回复每消息最多 5 次)
 */
export function splitForSend(text: string): string[] {
  const segments = text
    .split(/^\s*-{3,}\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
  const parts: string[] = [];
  for (const seg of segments) {
    if (parts.length >= MAX_CHUNKS) break;
    let rest = seg;
    while (rest.length > MAX_CHUNK_LEN) {
      if (parts.length === MAX_CHUNKS - 1) {
        parts.push(rest.slice(0, MAX_CHUNK_LEN - 1) + "…");
        return parts;
      }
      parts.push(rest.slice(0, MAX_CHUNK_LEN));
      rest = rest.slice(MAX_CHUNK_LEN);
    }
    if (rest) parts.push(rest);
  }
  return parts;
}

/** 剥离模型模仿聊天格式带出的“名字: ”回复前缀(只针对当前说话人/机器人自称) */
export function stripNamePrefix(reply: string, ...names: string[]): string {
  for (const name of names) {
    if (!name) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = reply.match(new RegExp(`^\\s*${escaped}\\s*[:：]\\s*`));
    if (!match) continue;
    const stripped = reply.slice(match[0].length).trim();
    return stripped || reply;
  }
  return reply;
}

/** 全量模式下 @某成员 会被替换成 <@openid> 标记,归一化成干净文本 */
export function normalizeGroupText(content: string): string {
  return content
    .replace(/<@all>/g, "@全体成员")
    .replace(/<@[A-Za-z0-9]+>/g, "")
    .trim();
}

const QUOTE_MAX_LEN = 300;

/**
 * 提取引用消息(message_type=103)的被引用内容。
 * 结构不确定时防御性递归收集 msg_elements 里的文本与作者,拼成一段可读上下文。
 */
export function extractQuotedText(event: GroupMessageEvent): string {
  if (event.message_type !== 103 && !event.msg_elements?.length) return "";
  const texts: string[] = [];
  const walk = (list: MsgElement[]): void => {
    for (const el of list) {
      const t = (el.content ?? "").replace(/\s+/g, " ").trim();
      if (t) {
        const name = el.author?.username?.trim();
        texts.push(name && !t.startsWith(`${name}:`) ? `${name}: ${t}` : t);
      }
      if (el.msg_elements?.length) walk(el.msg_elements);
    }
  };
  walk(event.msg_elements ?? []);
  let joined = texts.join(" | ").trim();
  if (!joined) return "";
  if (joined.length > QUOTE_MAX_LEN) joined = joined.slice(0, QUOTE_MAX_LEN - 1) + "…";
  return joined;
}

/** 关键词优先,命中太少再补语义检索 */
async function recallWithFallback(
  env: Env,
  groupId: string,
  query: string,
  excludeIds: number[],
  cfg: MemoryConfig,
  limit = RECALL_LIMIT,
): Promise<MemoryHit[]> {
  const keywords = extractKeywords(query, 6);
  const byKeyword = keywords.length
    ? await recallMessages(env, groupId, keywords, excludeIds, limit).catch(() => [])
    : [];
  if (byKeyword.length >= cfg.semanticMinHits || query.length < 4) return byKeyword;
  const byVector = await semanticRecall(env, groupId, query, excludeIds, cfg.semanticTopK).catch(
    () => [],
  );
  return mergeHits(byKeyword, byVector, limit);
}

/**
 * 自然语言触发的群内能力(没有斜杠指令)。
 * 命中返回 true,该消息不再走聊天流程,也不入库(避免指令污染记忆)。
 */
async function handleIntent(
  env: Env,
  event: GroupMessageEvent,
  rawText: string,
  username: string,
): Promise<boolean> {
  const intent = parseIntent(rawText);
  if (!intent) return false;

  const groupId = event.group_openid;
  const admin = isAdmin(env, event.author?.member_openid);
  const cfg = memoryConfig(env);
  const say = async (content: string): Promise<void> => {
    const chunks = splitForSend(content);
    for (let i = 0; i < chunks.length; i++) {
      await sendGroupMessage(env, groupId, chunks[i], event.id, i + 1);
    }
  };

  try {
    if (intent.adminOnly && !admin) {
      await say("这个得管理员开口我才能做。");
      return true;
    }

    switch (intent.kind) {
      case "reset": {
        await resetGroup(env, groupId);
        await say("好,这个群的记忆我清空了。");
        return true;
      }
      case "reprofile": {
        const target = intent.arg || username;
        const profile = await generateMemberPortrait(env, groupId, target);
        await say(
          profile
            ? `重新看了一遍 ${target}:${profile.persona}`
            : `关于 ${target} 的记录太少,还画不出来。`,
        );
        return true;
      }
      case "profile": {
        const target = intent.arg || username;
        const [profile, stats] = await Promise.all([
          ensureMemberProfile(env, groupId, target),
          memberStats(env, groupId, target),
        ]);
        if (!profile) {
          await say(formatMemberStats(stats));
          return true;
        }
        await say([`${target}:${clip(profile.persona, 200)}`, formatMemberStats(stats)].join("\n"));
        return true;
      }
      case "recall": {
        const query = intent.arg.trim();
        if (!query) {
          await say("想查什么?给我个关键词就行,比如「还记得日本旅游吗」。");
          return true;
        }
        const hits = await recallWithFallback(env, groupId, query, [], cfg);
        await say(formatRecallReply(hits));
        return true;
      }
      case "summary": {
        const summary = await compactGroupMemory(env, groupId, true);
        await say(
          summary ? `【群聊记忆摘要】\n${clip(summary, 400)}` : "记录还太少,攒够了再给你总结。",
        );
        return true;
      }
      case "help": {
        await say(HELP_TEXT);
        return true;
      }
      default:
        return false;
    }
  } catch (err) {
    console.error(`intent ${intent.kind} failed:`, err);
    return true;
  }
}

/** 记忆相关的后台任务:画像、群风格、向量化。失败只记日志,不影响这次回复 */
function scheduleMemoryJobs(
  env: Env,
  groupId: string,
  username: string,
  content: string,
  stored: AppendResult,
  ctx: ExecutionContext,
): void {
  const cfg = memoryConfig(env);
  const { memberCount, msgTotal, id } = stored;

  if (memberCount > 0 && memberCount % cfg.portraitEvery === 0 && memberCount <= cfg.portraitMax) {
    ctx.waitUntil(
      generateMemberPortrait(env, groupId, username).catch((err) =>
        console.error("portrait failed:", err),
      ),
    );
  }

  if (msgTotal > 0 && msgTotal % cfg.styleEvery === 0) {
    ctx.waitUntil(
      generateGroupStyle(env, groupId).catch((err) => console.error("group style failed:", err)),
    );
  }

  if (id > 0 && content.length >= 6) {
    ctx.waitUntil(
      (async () => {
        const embedded = await embedText(env, content);
        if (!embedded) return;
        await saveEmbedding(env, groupId, id, toBase64Int8(embedded.vec), embedded.dim);
      })().catch((err) => console.error("embed failed:", err)),
    );
  }
}

/**
 * 统一处理群消息。
 * spontaneous=false:群 @ 机器人(必回,自然语言能力可用,LLM 失败回兜底话术)
 * spontaneous=true:全量消息(所有消息进记忆;提到名字必插话,否则按概率随机插话;失败静默)
 */
async function handleGroupMessage(
  env: Env,
  event: GroupMessageEvent,
  spontaneous: boolean,
  ctx: ExecutionContext,
): Promise<void> {
  if (!event.group_openid || !event.id) return;
  if (event.author?.bot) return;

  // 记忆层故障不能拖垮回复:去重失败时按"非重复"继续
  const duplicated = await markSeen(env, event.group_openid, event.id).catch((err) => {
    console.error("markSeen failed:", err);
    return false;
  });
  if (duplicated) return;

  const groupId = event.group_openid;
  const cfg = memoryConfig(env);
  // @机器人的消息可能来自 @ 事件,也可能(全量模式下)是带 bot mention 的全量事件,
  // 两种都按“必回的 @ 消息”处理;若两份都到,去重会拦住第二份
  const isAtMessage = !spontaneous || !!event.mentions?.some((m) => m.bot);

  const username = event.author?.username?.trim() || "某人";
  const rawText = normalizeGroupText(event.content ?? "");

  if (isAtMessage && (await handleIntent(env, event, rawText, username))) return;

  const imageParts = await collectImageParts(event.attachments ?? []);
  const imageNote = imageParts.length > 0 ? `[附带${imageParts.length}张图片]` : "";
  const quoteNote = extractQuotedText(event);
  const quotePart = quoteNote ? `[引用消息:${quoteNote}]` : "";

  // 记忆里只存文字:图片只随当次请求发给模型,不入库、不参与画像与风格统计
  const memoryText = [rawText, quotePart].filter(Boolean).join(" ");
  const liveText =
    [rawText, imageNote, quotePart].filter(Boolean).join(" ") ||
    (isAtMessage ? "[发来一条非文本消息,你暂时看不懂]" : "");
  if (!liveText) return;

  if (!isAtMessage && !shouldChimeIn(env, rawText || liveText)) {
    if (memoryText) {
      const stored = await appendMessage(env, groupId, {
        msgId: event.id,
        role: "user",
        author: username,
        content: memoryText,
      }).catch((err) => {
        console.error("store message failed:", err);
        return null;
      });
      if (stored) scheduleMemoryJobs(env, groupId, username, memoryText, stored, ctx);
    }
    return;
  }

  // 先把最近窗口与长期记忆读出来(此时当前消息还没入库,天然不会自己检索自己)
  // 任一读取失败都退化成"没有记忆",不影响这次回话
  const memory = await readSummary(env, groupId).catch((err) => {
    console.error("readSummary failed:", err);
    return { summary: null, uptoId: 0, pending: 0 };
  });
  const recent = await recentMessages(env, groupId, RECENT_LIMIT - 1).catch((err) => {
    console.error("recentMessages failed:", err);
    return [];
  });
  const groupStyle = await getGroupStyle(env, groupId).catch(() => null);
  const speaker = await getMemberProfile(env, groupId, username).catch(() => null);
  const hits = await recallWithFallback(
    env,
    groupId,
    rawText || liveText,
    recent.map((row) => row.id),
    cfg,
  ).catch(() => []);

  if (memoryText) {
    const stored = await appendMessage(env, groupId, {
      msgId: event.id,
      role: "user",
      author: username,
      content: memoryText,
    }).catch((err) => {
      console.error("store message failed:", err);
      return null;
    });
    if (stored) scheduleMemoryJobs(env, groupId, username, memoryText, stored, ctx);
  }

  // 攒够量就在后台压一次长期摘要,不阻塞这次回复
  if (shouldCompact(memory.pending + 1)) {
    ctx.waitUntil(
      compactGroupMemory(env, groupId).catch((err) => console.error("compact failed:", err)),
    );
  }

  // 系统提示词:人格 + 当前北京时间 + 多条消息输出格式(+ 插话补充)
  const beijingTime = new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  let systemContent = `${buildSystemPrompt(env).content}\n(当前北京时间:${beijingTime})\n(输出格式:默认一条消息发完;只在需要连续打字补充、强调或接梗时,才偶尔拆成 2~3 条独立消息,每条一两句话,用单独一行 --- 分隔,首尾不要输出 ---,平时不要拆。单条不超过 300 字;禁止 Markdown 符号。)`;
  if (!isAtMessage) {
    systemContent +=
      "\n(补充:你是主动插话——群里有人在正常聊天,没人@你,你决定接话茬。自然地接上话题,不要解释自己为什么突然说话。)";
  }

  // LLM 智能判断是否需要联网,需要则调 Search API 并注入结果
  const question = rawText || liveText;
  const query = await needsSearch(env, question);
  let searchContext: string | null = null;
  if (query) {
    console.log(`search: query="${query}"`);
    searchContext = await webSearch(env, query, question);
  }

  const styleBlock = groupStyle
    ? `【本群说话风格 | 只参考节奏,不要照抄口癖】\n${groupStyle.style}`
    : null;
  const portraitBlock = speaker
    ? `【当前说话人画像 | 帮你判断怎么接话】\n${speaker.name}:${speaker.persona}`
    : null;
  const summaryBlock = formatSummaryBlock(memory.summary);
  const recallBlock = formatRecallHits(hits);
  const liveUserContent: string | ContentPart[] = imageParts.length
    ? [{ type: "text", text: `${username}: ${liveText}` }, ...imageParts]
    : `${username}: ${liveText}`;

  const messages: ChatMessage[] = [
    { role: "system", content: systemContent },
    ...(styleBlock ? [{ role: "system" as const, content: styleBlock }] : []),
    ...(portraitBlock ? [{ role: "system" as const, content: portraitBlock }] : []),
    ...(summaryBlock ? [{ role: "system" as const, content: summaryBlock }] : []),
    ...(recallBlock ? [{ role: "system" as const, content: recallBlock }] : []),
    ...(searchContext ? [{ role: "system" as const, content: searchContext }] : []),
    ...recent.map((row): ChatMessage => ({
      role: row.role === "assistant" ? "assistant" : "user",
      content: row.role === "assistant" ? row.content : `${row.author ?? username}: ${row.content}`,
    })),
    { role: "user", content: liveUserContent },
  ];

  let reply: string;
  try {
    reply = await chatCompletion(env, messages);
  } catch (err) {
    console.error("LLM failed:", err);
    if (!isAtMessage) return; // 随机插话失败就安静,不刷屏
    reply = "哎呀,我这边脑子转不动了,稍后再试试吧~";
  }
  reply = stripNamePrefix(reply, username, ...resolveAliases(env));

  const chunks = reply ? splitForSend(reply) : [];
  if (chunks.length > 0) {
    await appendMessage(env, groupId, {
      msgId: null,
      role: "assistant",
      author: null,
      content: chunks.join("\n"),
    }).catch((err) => console.error("store reply failed:", err));
  }
  for (let i = 0; i < chunks.length; i++) {
    try {
      await sendGroupMessage(env, groupId, chunks[i], event.id, i + 1);
    } catch (err) {
      console.error(`sendGroupMessage chunk ${i + 1} failed:`, err);
      break;
    }
  }
}

async function dispatch(payload: WebhookPayload, env: Env, ctx: ExecutionContext): Promise<void> {
  if (payload.op !== 0 || !payload.t || !payload.d) return;
  const event = payload.d as unknown as GroupMessageEvent;
  if (payload.t === "GROUP_AT_MESSAGE_CREATE") {
    await handleGroupMessage(env, event, false, ctx);
    return;
  }
  if (payload.t === "GROUP_MESSAGE_CREATE") {
    await handleGroupMessage(env, event, true, ctx);
    return;
  }
  console.log(`ignored event: ${payload.t}`);
}

async function handleWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const rawBody = new Uint8Array(await request.arrayBuffer());

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody)) as WebhookPayload;
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (signature && timestamp) {
    const ok = verifyCallbackSignature(timestamp, rawBody, signature, env.QQ_BOT_SECRET);
    if (!ok) return new Response("bad signature", { status: 401 });
  } else if (payload.op !== 13) {
    // 除回调地址验证外,事件推送必须带签名
    return new Response("missing signature", { status: 401 });
  }

  // op=13:开放平台对回调地址的验证,用 botSecret 派生私钥签名返回
  if (payload.op === 13) {
    const d = (payload.d ?? {}) as { plain_token?: string; event_ts?: string };
    if (!d.plain_token || !d.event_ts) return new Response("bad validation payload", { status: 400 });
    const sig = signCallbackValidation(d.event_ts, d.plain_token, env.QQ_BOT_SECRET);
    return jsonResponse({ plain_token: d.plain_token, signature: sig });
  }

  if (payload.op === 0) {
    // 尽快 ACK,后台处理,避免平台超时重推
    ctx.waitUntil(
      dispatch(payload, env, ctx).catch((err) => console.error("dispatch failed:", err)),
    );
  }
  return jsonResponse({ op: 12 });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === WEBHOOK_PATH) {
      return handleWebhook(request, env, ctx);
    }
    if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      return new Response("ok", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  },

  /** cron 每分钟一次:处理冷场主动发言 */
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runIdleTick(env).catch((err) => console.error("idle tick failed:", err)));
  },
};
