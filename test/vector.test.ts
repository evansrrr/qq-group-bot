import { describe, expect, it } from "vitest";
import {
  cosineInt8,
  fromBase64Int8,
  mergeHits,
  toBase64Int8,
} from "../src/memory/vector";
import type { MemoryHit } from "../src/memory/query";

const hit = (id: number): MemoryHit => ({
  id,
  role: "user",
  author: "张三",
  content: `c${id}`,
  createdAt: 0,
});

describe("int8 向量编解码", () => {
  it("往返后仍能比较:同向量余弦为 1", () => {
    const vec = [0.12, -0.5, 0.8, 0.31, 0, 0.02];
    const a = fromBase64Int8(toBase64Int8(vec));
    const b = fromBase64Int8(toBase64Int8(vec));
    expect(cosineInt8(a, b)).toBeCloseTo(1, 2);
  });

  it("正交向量余弦接近 0", () => {
    const a = fromBase64Int8(toBase64Int8([1, 0, 0, 0]));
    const b = fromBase64Int8(toBase64Int8([0, 1, 0, 0]));
    expect(cosineInt8(a, b)).toBeCloseTo(0, 5);
  });

  it("反向量余弦为 -1", () => {
    const a = fromBase64Int8(toBase64Int8([1, 2, 3, 4]));
    const b = fromBase64Int8(toBase64Int8([-1, -2, -3, -4]));
    expect(cosineInt8(a, b)).toBeCloseTo(-1, 2);
  });

  it("相近向量高于不相关向量", () => {
    const query = fromBase64Int8(toBase64Int8([1, 1, 1, 0]));
    const near = fromBase64Int8(toBase64Int8([1, 0.9, 1, 0.1]));
    const far = fromBase64Int8(toBase64Int8([-1, -1, 0, 1]));
    expect(cosineInt8(query, near)).toBeGreaterThan(cosineInt8(query, far));
  });

  it("零向量不会产生 NaN", () => {
    const zero = fromBase64Int8(toBase64Int8([0, 0, 0]));
    expect(Number.isNaN(cosineInt8(zero, zero))).toBe(false);
  });

  it("空向量不炸", () => {
    expect(cosineInt8(new Int8Array(0), new Int8Array(0))).toBe(0);
    expect(toBase64Int8([])).toBe("");
  });
});

describe("mergeHits", () => {
  it("保留主路顺序,追加去重后的补充结果", () => {
    const merged = mergeHits([hit(3), hit(2)], [hit(2), hit(9), hit(1)], 4);
    expect(merged.map((h) => h.id)).toEqual([3, 2, 9, 1]);
  });

  it("受上限约束", () => {
    expect(mergeHits([hit(1)], [hit(2), hit(3), hit(4)], 2).map((h) => h.id)).toEqual([1, 2]);
  });

  it("空输入返回空", () => {
    expect(mergeHits([], [], 5)).toEqual([]);
  });
});
