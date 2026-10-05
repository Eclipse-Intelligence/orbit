import { createHmac, timingSafeEqual } from "node:crypto";
import { appSecret } from "@/lib/auth/config";

export const MICROSOFT_SCOPES = "offline_access Mail.Read User.Read";

const STATE_MAX_AGE_MS = 10 * 60 * 1000;

export function microsoftConfigured() {
  return Boolean(process.env.MICROSOFT_CLIENT_ID?.trim() && process.env.MICROSOFT_CLIENT_SECRET?.trim());
}

function microsoftCredentials() {
  const id = process.env.MICROSOFT_CLIENT_ID?.trim();
  const secret = process.env.MICROSOFT_CLIENT_SECRET?.trim();
  if (!id || !secret) throw new Error("Add the Microsoft app credentials before connecting.");
  return { id, secret };
}

export function microsoftTenant() {
  return process.env.MICROSOFT_TENANT?.trim() || "common";
}

export function originFrom(request: Request) {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) return new URL(request.url).origin;
  const proto = request.headers.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}

export function microsoftRedirectUri(origin: string) {
  const configured = process.env.MICROSOFT_REDIRECT_URI?.trim();
  if (configured) return configured;
  return `${origin.replace(/\/$/, "")}/api/microsoft/callback`;
}

export function signMicrosoftState(userId: string, workspaceId: string, now = Date.now()) {
  const body = Buffer.from(
    JSON.stringify({ userId, workspaceId, exp: now + STATE_MAX_AGE_MS }),
  ).toString("base64url");
  const signature = createHmac("sha256", appSecret()).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function readMicrosoftState(state: string | undefined, now = Date.now()) {
  if (!state) return null;
  const separator = state.lastIndexOf(".");
  if (separator <= 0) return null;
  const body = state.slice(0, separator);
  const signature = state.slice(separator + 1);
  const expected = createHmac("sha256", appSecret()).update(body).digest("base64url");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      userId?: string;
      workspaceId?: string;
      exp?: number;
    };
    if (!parsed.userId || !parsed.workspaceId || typeof parsed.exp !== "number") return null;
    if (parsed.exp < now) return null;
    return { userId: parsed.userId, workspaceId: parsed.workspaceId };
  } catch {
    return null;
  }
}

export function microsoftAuthorizationUrl(origin: string, state: string) {
  const url = new URL(
    `https://login.microsoftonline.com/${microsoftTenant()}/oauth2/v2.0/authorize`,
  );
  url.searchParams.set("client_id", process.env.MICROSOFT_CLIENT_ID!.trim());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", microsoftRedirectUri(origin));
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", MICROSOFT_SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  return url;
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

export type MicrosoftToken = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
};

async function tokenRequest(body: URLSearchParams, fetchImpl: typeof fetch) {
  const response = await fetchImpl(
    `https://login.microsoftonline.com/${microsoftTenant()}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15000),
    },
  );
  const parsed = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || !parsed.access_token) {
    const reason = parsed.error_description || parsed.error || "Microsoft did not return a token.";
    throw new Error(sanitizeMicrosoftError(reason));
  }
  return parsed;
}

export async function exchangeAuthorizationCode(
  origin: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
) {
  const credentials = microsoftCredentials();
  const body = new URLSearchParams({
    client_id: credentials.id,
    client_secret: credentials.secret,
    grant_type: "authorization_code",
    code,
    redirect_uri: microsoftRedirectUri(origin),
    scope: MICROSOFT_SCOPES,
  });
  const parsed = await tokenRequest(body, fetchImpl);
  if (!parsed.refresh_token) throw new Error("Microsoft did not return a refresh token.");
  return tokenFrom(parsed.refresh_token, parsed);
}

export async function refreshMicrosoftToken(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
) {
  const credentials = microsoftCredentials();
  const body = new URLSearchParams({
    client_id: credentials.id,
    client_secret: credentials.secret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: MICROSOFT_SCOPES,
  });
  const parsed = await tokenRequest(body, fetchImpl);
  return tokenFrom(parsed.refresh_token || refreshToken, parsed);
}

function tokenFrom(refreshToken: string, parsed: TokenResponse): MicrosoftToken {
  const expiresIn = parsed.expires_in ?? 3600;
  return {
    accessToken: parsed.access_token!,
    refreshToken,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

export async function fetchMicrosoftProfile(accessToken: string, fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl(
    "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName",
    {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15000),
    },
  );
  const body = (await response.json().catch(() => ({}))) as {
    mail?: string | null;
    userPrincipalName?: string | null;
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(sanitizeMicrosoftError(body.error?.message || "Could not read the Microsoft account."));
  }
  return body.mail || body.userPrincipalName || "";
}

type GraphRecipient = { emailAddress?: { address?: string; name?: string } };

export type GraphInboxMessage = {
  id?: string;
  conversationId?: string;
  internetMessageId?: string;
  subject?: string;
  bodyPreview?: string;
  receivedDateTime?: string;
  isDraft?: boolean;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
};

export async function fetchInboxMessages(
  accessToken: string,
  since: Date,
  fetchImpl: typeof fetch = fetch,
) {
  const collected: GraphInboxMessage[] = [];
  let next: string | null = inboxUrl(since, true);
  let pages = 0;
  while (next && collected.length < 100 && pages < 4) {
    pages += 1;
    const response = await graphGet(next, accessToken, fetchImpl);
    if (response.status === 400 && pages === 1 && next.includes("%24orderby")) {
      next = inboxUrl(since, false);
      pages = 0;
      continue;
    }
    if (!response.ok) {
      throw new Error(sanitizeMicrosoftError(await graphError(response)));
    }
    const body = (await response.json()) as {
      value?: GraphInboxMessage[];
      "@odata.nextLink"?: string;
    };
    for (const message of body.value ?? []) {
      if (message.receivedDateTime && new Date(message.receivedDateTime) < since) {
        next = null;
        break;
      }
      collected.push(message);
      if (collected.length >= 100) break;
    }
    next = next ? body["@odata.nextLink"] ?? null : null;
  }
  return collected;
}

function inboxUrl(since: Date, order: boolean) {
  const url = new URL("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages");
  url.searchParams.set("$top", "50");
  url.searchParams.set("$filter", `receivedDateTime ge ${since.toISOString().replace(/\.\d{3}Z$/, "Z")}`);
  url.searchParams.set(
    "$select",
    "id,conversationId,internetMessageId,subject,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,isDraft",
  );
  if (order) url.searchParams.set("$orderby", "receivedDateTime desc");
  return url.toString();
}

async function graphGet(url: string, accessToken: string, fetchImpl: typeof fetch) {
  return fetchImpl(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      prefer: 'IdType="ImmutableId"',
    },
    signal: AbortSignal.timeout(15000),
  });
}

async function graphError(response: Response) {
  const body = (await response.json().catch(() => ({}))) as {
    error?: { message?: string; code?: string };
  };
  if (response.status === 401 || body.error?.code === "InvalidAuthenticationToken") {
    return "Microsoft rejected the mailbox connection. Connect it again.";
  }
  return body.error?.message || "Microsoft could not list the inbox.";
}

export function sanitizeMicrosoftError(message: string) {
  const compact = message.replace(/\s+/g, " ").trim();
  if (/invalid_grant|consent|AADSTS70008|expired/i.test(compact)) {
    return "Microsoft rejected the mailbox connection. Connect it again.";
  }
  return compact.slice(0, 240) || "Could not reach Microsoft.";
}
