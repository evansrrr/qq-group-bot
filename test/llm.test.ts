import { afterEach, describe, expect, it, vi } from "vitest";
import { buildModelChain, chatCompletion, resolveModelChain } from "../src/llm";
import type { Env } from "../src/env";

const env: Env = {
  QQ_APP_ID: "x",
  QQ_BOT_SECRET: "x",
  GLM_API_KEY: "test-key",
};

const messages = [{ role: "user" as const, content: "hi" }];

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

function callInfo(fetchMock: ReturnType<typeof vi.fn>, callIndex: number) {
  const [url, init] = fetchMock.mock.calls[callIndex] as [string, RequestInit];
  return { url, body: JSON.parse(init.body as string) as { model: string; thinking?: unknown } };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildModelChain", () => {
  it("未配 DeepSeek key 时只有 GLM 免费档链", () => {
    expect(buildModelChain(env).map((e) => e.model)).toEqual([
      "glm-4.7-flash",
      "GLM-4-Flash-250414",
      "GLM-Z1-Flash",
    ]);
  });

  it("配了 DeepSeek key 则作为首选,且默认关闭深度思考、开启视觉", () => {
    const chain = buildModelChain({ ...env, DEEPSEEK_API_KEY: "sk-test" });
    expect(chain[0]).toEqual({
      baseUrl: "https://api.deepseek.com",
      path: "/chat/completions",
      apiKey: "sk-test",
      model: "deepseek-flash",
      extraBody: { thinking: { type: "disabled" } },
      vision: true,
    });
    expect(chain).toHaveLength(4);
    expect(chain[1].model).toBe("glm-4.7-flash");
    expect(chain[1].extraBody).toBeUndefined();
    expect(chain[1].vision).toBeFalsy();
  });

  it("GLM_MODELS 可覆盖 GLM 子链", () => {
    expect(resolveModelChain({ ...env, GLM_MODELS: "m1, m2 ," })).toEqual(["m1", "m2"]);
  });
});

describe("chatCompletion 故障转移", () => {
  it("DeepSeek 429 时降级到 GLM", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: "busy" } }))
      .mockResolvedValueOnce(jsonResponse(200, { choices: [{ message: { content: " 回复内容 " } }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(chatCompletion({ ...env, DEEPSEEK_API_KEY: "sk-test" }, messages)).resolves.toBe(
      "回复内容",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = callInfo(fetchMock, 0);
    expect(first.url).toBe("https://api.deepseek.com/chat/completions");
    expect(first.body.model).toBe("deepseek-flash");
    expect(first.body.thinking).toEqual({ type: "disabled" });
    expect(callInfo(fetchMock, 1).body.model).toBe("glm-4.7-flash");
    expect(callInfo(fetchMock, 1).body.thinking).toBeUndefined();
  });

  it("GLM 主模型 429 时切换下一档", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: "busy" } }))
      .mockResolvedValueOnce(jsonResponse(200, { choices: [{ message: { content: "ok" } }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(chatCompletion(env, messages)).resolves.toBe("ok");
    expect(callInfo(fetchMock, 1).body.model).toBe("GLM-4-Flash-250414");
  });

  it("401 也继续尝试下一档(跨供应商)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: { message: "invalid api key" } }))
      .mockResolvedValueOnce(jsonResponse(200, { choices: [{ message: { content: "ok" } }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(chatCompletion(env, messages)).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("链上全部失败后抛错,错误含最后的模型名", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => jsonResponse(429, { error: { message: "busy" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(chatCompletion(env, messages)).rejects.toThrow(
      "model=GLM-Z1-Flash http=429 error=busy",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("没有任何 key 时直接抛错", async () => {
    await expect(
      chatCompletion({ QQ_APP_ID: "x", QQ_BOT_SECRET: "x" }, messages),
    ).rejects.toThrow("no api key configured");
  });

  it("非视觉端点(GLM)自动剥离图片 parts 为纯文本", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { choices: [{ message: { content: "ok" } }] }));
    vi.stubGlobal("fetch", fetchMock);

    await chatCompletion(env, [
      { role: "system", content: "sys" },
      {
        role: "user",
        content: [
          { type: "text", text: "群友甲: 看图 [附带1张图片]" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "low" } },
        ],
      },
    ]);
    const sent = callInfo(fetchMock, 0).body as unknown as {
      messages: { content: unknown }[];
    };
    expect(sent.messages[1].content).toBe("群友甲: 看图 [附带1张图片]\n[图片]");
  });

  it("视觉端点(DeepSeek)保留图片 parts 与 detail=low", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { choices: [{ message: { content: "ok" } }] }));
    vi.stubGlobal("fetch", fetchMock);

    await chatCompletion({ ...env, DEEPSEEK_API_KEY: "sk" }, [
      { role: "system", content: "sys" },
      {
        role: "user",
        content: [
          { type: "text", text: "看图" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "low" } },
        ],
      },
    ]);
    const sent = callInfo(fetchMock, 0).body as unknown as {
      messages: { content: unknown }[];
    };
    expect(Array.isArray(sent.messages[1].content)).toBe(true);
  });

  it("ChatOptions.maxTokens/temperature 透传到请求体", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { choices: [{ message: { content: "ok" } }] }));
    vi.stubGlobal("fetch", fetchMock);

    await chatCompletion(env, messages, { maxTokens: 40, temperature: 0 });
    const body = callInfo(fetchMock, 0).body as unknown as {
      max_tokens: number;
      temperature: number;
    };
    expect(body.max_tokens).toBe(40);
    expect(body.temperature).toBe(0);
  });
});
