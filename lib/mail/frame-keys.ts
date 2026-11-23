const NAMED_KEYS = new Set(["Escape"]);

export type ForwardedKey = { key: string; code: string; shiftKey: boolean; repeat: boolean };

export function forwardedKey(message: unknown): ForwardedKey | null {
  if (!message || typeof message !== "object") return null;
  const { type, key, code, shiftKey, repeat } = message as Record<string, unknown>;
  if (type !== "key" || typeof key !== "string") return null;
  if (!NAMED_KEYS.has(key) && (key.length !== 1 || key === " ")) return null;
  return { key, code: typeof code === "string" ? code.slice(0, 20) : "", shiftKey: shiftKey === true, repeat: repeat === true };
}

export function acceptFrameMessage(data: unknown, token: string | null): Record<string, unknown> | null {
  if (!data || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;
  return token !== null && typeof message.token === "string" && message.token.length > 0 && message.token === token ? message : null;
}

const TOKEN_META = /<meta name="orbit-frame" content="([0-9a-f]{32})">/;

export function frameTokenMeta(token: string) {
  return `<meta name="orbit-frame" content="${token}">`;
}

export function frameToken(srcdoc: string | null | undefined) {
  return srcdoc?.slice(0, 600).match(TOKEN_META)?.[1] ?? null;
}
