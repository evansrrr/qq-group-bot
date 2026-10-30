import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ALIASES, resolveAliases, shouldChimeIn } from "../src/state";
import type { Env } from "../src/env";

const env: Env = {
  DB: {} as D1Database,
  QQ_APP_ID: "x",
  QQ_BOT_SECRET: "x",
  CHIME_RATE: "0",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveAliases", () => {
  it("未配置时使用默认昵称", () => {
    expect(resolveAliases(env)).toEqual(DEFAULT_ALIASES);
  });

  it("BOT_ALIASES 支持中英文逗号与空格分隔", () => {
    expect(resolveAliases({ ...env, BOT_ALIASES: "阿B, 老板，小助手" })).toEqual([
      "阿B",
      "老板",
      "小助手",
    ]);
  });
});

describe("shouldChimeIn", () => {
  it("提到默认昵称必接(即使概率为 0)", () => {
    for (const alias of DEFAULT_ALIASES) {
      expect(shouldChimeIn(env, `听说${alias}很强`), alias).toBe(true);
    }
  });

  it("大小写不敏感", () => {
    const e: Env = { ...env, BOT_ALIASES: "BotX" };
    expect(shouldChimeIn(e, "botx 在吗")).toBe(true);
    expect(shouldChimeIn(e, "BOTX 在吗")).toBe(true);
  });

  it("自定义昵称覆盖默认昵称(默认昵称不再必接)", () => {
    const e: Env = { ...env, BOT_ALIASES: "阿B" };
    expect(shouldChimeIn(e, "阿B 出来说话")).toBe(true);
    expect(shouldChimeIn(e, `${DEFAULT_ALIASES[0]} 出来说话`)).toBe(false);
  });

  it("昵称含正则元字符也不报错", () => {
    const e: Env = { ...env, BOT_ALIASES: "c++" };
    expect(shouldChimeIn(e, "c++ 好用吗")).toBe(true);
    expect(shouldChimeIn(e, "java 好用吗")).toBe(false);
  });

  it("概率为 0 的普通消息不接", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    expect(shouldChimeIn(env, "今天天气不错")).toBe(false);
  });

  it("30% 概率边界:random < 0.3 接,>= 0.3 不接", () => {
    const rate30: Env = { ...env, CHIME_RATE: "0.3" };
    vi.spyOn(Math, "random").mockReturnValue(0.29);
    expect(shouldChimeIn(rate30, "随便聊聊")).toBe(true);
    vi.spyOn(Math, "random").mockReturnValue(0.3);
    expect(shouldChimeIn(rate30, "随便聊聊")).toBe(false);
  });

  it("未配置 CHIME_RATE 时默认 0.3", () => {
    const { CHIME_RATE: _, ...rest } = env;
    vi.spyOn(Math, "random").mockReturnValue(0.2);
    expect(shouldChimeIn(rest, "闲聊一句")).toBe(true);
  });
});
