import type { Env } from "../env";

/** 记忆相关阈值集中在这里,全部可用环境变量覆盖(便于按群调优与小规模测试) */
export interface MemoryConfig {
  /** 成员每发多少条做一次画像 */
  portraitEvery: number;
  /** 成员累计发言到这个条数后不再自动画像 */
  portraitMax: number;
  /** 群消息累计多少条更新一次群风格 */
  styleEvery: number;
  /** 生成画像所需的最少发言条数 */
  portraitMinSamples: number;
  /** 生成群风格所需的最少样本条数 */
  styleMinSamples: number;
  /** 静默多久后可安排主动发言(分钟) */
  idleAfterMin: number;
  /** 静默后随机等待的上限(分钟) */
  idleMaxWaitMin: number;
  /** 群消息总量低于此值不主动发言,避免新群/小群被自言自语 */
  idleMinMsgs: number;
  /** 单次 cron 最多处理几个群,控制成本 */
  idleBatch: number;
  /** 语义检索:关键词命中少于此值时补一次向量检索 */
  semanticMinHits: number;
  /** 语义检索返回条数 */
  semanticTopK: number;
}

function num(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export function memoryConfig(env: Env): MemoryConfig {
  return {
    portraitEvery: Math.round(num(env.PORTRAIT_EVERY, 20, 2, 1000)),
    portraitMax: Math.round(num(env.PORTRAIT_MAX, 100, 2, 100000)),
    styleEvery: Math.round(num(env.STYLE_EVERY, 150, 2, 100000)),
    portraitMinSamples: Math.round(num(env.PORTRAIT_MIN_SAMPLES, 5, 2, 1000)),
    styleMinSamples: Math.round(num(env.STYLE_MIN_SAMPLES, 10, 2, 1000)),
    idleAfterMin: Math.round(num(env.IDLE_AFTER_MIN, 30, 0, 10080)),
    idleMaxWaitMin: Math.round(num(env.IDLE_MAX_WAIT_MIN, 300, 0, 10080)),
    idleMinMsgs: Math.round(num(env.IDLE_MIN_MSGS, 10, 0, 100000)),
    idleBatch: Math.round(num(env.IDLE_BATCH, 3, 1, 20)),
    semanticMinHits: Math.round(num(env.SEMANTIC_MIN_HITS, 2, 0, 10)),
    semanticTopK: Math.round(num(env.SEMANTIC_TOP_K, 3, 1, 10)),
  };
}
