import type { ImagePart } from "./env";

const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 8000;

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function isSupportedImage(contentType?: string, filename?: string): boolean {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.startsWith("image/")) return true;
  const name = (filename ?? "").toLowerCase();
  return /\.(jpe?g|png|gif|webp)$/.test(name);
}

/**
 * 下载群消息里的图片并编码为 base64 data URL(detail=low)。
 * 下载失败时退回原始 URL 让 DeepSeek 自己拉取;非支持格式/超限的跳过。
 */
export async function collectImageParts(
  attachments: { content_type?: string; filename?: string; url?: string }[],
): Promise<ImagePart[]> {
  const parts: ImagePart[] = [];
  for (const att of attachments) {
    if (parts.length >= MAX_IMAGES) break;
    if (!att.url || !isSupportedImage(att.content_type, att.filename)) continue;

    const image_url: ImagePart["image_url"] = { url: att.url, detail: "low" };
    try {
      const res = await fetch(att.url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (res.ok) {
        const buf = await res.arrayBuffer();
        if (buf.byteLength > 0 && buf.byteLength <= MAX_IMAGE_BYTES) {
          const mime =
            (res.headers.get("content-type") ?? "").split(";")[0].trim() ||
            att.content_type?.split(";")[0]?.trim() ||
            "image/jpeg";
          image_url.url = `data:${mime};base64,${arrayBufferToBase64(buf)}`;
        }
      }
    } catch {
      // 下载失败:保留原始 URL 交给 DeepSeek 自行拉取
    }
    parts.push({ type: "image_url", image_url });
  }
  return parts;
}
