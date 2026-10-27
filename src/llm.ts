import defaultPersona from "./prompt/persona.txt";
import type { ChatMessage, ContentPart, Env } from "./env";

/** GLM 免费档链:主模型过载(429)时自动降级到下一档 */
const DEFAULT_GLM_CHAIN = ["glm-4.7-flash", "GLM-4-Flash-250414", "GLM-Z1-Flash"];

export function resolveModelChain(env: Env): string[] {
  const custom = (env.GLM_MODELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return custom.length > 0 ? custom : DEFAULT_GLM_CHAIN;
}

export interface LlmEndpoint {
  baseUrl: string;
  path: string;
  apiKey: string;
  model: string;
  /** 供应商特有请求体字段(如 DeepSeek 关闭深度思考) */
  extraBody?: Record<string, unknown>;
  /** 是否支持图片输入(不支持则自动剥离 image parts) */
  vision?: boolean;
}

/** 供应商感知的故障转移链:DeepSeek 首选(若配了 key),随后是整条 GLM 链 */
export function buildModelChain(env: Env): LlmEndpoint[] {
  const chain: LlmEndpoint[] = [];
  if (env.DEEPSEEK_API_KEY) {
    chain.push({
      baseUrl: env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      path: "/chat/completions",
      apiKey: env.DEEPSEEK_API_KEY,
      model: env.DEEPSEEK_MODEL ?? "deepseek-flash",
      // 该模型默认会深度思考(thinking),关闭以降低延迟和 token 消耗
      extraBody: { thinking: { type: "disabled" } },
      vision: true,
    });
  }
  if (env.GLM_API_KEY) {
    for (const model of resolveModelChain(env)) {
      chain.push({
        baseUrl: env.GLM_BASE_URL ?? "https://open.bigmodel.cn",
        path: "/api/paas/v4/chat/completions",
        apiKey: env.GLM_API_KEY,
        model,
      });
    }
  }
  return chain;
}

/** 非视觉端点:把图片 parts 降级为纯文本(只保留 text 部分) */
function stripImageParts(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (typeof m.content === "string") return m;
    const text = m.content
      .map((p): string => (p.type === "text" ? p.text : "[图片]"))
      .join("\n");
    return { role: m.role, content: text };
  });
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
}

export async function chatCompletion(
  env: Env,
  messages: ChatMessage[],
  opts?: ChatOptions,
): Promise<string> {
  const chain = buildModelChain(env);
  if (chain.length === 0) {
    throw new Error("chatCompletion failed: no api key configured (DEEPSEEK_API_KEY / GLM_API_KEY)");
  }
  let lastError = "";
  for (const endpoint of chain) {
    const bodyMessages = endpoint.vision ? messages : stripImageParts(messages);
    const res = await fetch(`${endpoint.baseUrl}${endpoint.path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${endpoint.apiKey}`,
      },
      body: JSON.stringify({
        model: endpoint.model,
        messages: bodyMessages,
        temperature: opts?.temperature ?? 0.8,
        max_tokens: opts?.maxTokens ?? 600,
        ...endpoint.extraBody,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
      message?: string; // DeepSeek 401 等错误把 message 放在顶层
    };
    const content = data.choices?.[0]?.message?.content;
    if (res.ok && content) {
      console.log(`LLM ok: model=${endpoint.model} base=${endpoint.baseUrl}`);
      return content.trim();
    }

    // 任何失败(过载/超时/key 失效/模型不存在)都尝试链上的下一档
    lastError = `model=${endpoint.model} http=${res.status} error=${data.error?.message ?? data.message}`;
    console.warn(`LLM miss: ${lastError}`);
  }
  throw new Error(`chatCompletion failed: ${lastError}`);
}

export function buildSystemPrompt(env: Env): ChatMessage {
  return {
    role: "system",
    content: env.BOT_PROMPT?.trim() || defaultPersona.trim(),
  };
}
