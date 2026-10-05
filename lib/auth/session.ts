import { createHmac, timingSafeEqual } from "node:crypto";
import { appSecret } from "@/lib/auth/config";

type SessionPayload = { sub: string; exp: number };

export function signSession(userId: string, ttlSeconds = 60 * 60 * 24 * 7) {
  const body = Buffer.from(
    JSON.stringify({
      sub: userId,
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    } satisfies SessionPayload),
  ).toString("base64url");
  const signature = createHmac("sha256", appSecret()).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function readSession(token: string | undefined) {
  if (!token) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = createHmac("sha256", appSecret()).update(body).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString(),
    ) as SessionPayload;
    if (!payload.sub || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload.sub;
  } catch {
    return null;
  }
}
