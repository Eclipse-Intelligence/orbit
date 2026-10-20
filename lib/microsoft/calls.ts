import { sanitizeMicrosoftError } from "@/lib/microsoft/oauth";

export const CALL_PERMISSION_MESSAGE =
  "Grant Orbit the CallRecords.Read.All application permission with admin consent in Microsoft Entra.";
const TENANT_MESSAGE =
  "Orbit could not work out the Microsoft tenant. Set MICROSOFT_TENANT to your tenant id.";
const SECRET_MESSAGE =
  "Microsoft rejected the app credentials. Check MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET.";
const MAX_PAGES = 50;
const GENERIC_TENANTS = new Set(["common", "organizations", "consumers"]);

export type PstnCallRow = {
  id?: string;
  callId?: string | null;
  userPrincipalName?: string | null;
  userId?: string | null;
  startDateTime?: string | null;
  endDateTime?: string | null;
  duration?: number | null;
  callType?: string | null;
  callerNumber?: string | null;
  calleeNumber?: string | null;
};

type PstnCallFetch = {
  rows: PstnCallRow[];
  complete: boolean;
};

const appTokens = new Map<string, { token: string; expiresAt: number }>();

export function configuredTenant() {
  const tenant = process.env.MICROSOFT_TENANT?.trim();
  if (!tenant || GENERIC_TENANTS.has(tenant.toLowerCase())) return null;
  return tenant;
}

export function tokenClaims(token: string | null | undefined) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as { tid?: unknown; oid?: unknown };
    return {
      tenantId: typeof parsed.tid === "string" ? parsed.tid : null,
      objectId: typeof parsed.oid === "string" ? parsed.oid : null,
    };
  } catch {
    return null;
  }
}

export function sanitizeCallError(message: string) {
  const compact = message.replace(/\s+/g, " ").trim();
  if (
    /Authorization_RequestDenied|Forbidden|insufficient privileges|AADSTS65001|AADSTS700016|consent/i.test(
      compact,
    )
  ) {
    return CALL_PERMISSION_MESSAGE;
  }
  if (
    /invalid_client|AADSTS7000215|AADSTS7000222|AADSTS700027/i.test(compact)
  ) {
    return SECRET_MESSAGE;
  }
  if (/AADSTS90002|AADSTS900023|AADSTS90072|tenant/i.test(compact)) {
    return TENANT_MESSAGE;
  }
  return sanitizeMicrosoftError(compact);
}

export async function appAccessToken(
  tenantId: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
) {
  const id = process.env.MICROSOFT_CLIENT_ID?.trim();
  const secret = process.env.MICROSOFT_CLIENT_SECRET?.trim();
  if (!id || !secret)
    throw new Error("Add the Microsoft app credentials before syncing calls.");
  const key = `${tenantId}:${id}`;
  const cached = appTokens.get(key);
  if (cached && cached.expiresAt > now + 60_000) return cached.token;
  const response = await fetchImpl(
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: id,
        client_secret: secret,
        grant_type: "client_credentials",
        scope: "https://graph.microsoft.com/.default",
      }),
      signal: AbortSignal.timeout(15000),
    },
  );
  const parsed = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !parsed.access_token) {
    throw new Error(
      sanitizeCallError(
        parsed.error_description ||
          parsed.error ||
          "Microsoft did not return an app token.",
      ),
    );
  }
  appTokens.set(key, {
    token: parsed.access_token,
    expiresAt: now + Math.min(parsed.expires_in ?? 3600, 600) * 1000,
  });
  return parsed.access_token;
}

function graphTime(value: Date) {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function pstnCallsUrl(from: Date, to: Date) {
  return `https://graph.microsoft.com/v1.0/communications/callRecords/getPstnCalls(fromDateTime=${graphTime(from)},toDateTime=${graphTime(to)})`;
}

export async function fetchPstnCalls(
  accessToken: string,
  from: Date,
  to: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<PstnCallFetch> {
  const rows: PstnCallRow[] = [];
  let next: string | null = pstnCallsUrl(from, to);
  let pages = 0;
  while (next) {
    if (pages >= MAX_PAGES) return { rows, complete: false };
    pages += 1;
    const response = await fetchImpl(next, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(await callError(response));
    const body = (await response.json()) as {
      value?: PstnCallRow[];
      "@odata.nextLink"?: string;
    };
    rows.push(...(body.value ?? []));
    next = body["@odata.nextLink"] ?? null;
  }
  return { rows, complete: true };
}

async function callError(response: Response) {
  const body = (await response.json().catch(() => ({}))) as {
    error?: { message?: string; code?: string };
  };
  if (
    response.status === 403 ||
    body.error?.code === "Authorization_RequestDenied"
  ) {
    return withMicrosoftDetail(CALL_PERMISSION_MESSAGE, body.error);
  }
  if (response.status === 401) {
    return "Microsoft rejected the app token for call records. Check the Microsoft app credentials.";
  }
  return sanitizeCallError(
    body.error?.message || "Microsoft could not list Teams calls.",
  );
}

export function withMicrosoftDetail(
  message: string,
  error: { code?: string; message?: string } | undefined,
) {
  const detail = [error?.code, error?.message]
    .filter(Boolean)
    .join(": ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return detail ? `${message} Microsoft said: ${detail}` : message;
}
