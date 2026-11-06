import { errorResponse } from "@/lib/api/http";
import { CrmError } from "@/lib/crm/errors";
import { allow, authenticateExtension, extensionActor, type ExtensionAuth } from "@/lib/extension/pairing";
import { WORKSPACE_HEADER } from "@/lib/extension/protocol";

const ALLOWED_HEADERS = `authorization, content-type, ${WORKSPACE_HEADER}`;

export function allowedExtensionOrigins(env: Record<string, string | undefined> = process.env) {
  return (env.LINKEDIN_EXTENSION_ID ?? "")
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter((id) => /^[a-p]{32}$/.test(id))
    .map((id) => `chrome-extension://${id}`);
}

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = { "cache-control": "no-store", vary: "Origin" };
  if (origin && allowedExtensionOrigins().includes(origin.toLowerCase())) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-headers"] = ALLOWED_HEADERS;
    headers["access-control-allow-methods"] = "GET, POST, OPTIONS";
    headers["access-control-max-age"] = "600";
  }
  return headers;
}

function assertOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && !allowedExtensionOrigins().includes(origin.toLowerCase())) {
    throw new CrmError("origin_not_allowed", "Only the Orbit extension can use this.", 403);
  }
}

function withHeaders(response: Response, headers: Record<string, string>) {
  for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
  return response;
}

export function extensionOptions(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || !allowedExtensionOrigins().includes(origin.toLowerCase())) {
    return new Response(null, { status: 403, headers: { vary: "Origin" } });
  }
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function extensionJson(request: Request, run: () => Promise<{ body: unknown; status?: number }>) {
  const headers = corsHeaders(request);
  try {
    assertOrigin(request);
    const result = await run();
    return Response.json(result.body, { status: result.status ?? 200, headers });
  } catch (error) {
    return withHeaders(errorResponse(error), headers);
  }
}

export async function requireExtension(request: Request): Promise<ExtensionAuth> {
  const auth = await authenticateExtension(request);
  await allow(`extension:${auth.browserId}`, 300, 60);
  return auth;
}

export async function requireExtensionActor(request: Request, workspaceId?: string | null) {
  const auth = await requireExtension(request);
  const actor = await extensionActor(auth, workspaceId ?? request.headers.get(WORKSPACE_HEADER));
  return { auth, actor };
}

export async function limitPairing(request: Request, kind: "start" | "redeem") {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (kind === "start") await allow(`extension-pair:${ip}`, 10, 600);
  else await allow(`extension-redeem:${ip}`, 120, 60);
}

export async function readBody(request: Request, maxBytes = 64_000) {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) {
    throw new CrmError("invalid_input", "That request is too large.", 413);
  }
  const text = await request.text();
  if (text.length > maxBytes) throw new CrmError("invalid_input", "That request is too large.", 413);
  let body: unknown = {};
  try {
    if (text) body = JSON.parse(text);
  } catch {
    throw new CrmError("invalid_input", "Request body must be JSON.", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new CrmError("invalid_input", "Request body must be a JSON object.", 400);
  }
  return body as Record<string, unknown>;
}

export function orbitUrl(request: Request) {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (host && /^[a-z0-9.:-]+$/i.test(host)) return `${proto === "http" ? "http" : "https"}://${host}`;
  return url.origin;
}
