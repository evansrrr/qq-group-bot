import nacl from "tweetnacl";

const encoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** botSecret 按字节重复到 32 字节,作为 Ed25519 seed(与官方 Go 实现等价) */
function seedFromSecret(secret: string): Uint8Array {
  const src = encoder.encode(secret);
  if (src.length === 0) throw new Error("empty QQ_BOT_SECRET");
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = src[i % src.length];
  return seed;
}

function keyPairFromSecret(secret: string): nacl.SignKeyPair {
  return nacl.sign.keyPair.fromSeed(seedFromSecret(secret));
}

/**
 * 校验 webhook 回调签名:官方算法为 Ed25519,签名体 = timestamp + rawBody,
 * 公钥由 botSecret 派生。
 */
export function verifyCallbackSignature(
  timestamp: string,
  body: Uint8Array,
  signatureHex: string,
  secret: string,
): boolean {
  const sig = hexToBytes(signatureHex);
  if (!sig || sig.length !== nacl.sign.signatureLength) return false;
  const { publicKey } = keyPairFromSecret(secret);
  const msg = new Uint8Array(encoder.encode(timestamp).length + body.length);
  msg.set(encoder.encode(timestamp), 0);
  msg.set(body, encoder.encode(timestamp).length);
  return nacl.sign.detached.verify(msg, sig, publicKey);
}

/** op=13 回调地址验证:对 event_ts + plain_token 签名 */
export function signCallbackValidation(
  eventTs: string,
  plainToken: string,
  secret: string,
): string {
  const { secretKey } = keyPairFromSecret(secret);
  const sig = nacl.sign.detached(encoder.encode(eventTs + plainToken), secretKey);
  return bytesToHex(sig);
}
