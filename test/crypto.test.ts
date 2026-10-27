import { describe, expect, it } from "vitest";
import { signCallbackValidation, verifyCallbackSignature } from "../src/crypto";
import { extractQuotedText, normalizeGroupText, splitForSend, stripNamePrefix } from "../src/index";

const encoder = new TextEncoder();

describe("verifyCallbackSignature(webhook 回调验签)", () => {
  const secret = "naOC0ocQE3shWLAfffVLB1rhYPG7";
  const timestamp = "1725442341";
  const body = `{ "op": 0,"d": {}, "t": "GATEWAY_EVENT_NAME"}`;

  // 文档中的验签示例签名与示例 body 对不上(文档勘误),故用同一原语往返验证:
  // 签名体同为 timestamp+body,signCallbackValidation 已被官方 op=13 向量精确锁定。
  const sig = signCallbackValidation(timestamp, body, secret);

  it("自签消息验证通过(往返)", () => {
    expect(verifyCallbackSignature(timestamp, encoder.encode(body), sig, secret)).toBe(true);
  });

  it("body 被篡改则验证失败", () => {
    const tampered = `{ "op": 0,"d": {}, "t": "GATEWAY_EVENT_OTHER"}`;
    expect(verifyCallbackSignature(timestamp, encoder.encode(tampered), sig, secret)).toBe(false);
  });

  it("secret 不匹配则验证失败", () => {
    expect(verifyCallbackSignature(timestamp, encoder.encode(body), sig, "other-secret")).toBe(false);
  });

  it("签名非 hex 或长度不对则验证失败", () => {
    expect(verifyCallbackSignature(timestamp, encoder.encode(body), "zz", secret)).toBe(false);
    expect(verifyCallbackSignature(timestamp, encoder.encode(body), sig.slice(0, 60), secret)).toBe(
      false,
    );
  });
});

describe("signCallbackValidation(op=13 回调地址验证)", () => {
  it("官方示例签名结果一致", () => {
    const secret = "DG5g3B4j9X2KOErG";
    const eventTs = "1725442341";
    const plainToken = "Arq0D5A61EgUu4OxUvOp";
    const expected =
      "87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706";
    expect(signCallbackValidation(eventTs, plainToken, secret)).toBe(expected);
  });
});

describe("splitForSend", () => {
  it("短消息不拆分", () => {
    expect(splitForSend("你好")).toEqual(["你好"]);
  });

  it("超长消息按 500 字拆分", () => {
    const text = "x".repeat(1200);
    const parts = splitForSend(text);
    expect(parts.length).toBe(3);
    expect(parts.join("")).toHaveLength(1200);
  });

  it("超过 4 段时截断并加省略号", () => {
    const text = "y".repeat(3000);
    const parts = splitForSend(text);
    expect(parts.length).toBe(4);
    expect(parts[3].endsWith("…")).toBe(true);
    expect(parts.every((p) => p.length <= 500)).toBe(true);
  });

  it("按单独一行 --- 拆成多条短消息", () => {
    expect(splitForSend("第一句\n---\n第二句\n---\n第三句")).toEqual([
      "第一句",
      "第二句",
      "第三句",
    ]);
    expect(splitForSend("  第一句 \n --- \n 第二句  ")).toEqual(["第一句", "第二句"]);
  });

  it("长段落内误带 --- 也能正确拆分并保持字数上限", () => {
    const text = `短的\n---\n${"长".repeat(600)}`;
    const parts = splitForSend(text);
    expect(parts[0]).toBe("短的");
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.every((p) => p.length <= 500)).toBe(true);
  });
});

describe("stripNamePrefix", () => {
  it("剥离当前说话人的名字前缀(全角/半角冒号)", () => {
    expect(stripNamePrefix("小明: 哈哈,今天摸鱼", "小明")).toBe("哈哈,今天摸鱼");
    expect(stripNamePrefix("小明:哈哈", "小明")).toBe("哈哈");
    expect(stripNamePrefix(" 小明:在的在的", "小明")).toBe("在的在的");
  });

  it("剥离机器人自称前缀", () => {
    expect(stripNamePrefix("小鲸: 我觉得可以", "小明", "小鲸", "机器人")).toBe("我觉得可以");
    expect(stripNamePrefix("机器人:好的", "小明", "小鲸", "机器人")).toBe("好的");
  });

  it("无前缀或其他人的前缀保持原样", () => {
    expect(stripNamePrefix("哈哈,今天摸鱼", "小明")).toBe("哈哈,今天摸鱼");
    expect(stripNamePrefix("小红: 你说得对", "小明")).toBe("小红: 你说得对");
    expect(stripNamePrefix("注意:这里有个坑", "小明")).toBe("注意:这里有个坑");
  });

  it("整条回复只有名字时回退原文", () => {
    expect(stripNamePrefix("小明:", "小明")).toBe("小明:");
  });
});

describe("normalizeGroupText / extractQuotedText", () => {
  it("剥离 <@openid> 与 <@all> 标记", () => {
    expect(normalizeGroupText("<@ABC123> 你好")).toBe("你好");
    expect(normalizeGroupText("<@all> 集合")).toBe("@全体成员 集合");
  });

  it("引用消息(103)递归提取文本与作者", () => {
    const event = {
      id: "m1",
      content: " ",
      message_type: 103,
      group_openid: "G",
      msg_elements: [
        {
          author: { username: "小明" },
          content: "今天摸鱼好开心",
          msg_elements: [{ content: "确实", author: { username: "小红" } }],
        },
      ],
    };
    expect(extractQuotedText(event)).toBe("小明: 今天摸鱼好开心 | 小红: 确实");
  });

  it("非引用消息或无内容返回空", () => {
    expect(extractQuotedText({ id: "m", content: "hi", group_openid: "G" })).toBe("");
    expect(
      extractQuotedText({ id: "m", content: "", message_type: 103, group_openid: "G" }),
    ).toBe("");
  });

  it("超长引用截断到 300 字", () => {
    const long = "字".repeat(500);
    const out = extractQuotedText({
      id: "m",
      content: "",
      message_type: 103,
      group_openid: "G",
      msg_elements: [{ content: long }],
    });
    expect(out).toHaveLength(300);
    expect(out.endsWith("…")).toBe(true);
  });
});
