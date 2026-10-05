import { createHash, randomBytes } from "node:crypto";

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function generateAgentToken() {
  const prefix = randomBytes(4).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const token = `crm_${prefix}_${secret}`;
  return { token, prefix: `crm_${prefix}`, hash: hashToken(token) };
}
