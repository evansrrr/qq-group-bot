import { describe, expect, it } from "vitest";
import { formatSearchResults, parseSearchDecision } from "../src/search";

describe("parseSearchDecision", () => {
  it("解析 Y:查询", () => {
    expect(parseSearchDecision("Y:北京今日天气")).toBe("北京今日天气");
    expect(parseSearchDecision("y: 北京今日天气")).toBe("北京今日天气");
    expect(parseSearchDecision("Y:北京今日天气")).toBe("北京今日天气");
  });

  it("Y 无查询内容返回 null", () => {
    expect(parseSearchDecision("Y")).toBeNull();
    expect(parseSearchDecision("Y:")).toBeNull();
  });

  it("N / 无关输出返回 null", () => {
    expect(parseSearchDecision("N")).toBeNull();
    expect(parseSearchDecision("n")).toBeNull();
    expect(parseSearchDecision("这是一条闲聊回复")).toBeNull();
    expect(parseSearchDecision("")).toBeNull();
  });

  it("查询截断到 64 字", () => {
    expect(parseSearchDecision(`Y:${"词".repeat(100)}`)).toHaveLength(64);
  });
});

describe("formatSearchResults", () => {
  it("无结果返回 null", () => {
    expect(formatSearchResults([], "10月17日 21:00")).toBeNull();
  });

  it("包含标题/日期/摘要且最多 5 条", () => {
    const results = Array.from({ length: 8 }, (_, i) => ({
      title: `结果${i + 1}`,
      url: `https://e.com/${i}`,
      summary: `摘要${i + 1}`,
      date: "2026-10-17T00:00:00+00:00",
    }));
    const out = formatSearchResults(results, "10月17日 21:00");
    expect(out).toContain("【联网搜索结果");
    expect(out).toContain("结果1");
    expect(out).toContain("(2026-10-17)");
    expect(out).toContain("摘要5");
    expect(out).not.toContain("结果6");
  });

  it("summary 缺失时回退到 snippet", () => {
    const out = formatSearchResults(
      [{ title: "T", snippet: "短摘要内容" }],
      "10月17日 21:00",
    );
    expect(out).toContain("短摘要内容");
  });
});
