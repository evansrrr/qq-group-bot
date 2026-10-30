import { describe, expect, it } from "vitest";
import { parsePortrait, styleStats } from "../src/memory/profile";
import { memoryConfig } from "../src/memory/config";
import type { Env } from "../src/env";

describe("styleStats", () => {
  it("空样本返回全 0", () => {
    expect(styleStats([])).toEqual({ samples: 0, avgLen: 0, questionRatio: 0, emojiRatio: 0 });
  });

  it("统计平均长度、问句占比、表情占比", () => {
    const stats = styleStats(["你好", "今天吃什么?", "哈哈哈😄", "行的"]);
    expect(stats.samples).toBe(4);
    expect(stats.avgLen).toBe(4);
    expect(stats.questionRatio).toBe(25);
    expect(stats.emojiRatio).toBe(25);
  });

  it("全角问号也算问句", () => {
    expect(styleStats(["走了？"]).questionRatio).toBe(100);
  });
});

describe("parsePortrait", () => {
  it("解析 画像|话题|风格 三段", () => {
    const parsed = parsePortrait("句子短、爱接梗|摸鱼,游戏|话少,爱阴阳");
    expect(parsed.persona).toBe("句子短、爱接梗");
    expect(parsed.topics).toBe("摸鱼,游戏");
    expect(parsed.style).toBe("话少,爱阴阳");
  });

  it("只有一段时整段当画像", () => {
    expect(parsePortrait("就是一个普通群友").persona).toBe("就是一个普通群友");
  });

  it("两段时第三段为空", () => {
    const parsed = parsePortrait("画像内容|话题A");
    expect(parsed.persona).toBe("画像内容");
    expect(parsed.style).toBe("");
  });

  it("超长画像截断", () => {
    expect(parsePortrait("字".repeat(500)).persona.length).toBe(120);
  });

  it("空输出返回空画像", () => {
    expect(parsePortrait("   ").persona).toBe("");
  });
});

describe("memoryConfig", () => {
  it("默认值", () => {
    const cfg = memoryConfig({} as Env);
    expect(cfg).toMatchObject({
      portraitEvery: 20,
      portraitMax: 100,
      styleEvery: 150,
      idleAfterMin: 30,
      idleMaxWaitMin: 300,
      semanticMinHits: 2,
      semanticTopK: 3,
    });
  });

  it("环境变量覆盖", () => {
    const cfg = memoryConfig({
      PORTRAIT_EVERY: "40",
      IDLE_AFTER_MIN: "5",
      SEMANTIC_TOP_K: "5",
    } as Env);
    expect(cfg.portraitEvery).toBe(40);
    expect(cfg.idleAfterMin).toBe(5);
    expect(cfg.semanticTopK).toBe(5);
  });

  it("非法与越界值回落到合法区间", () => {
    const cfg = memoryConfig({
      PORTRAIT_EVERY: "abc",
      IDLE_AFTER_MIN: "-5",
      SEMANTIC_TOP_K: "999",
    } as Env);
    expect(cfg.portraitEvery).toBe(20);
    expect(cfg.idleAfterMin).toBe(0);
    expect(cfg.semanticTopK).toBe(10);
  });
});
