import { readJson } from "@/lib/api/http";
import { authenticateCompanion } from "@/lib/companion/pairing";
import { CrmError } from "@/lib/crm/errors";
import { query } from "@/lib/db/pool";

async function allow(key: string, limit: number, windowSeconds: number) {
  const result = await query<{ allowed: boolean }>("select private.consume_rate_limit($1, $2, $3) as allowed", [key, limit, windowSeconds]);
  if (!result.rows[0]?.allowed) throw new CrmError("rate_limited", "Too many requests from Orbit Agent. Wait a minute.", 429);
}

export async function requireCompanion(request: Request) {
  const auth = await authenticateCompanion(request);
  await allow(`companion:${auth.companionId}`, 600, 60);
  return auth;
}

export async function limitPairing(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  await allow(`companion-pair:${ip}`, 10, 600);
}

export async function readObject(request: Request, maxBytes: number) {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) {
    throw new CrmError("invalid_input", "That request is too large.", 413);
  }
  const body = await readJson(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new CrmError("invalid_input", "Request body must be a JSON object.", 400);
  }
  return body as Record<string, unknown>;
}

export const NO_STORE = { "cache-control": "no-store" };
