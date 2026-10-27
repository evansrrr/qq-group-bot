export interface Env {
  /** QQ 开放平台 AppID */
  QQ_APP_ID: string;
  /** QQ 开放平台 BotSecret,同时用于 Ed25519 验签 */
  QQ_BOT_SECRET: string;

  /** DeepSeek key,配置后作为首选供应商 */
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
  /** 仅供本地联调/测试覆盖,生产不配置 */
  DEEPSEEK_BASE_URL?: string;

  /** 智谱开放平台 key,作为兜底供应商 */
  GLM_API_KEY?: string;
  /** 逗号分隔的模型链,按顺序故障转移;不配置则用默认免费档链 */
  GLM_MODELS?: string;
  /** 仅供本地联调/测试覆盖,生产不配置 */
  GLM_BASE_URL?: string;

  /** 仅供本地联调/测试覆盖,生产不配置 */
  QQ_API_BASE?: string;

  /** 人格提示词,整体覆盖 src/prompt/persona.txt */
  BOT_PROMPT?: string;
  /** 逗号分隔的机器人昵称,群里提到就必接话;默认见 state.ts 的 DEFAULT_ALIASES */
  BOT_ALIASES?: string;
  /** 随机插话概率(0-1),默认 "0.3" */
  CHIME_RATE?: string;
}

export type TextPart = { type: "text"; text: string };
export type ImagePart = {
  type: "image_url";
  image_url: { url: string; detail: "low" | "high" | "original" | "auto" };
};
export type ContentPart = TextPart | ImagePart;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  /** 历史消息恒为 string;仅当前这条 user 消息可能带图片 parts */
  content: string | ContentPart[];
}
