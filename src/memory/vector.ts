import type { Env } from "../env";
import type { MemoryHit } from "./query";
import { loadEmbeddings } from "./store";

export const DEFAULT_EMBEDDING_BASE = "https://open.bigmodel.cn/api/paas/v4";
export const DEFAULT_EMBEDDING_MODEL = "embedding-3";
/** 余弦相似度低于此值不认为相关,避免把不相关的旧话硬塞进上下文 */
export const MIN_SIMILARITY = 0.5;
/** 单次语义检索最多比对多少条历史向量 */
export const SEMANTIC_SCAN_LIMIT = 300;

/**
 * 单位化后量化成 int8 再 base64:512 维只占 683 字节。
 * 归一化后向量模长固定为 127,所以余弦相似度可以直接用点积除以 127² 得到。
 */
export function toBase64Int8(vec: number[]): string {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  const scale = norm > 0 ? 127 / norm : 0;
  const bytes = new Uint8Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    const q = Math.max(-127, Math.min(127, Math.round(vec[i] * scale)));
    bytes[i] = q & 0xff;
  }
  let binary = "";
  const chunk = 0x2000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64Int8(b64: string): Int8Array {
  const binary = atob(b64);
  const out = new Int8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    const byte = binary.charCodeAt(i) & 0xff;
    out[i] = byte > 127 ? byte - 256 : byte;
  }
  return out;
}

/** 两个已归一化为 int8 的向量做余弦相似度(点积 / 127²) */
export function cosineInt8(a: Int8Array, b: Int8Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot / (127 * 127);
}

export interface EmbeddingVector {
  vec: number[];
  dim: number;
}

function embeddingEndpoint(env: Env): { base: string; key: string; model: string } | null {
  const key = env.EMBEDDING_API_KEY ?? env.GLM_API_KEY;
  if (!key) return null;
  const base = (env.EMBEDDING_BASE_URL ?? env.GLM_BASE_URL ?? DEFAULT_EMBEDDING_BASE).replace(
    /\/$/,
    "",
  );
  return { base, key, model: env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL };
}

/** 调 embedding 接口;任何失败都返回 null,由调用方退回关键词检索 */
export async function embedText(env: Env, text: string): Promise<EmbeddingVector | null> {
  const endpoint = embeddingEndpoint(env);
  const input = text.replace(/\s+/g, " ").trim().slice(0, 1000);
  if (!endpoint || !input) return null;
  try {
    const res = await fetch(`${endpoint.base}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${endpoint.key}`,
      },
      body: JSON.stringify({ model: endpoint.model, input }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      data?: { embedding?: number[] }[];
      error?: { message?: string };
    };
    const vec = data.data?.[0]?.embedding;
    if (!res.ok || !Array.isArray(vec) || vec.length === 0) {
      console.warn(`embedText failed: http=${res.status} error=${data.error?.message ?? ""}`);
      return null;
    }
    return { vec, dim: vec.length };
  } catch (err) {
    console.warn("embedText failed:", err);
    return null;
  }
}

/** 关键词召回不足时补一次语义检索;失败返回空数组,不影响主链路 */
export async function semanticRecall(
  env: Env,
  groupId: string,
  query: string,
  excludeIds: number[],
  topK: number,
): Promise<MemoryHit[]> {
  const embedded = await embedText(env, query);
  if (!embedded) return [];
  const queryVec = fromBase64Int8(toBase64Int8(embedded.vec));

  const rows = await loadEmbeddings(env, groupId, SEMANTIC_SCAN_LIMIT);
  const skip = new Set(excludeIds);
  const scored: { hit: MemoryHit; score: number }[] = [];
  for (const row of rows) {
    if (skip.has(row.id) || row.dim !== embedded.dim) continue;
    const score = cosineInt8(queryVec, fromBase64Int8(row.vec));
    if (score >= MIN_SIMILARITY) {
      scored.push({ hit: { id: row.id, role: row.role, author: row.author, content: row.content, createdAt: row.createdAt }, score });
    }
  }
  scored.sort((a, b) => b.score - a.score || b.hit.id - a.hit.id);
  return scored.slice(0, topK).map((s) => s.hit);
}

/** 合并两路召回结果,按 id 去重,先到先留 */
export function mergeHits(primary: MemoryHit[], extra: MemoryHit[], limit: number): MemoryHit[] {
  const seen = new Set(primary.map((h) => h.id));
  const merged = [...primary];
  for (const hit of extra) {
    if (merged.length >= limit) break;
    if (seen.has(hit.id)) continue;
    seen.add(hit.id);
    merged.push(hit);
  }
  return merged.slice(0, limit);
}
