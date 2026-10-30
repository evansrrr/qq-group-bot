import type { Env } from "../env";
import { buildSystemPrompt, chatCompletion } from "../llm";
import { sendActiveGroupMessage } from "../qq";
import { memoryConfig } from "./config";
import { clip } from "./query";
import {
  appendMessage,
  dueIdleGroups,
  getGroupStyle,
  markProactiveSpoken,
  planIdleGroups,
  readSummary,
  recentMessages,
} from "./store";

const IDLE_HINT = [
  "(补充:这个群已经安静很久了,你是自己开口。起个话头就好——接之前的梗、说一句日常、或问一个具体的小问题。",
  "不要问『在吗』,不要说『我来了』『有人吗』,不要解释你为什么说话,一句话,不超过 30 字,不用 Markdown。)",
].join("");

function beijingTime(): string {
  return new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 生成一句主动发言;失败返回 null(没有 key、上游全挂都算失败) */
export async function composeIdleMessage(env: Env, groupId: string): Promise<string | null> {
  const [memory, style, recent] = await Promise.all([
    readSummary(env, groupId).catch(() => ({ summary: null, uptoId: 0, pending: 0 })),
    getGroupStyle(env, groupId).catch(() => null),
    recentMessages(env, groupId, 8).catch(() => []),
  ]);

  const system = [
    buildSystemPrompt(env).content,
    `(当前北京时间:${beijingTime()})`,
    style ? `(本群说话风格:${style.style})` : "",
    memory.summary ? `(群聊长期记忆:${clip(memory.summary, 300)})` : "",
    IDLE_HINT,
  ]
    .filter(Boolean)
    .join("\n");

  const context = recent.map(
    (row) => `${row.author ?? "机器人"}: ${clip(row.content, 120)}`,
  );

  const reply = await chatCompletion(
    env,
    [
      { role: "system", content: system },
      ...(context.length > 0
        ? [{ role: "user" as const, content: `最近几条聊天:\n${context.join("\n")}` }]
        : []),
      { role: "user", content: "(现在没人说话,你说一句)" },
    ],
    { maxTokens: 120, temperature: 0.95 },
  );
  return clip(reply, 120) || null;
}

/**
 * 冷场发言的定时任务(cron 每分钟跑一次):
 * 1) 给「静默够久且上次主动发言后没人说话」的群排一个随机时间点
 * 2) 到点的群生成一句话主动发出去
 * 主动消息需要平台额度,发送失败只记日志并清掉本次计划,避免每分钟重试把额度打光。
 */
export async function runIdleTick(env: Env, now = Date.now()): Promise<number> {
  const cfg = memoryConfig(env);
  await planIdleGroups(
    env,
    now,
    cfg.idleAfterMin * 60_000,
    cfg.idleMaxWaitMin * 60_000,
    cfg.idleMinMsgs,
  );

  const groups = await dueIdleGroups(env, now, cfg.idleBatch);
  let spoken = 0;
  for (const groupId of groups) {
    try {
      const text = await composeIdleMessage(env, groupId);
      if (text) {
        await sendActiveGroupMessage(env, groupId, text);
        await appendMessage(env, groupId, {
          msgId: null,
          role: "assistant",
          author: null,
          content: text,
        }).catch((err) => console.error("store idle message failed:", err));
        spoken++;
      }
    } catch (err) {
      console.error(`idle speak failed (${groupId}):`, err);
    } finally {
      await markProactiveSpoken(env, groupId, now).catch((err) =>
        console.error("markProactiveSpoken failed:", err),
      );
    }
  }
  return spoken;
}
