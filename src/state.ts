import type { Env } from "./env";

/** 默认被叫到就必接话的昵称;可用 BOT_ALIASES 环境变量整体覆盖 */
export const DEFAULT_ALIASES = ["小鲸", "鲸鱼", "机器人"];

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
