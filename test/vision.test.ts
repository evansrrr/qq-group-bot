import { afterEach, describe, expect, it, vi } from "vitest";
import { collectImageParts } from "../src/vision";

afterEach(() => {
  vi.unstubAllGlobals();
});

function att(contentType: string, url = "https://cdn.example.com/a.jpg", filename = "a.jpg") {
  return { content_type: contentType, filename, url };
}

describe("collectImageParts", () => {
  it("下载成功编码为 base64 data URL,detail=low", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      ),
    );
    const parts = await collectImageParts([att("image/png")]);
    expect(parts).toHaveLength(1);
    expect(parts[0].image_url.detail).toBe("low");
    expect(parts[0].image_url.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("最多取 3 张,忽略非图片", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([9]), { status: 200, headers: { "content-type": "image/gif" } }),
      ),
    );
    const parts = await collectImageParts([
      att("image/gif", "https://c/1.gif", "1.gif"),
      att("video/mp4", "https://c/2.mp4", "2.mp4"),
      att("image/jpeg", "https://c/3.jpg", "3.jpg"),
      att("image/webp", "https://c/4.webp", "4.webp"),
      att("image/png", "https://c/5.png", "5.png"),
    ]);
    expect(parts).toHaveLength(3);
  });

  it("下载失败时回退为原始 URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    const url = "https://multimedia.nt.qq.com.cn/download?x=1";
    const parts = await collectImageParts([att("image/jpeg", url)]);
    expect(parts).toHaveLength(1);
    expect(parts[0].image_url.url).toBe(url);
  });

  it("按扩展名识别 content_type 缺失的图片", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([7]), { status: 200, headers: { "content-type": "image/webp" } }),
      ),
    );
    const parts = await collectImageParts([
      { filename: "sticker.WEBP", url: "https://c/s.webp" },
    ]);
    expect(parts).toHaveLength(1);
  });
});
