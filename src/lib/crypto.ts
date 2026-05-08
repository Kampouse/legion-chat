const ALGO = "AES-GCM";

export async function generateGroupKey(): Promise<Uint8Array> {
  return crypto.getRandomValues(new Uint8Array(32));
}

export function encodeGroupKey(key: Uint8Array): string {
  return Array.from(key)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function decodeGroupKey(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export async function encryptMessage(
  key: Uint8Array,
  plaintext: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await crypto.subtle.importKey(
    "raw",
    key,
    ALGO,
    false,
    ["encrypt"],
  );
  const ct = await crypto.subtle.encrypt(
    { name: ALGO, iv },
    aesKey,
    new TextEncoder().encode(plaintext),
  );
  const buf = new Uint8Array(iv.length + ct.byteLength);
  buf.set(iv, 0);
  buf.set(new Uint8Array(ct), iv.length);
  return btoa(String.fromCharCode(...buf));
}

export async function decryptMessage(
  key: Uint8Array,
  b64: string,
): Promise<string> {
  const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const iv = buf.slice(0, 12);
  const ct = buf.slice(12);
  const aesKey = await crypto.subtle.importKey(
    "raw",
    key,
    ALGO,
    false,
    ["decrypt"],
  );
  const pt = await crypto.subtle.decrypt({ name: ALGO, iv }, aesKey, ct);
  return new TextDecoder().decode(pt);
}
