import { createHash, randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secret";
import { londonDay } from "@/lib/docs/format";
import { siteOrigin } from "@/lib/site-url";

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,64}$/;

export function isPublicToken(value: string) {
  return TOKEN_SHAPE.test(value);
}

export function newPublicToken() {
  return randomBytes(24).toString("base64url");
}

export function hashPublicToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function sealPublicToken(token: string) {
  return { hash: hashPublicToken(token), sealed: encryptSecret(token) };
}

export function publicPath(token: string) {
  return `/d/${token}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function updatedLabel(value: string | Date) {
  const [year, month, date] = londonDay(value).split("-").map(Number);
  return `Updated ${date} ${MONTHS[month - 1]} ${year}`;
}

export function publicUrlOf(row: { public_enabled: boolean; public_token_enc: string | null; public_slug: string | null }) {
  if (!row.public_enabled || !row.public_token_enc) return null;
  try {
    return `${siteOrigin() ?? ""}${publicPath(row.public_slug ?? decryptSecret(row.public_token_enc))}`;
  } catch {
    return null;
  }
}
