import { describe, expect, it } from "vitest";
import {
  COMPACT_AFTER,
  RECALL_LIMIT,
  escapeLike,
  extractKeywords,
  formatMemberStats,
  formatRecallHits,
  formatRecallReply,
  formatSummaryBlock,
  scoreHits,
  shouldCompact,
  type MemoryHit,
  type MemberRow,
} from "../src/memory/query";

const hit = (id: number, content: string, author = "张三"): MemoryHit => ({
  id,
  role: "user",
  author,
  content,
  createdAt: new Date("2026-10-28T13:03:00Z").getTime(),
});

describe("extractKeywords", () => {
  it("短词整体保留", () => {
    expect(extractKeywords("日本旅游")).toEqual(["日本旅游"]);
  });

  it("长句切二元组且过滤纯虚词组合", () => {
    const kws = extractKeywords("上次说的那个日本旅游攻略还记得吗");
    expect(kws).toContain("日本");
    expect(kws).toContain("旅游");
    expect(kws).not.toContain("那个");
    expect(kws).not.toContain("的吗");
  });

  it("去掉 @标记 / URL / 方括号占位", () => {
    const kws = extractKeywords("<@ABC123> 看这个 https://a.com/x [附带1张图片] 猫猫");
    expect(kws.join(",")).not.toContain("http");
    expect(kws.join(",")).not.toContain("附带");
    expect(kws).toContain("猫猫");
  });

  it("英文数字保留并转小写", () => {
    expect(extractKeywords("DeepSeek V3 好用")).toContain("deepseek");
  });

  it("去重且受上限约束", () => {
    const kws = extractKeywords("日本旅游日本旅游日本旅游日本旅游", 3);
    expect(kws.length).toBeLessThanOrEqual(3);
    expect(new Set(kws).size).toBe(kws.length);
  });

  it("纯虚词句子抽不出关键词", () => {
    expect(extractKeywords("在吗")).toEqual([]);
  });
});

describe("scoreHits", () => {
  it("多关键词命中越多排越前", () => {
    const rows = [hit(1, "今天天气不错"), hit(2, "日本旅游攻略"), hit(3, "日本旅游很好玩攻略也全")];
    const ranked = scoreHits(rows, ["日本", "旅游", "攻略"]);
    expect(ranked[0].id).toBe(3);
    expect(ranked.map((r) => r.id)).not.toContain(1);
  });

  it("单个关键词最多计 3 次,刷屏长文本压不过同样命中的新消息", () => {
    const spam = hit(9, "日本".repeat(50));
    const normal = hit(10, "日本旅游,日本料理,日本动漫,日本音乐");
    // 不封顶时 spam 得 50 分必赢;封顶后两者都是 3 分,按 id 新的优先
    const ranked = scoreHits([spam, normal], ["日本"]);
    expect(ranked[0].id).toBe(10);
  });

  it("无命中返回空", () => {
    expect(scoreHits([hit(1, "今天吃什么")], ["日本"])).toEqual([]);
  });
});

describe("formatRecallHits", () => {
  it("无命中返回 null", () => {
    expect(formatRecallHits([])).toBeNull();
  });

  it("带日期、作者与条数上限", () => {
    const hits = Array.from({ length: 8 }, (_, i) => hit(i + 1, `第${i + 1}条聊天`));
    const block = formatRecallHits(hits) ?? "";
    expect(block).toContain("群聊历史片段");
    expect(block).toContain("张三");
    expect(block).toContain("10/28");
    expect(block.split("\n").length).toBe(RECALL_LIMIT + 1);
  });

  it("超长内容截断", () => {
    const block = formatRecallHits([hit(1, "字".repeat(300))]) ?? "";
    expect(block).toContain("…");
    expect(block.length).toBeLessThan(200);
  });
});

describe("formatSummaryBlock", () => {
  it("无摘要返回 null,有摘要带包裹", () => {
    expect(formatSummaryBlock(null)).toBeNull();
    expect(formatSummaryBlock("群里常聊游戏")).toContain("群聊长期记忆摘要");
    expect(formatSummaryBlock("群里常聊游戏")).toContain("群里常聊游戏");
  });
});

describe("shouldCompact", () => {
  it("达到阈值才压缩", () => {
    expect(shouldCompact(COMPACT_AFTER - 1)).toBe(false);
    expect(shouldCompact(COMPACT_AFTER)).toBe(true);
  });
});

describe("formatMemberStats", () => {
  const row: MemberRow = {
    name: "张三",
    msg_count: 10,
    char_count: 80,
    first_seen: new Date("2026-10-20T02:00:00Z").getTime(),
    last_seen: new Date("2026-10-29T14:10:00Z").getTime(),
    last_msg: "今天摸鱼",
  };

  it("没记录时给提示", () => {
    expect(formatMemberStats(null)).toContain("还没记到这个人");
  });

  it("展示条数、平均字数与最近一句", () => {
    const text = formatMemberStats(row);
    expect(text).toContain("说过 10 句");
    expect(text).toContain("平均 8 字");
    expect(text).toContain("最近一句: 今天摸鱼");
  });
});

describe("formatRecallReply", () => {
  it("无命中给出提示文案", () => {
    expect(formatRecallReply([])).toContain("没翻到");
  });

  it("有命中带序号与作者", () => {
    const text = formatRecallReply([hit(1, "今天摸鱼好开心", "群友甲")]);
    expect(text).toContain("翻到 1 条");
    expect(text).toContain("群友甲: 今天摸鱼好开心");
  });
});

describe("escapeLike", () => {
  it("转义 LIKE 通配符,防 % 全表匹配", () => {
    expect(escapeLike("100%")).toBe("100\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
    expect(escapeLike("c\\d")).toBe("c\\\\d");
  });
});
