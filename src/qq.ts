import type { Env } from "./env";

interface TokenCache {
  token: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;

export async function getAccessToken(env: Env): Promise<string> {
  // 提前 60s 视为过期
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.token;
  }
  const base = env.QQ_API_BASE ?? "https://api.bot.qq.com";
  const res = await fetch(`${base}/app/getAppAccessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId: env.QQ_APP_ID, clientSecret: env.QQ_BOT_SECRET }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number | string;
    code?: number;
    message?: string;
  };
  if (!data.access_token) {
    throw new Error(`getAppAccessToken failed: code=${data.code} message=${data.message}`);
  }
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in ?? 7200) * 1000,
  };
  return tokenCache.token;
}

/** 发送群消息。msgId 为被动回复来源消息 ID(5 分钟内有效),msgSeq 用于对同一消息多次回复 */
export async function sendGroupMessage(
  env: Env,
  groupOpenId: string,
  content: string,
  msgId: string,
  msgSeq: number,
): Promise<void> {
  const base = env.QQ_API_BASE ?? "https://api.bot.qq.com";
  const token = await getAccessToken(env);
  const res = await fetch(`${base}/v2/groups/${groupOpenId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `QQBot ${token}`,
    },
    body: JSON.stringify({ msg_type: 0, content, msg_id: msgId, msg_seq: msgSeq }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    id?: string;
    err_code?: number;
    message?: string;
    trace_id?: string;
  };
  if (!res.ok || (data.err_code !== undefined && data.err_code !== 0)) {
    throw new Error(
      `sendGroupMessage failed: http=${res.status} err_code=${data.err_code} message=${data.message} trace_id=${data.trace_id}`,
    );
  }
}

/**
 * 主动发群消息(不带 msg_id)。
 * 需要机器人账号有「主动消息」额度,额度用尽或未开通时平台会返回错误码,由调用方决定是否降级。
 */
export async function sendActiveGroupMessage(
  env: Env,
  groupOpenId: string,
  content: string,
): Promise<void> {
  const base = env.QQ_API_BASE ?? "https://api.bot.qq.com";
  const token = await getAccessToken(env);
  const res = await fetch(`${base}/v2/groups/${groupOpenId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `QQBot ${token}`,
    },
    body: JSON.stringify({ msg_type: 0, content }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    id?: string;
    err_code?: number;
    message?: string;
    trace_id?: string;
  };
  if (!res.ok || (data.err_code !== undefined && data.err_code !== 0)) {
    throw new Error(
      `sendActiveGroupMessage failed: http=${res.status} err_code=${data.err_code} message=${data.message} trace_id=${data.trace_id}`,
    );
  }
}
