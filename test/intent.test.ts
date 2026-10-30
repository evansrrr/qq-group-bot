import { describe, expect, it } from "vitest";
import { extractName, extractRecallQuery, isAdmin, parseIntent } from "../src/intent";

describe("parseIntent 重置", () => {
  it.each([
    "清空这个群的记忆",
    "重置一下聊天记录",
    "把群记忆删掉吧",
    "忘掉之前的记录",
  ])("识别为 reset:%s", (text) => {
    expect(parseIntent(text)?.kind).toBe("reset");
  });

  it("重置需要管理员", () => {
    expect(parseIntent("清空这个群的记忆")?.adminOnly).toBe(true);
  });

  it("普通聊天不误判", () => {
    expect(parseIntent("今天的东西忘掉带了")).toBeNull();
    expect(parseIntent("这个记录我删了")).toBeNull();
  });
});

describe("parseIntent 画像", () => {
  it.each([
    ["张三的画像", "张三"],
    ["张三是什么样的人", "张三"],
    ["了解一下狗子", "狗子"],
    ["给群友甲做个画像", "群友甲"],
  ])("%s → profile %s", (text, name) => {
    const intent = parseIntent(text);
    expect(intent?.kind).toBe("profile");
    expect(intent?.arg).toBe(name);
  });

  it("重做画像单独识别且需要管理员", () => {
    const intent = parseIntent("重新给张三做个画像");
    expect(intent?.kind).toBe("reprofile");
    expect(intent?.adminOnly).toBe(true);
  });

  it("重做画像不会把「做个」吃进名字", () => {
    expect(parseIntent("重新给群友甲做个画像")?.arg).toBe("群友甲");
  });
});

describe("parseIntent 总结", () => {
  it.each(["总结一下群里最近聊的", "概括下这个群的聊天", "帮我回顾一下这几天都聊了啥"])(
    "识别为 summary:%s",
    (text) => {
      expect(parseIntent(text)?.kind).toBe("summary");
    },
  );

  it("短句直接说总结也算", () => {
    expect(parseIntent("总结一下")?.kind).toBe("summary");
  });
});

describe("parseIntent 检索", () => {
  it("还记得 X 吗", () => {
    const intent = parseIntent("还记得日本旅游吗");
    expect(intent?.kind).toBe("recall");
    expect(intent?.arg).toBe("日本旅游");
  });

  it("查一下之前的记录 X", () => {
    const intent = parseIntent("查一下之前的聊天记录 日本旅游");
    expect(intent?.kind).toBe("recall");
    expect(intent?.arg).toBe("日本旅游");
  });

  it("找不到检索词时 arg 为空,由调用方追问", () => {
    const intent = parseIntent("查一下聊天记录");
    expect(intent?.kind).toBe("recall");
    expect(intent?.arg).toBe("");
  });
});

describe("parseIntent 边界", () => {
  it("普通聊天不产生意图", () => {
    for (const text of ["今天吃什么", "这波断档了", "哈哈哈哈", "你好呀"]) {
      expect(parseIntent(text), text).toBeNull();
    }
  });

  it("超长文本不做意图判断", () => {
    expect(parseIntent(`总结一下${"啊".repeat(80)}`)).toBeNull();
  });

  it("空文本返回 null", () => {
    expect(parseIntent("")).toBeNull();
    expect(parseIntent("   ")).toBeNull();
  });

  it("去掉 @ 标记后再判断", () => {
    expect(parseIntent("<@BOT123> 总结一下群里最近聊的")?.kind).toBe("summary");
  });

  it("帮助意图", () => {
    expect(parseIntent("你能做什么")?.kind).toBe("help");
    expect(parseIntent("怎么用")?.kind).toBe("help");
  });

  it("总结优先于检索,避免抢词", () => {
    expect(parseIntent("总结一下群里最近聊的记录")?.kind).toBe("summary");
  });
});

describe("extractName", () => {
  it("取不到的返回空串", () => {
    expect(extractName("看看画像")).toBe("");
  });
});

describe("extractRecallQuery", () => {
  it("剥掉动词与名词壳子", () => {
    expect(extractRecallQuery("查一下之前的记录 日本旅游")).toBe("日本旅游");
    expect(extractRecallQuery("找找上次说过的显卡")).toBe("显卡");
  });
});

describe("isAdmin", () => {
  it("命中白名单", () => {
    expect(isAdmin({ ADMIN_OPENIDS: "A1, A2" }, "A2")).toBe(true);
  });

  it("未配置或未命中返回 false", () => {
    expect(isAdmin({}, "A1")).toBe(false);
    expect(isAdmin({ ADMIN_OPENIDS: "A1" }, "A3")).toBe(false);
    expect(isAdmin({ ADMIN_OPENIDS: "A1" }, undefined)).toBe(false);
  });
});
