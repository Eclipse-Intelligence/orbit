import { createHmac, timingSafeEqual } from "node:crypto";
import { appSecret } from "@/lib/auth/config";

export const MICROSOFT_SCOPES = "offline_access Mail.Read Mail.Send User.Read Calendars.ReadWrite";
export const CALENDAR_ACCOUNT_SCOPES = "openid offline_access User.Read Calendars.Read";
export const ORGANISATION_BLOCKED =
  "This Microsoft account's organisation doesn't allow Orbit yet — in Entra, set Orbit's Supported account types to include other organisations (and personal accounts if needed), or ask that organisation's admin to consent.";
export const SIGN_IN_CANCELLED = "Microsoft sign-in was cancelled. Try again when you're ready.";

export type MicrosoftPurpose = "mailbox" | "calendar_account";

const STATE_MAX_AGE_MS = 10 * 60 * 1000;

export function microsoftConfigured() {
  return Boolean(
    process.env.MICROSOFT_CLIENT_ID?.trim() &&
    process.env.MICROSOFT_CLIENT_SECRET?.trim(),
  );
}

function microsoftCredentials() {
  const id = process.env.MICROSOFT_CLIENT_ID?.trim();
  const secret = process.env.MICROSOFT_CLIENT_SECRET?.trim();
  if (!id || !secret)
    throw new Error("Add the Microsoft app credentials before connecting.");
  return { id, secret };
}

export function microsoftTenant() {
  return process.env.MICROSOFT_TENANT?.trim() || "common";
}

export function originFrom(request: Request) {
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) return new URL(request.url).origin;
  const proto = request.headers.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}

export function microsoftRedirectOrigin() {
  const configured = process.env.MICROSOFT_REDIRECT_URI?.trim();
  if (!configured) return null;
  try {
    return new URL(configured).origin;
  } catch {
    return null;
  }
}

export function microsoftRedirectUri(origin: string) {
  const configured = process.env.MICROSOFT_REDIRECT_URI?.trim();
  if (configured) return configured;
  return `${origin.replace(/\/$/, "")}/api/microsoft/callback`;
}

export function signMicrosoftState(
  userId: string,
  workspaceId: string,
  now = Date.now(),
  purpose: MicrosoftPurpose = "mailbox",
) {
  const body = Buffer.from(
    JSON.stringify({ userId, workspaceId, purpose, exp: now + STATE_MAX_AGE_MS }),
  ).toString("base64url");
  const signature = createHmac("sha256", appSecret())
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
}

export function readMicrosoftState(
  state: string | undefined,
  now = Date.now(),
) {
  if (!state) return null;
  const separator = state.lastIndexOf(".");
  if (separator <= 0) return null;
  const body = state.slice(0, separator);
  const signature = state.slice(separator + 1);
  const expected = createHmac("sha256", appSecret())
    .update(body)
    .digest("base64url");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right))
    return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as {
      userId?: string;
      workspaceId?: string;
      purpose?: string;
      exp?: number;
    };
    if (!parsed.userId || !parsed.workspaceId || typeof parsed.exp !== "number")
      return null;
    if (parsed.exp < now) return null;
    const purpose: MicrosoftPurpose =
      parsed.purpose === "calendar_account" ? "calendar_account" : "mailbox";
    return { userId: parsed.userId, workspaceId: parsed.workspaceId, purpose };
  } catch {
    return null;
  }
}

export function scopesFor(purpose: MicrosoftPurpose) {
  return purpose === "calendar_account" ? CALENDAR_ACCOUNT_SCOPES : MICROSOFT_SCOPES;
}

export function microsoftAuthorizationUrl(
  origin: string,
  state: string,
  options: { purpose?: MicrosoftPurpose; loginHint?: string | null } = {},
) {
  const url = new URL(
    `https://login.microsoftonline.com/${microsoftTenant()}/oauth2/v2.0/authorize`,
  );
  url.searchParams.set("client_id", process.env.MICROSOFT_CLIENT_ID!.trim());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", microsoftRedirectUri(origin));
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", scopesFor(options.purpose ?? "mailbox"));
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  if (options.loginHint) url.searchParams.set("login_hint", options.loginHint);
  return url;
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

export type MicrosoftToken = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scope?: string | null;
  tenantId?: string | null;
};

function grantedScopes(scope: string | null | undefined) {
  if (typeof scope !== "string" || !scope.trim()) return null;
  let decoded = scope;
  try {
    decoded = decodeURIComponent(scope);
  } catch {}
  return decoded.split(/\s+/).map((item) => item.split("/").pop()?.toLowerCase() ?? "");
}

export function grantsCalendar(scope: string | null | undefined) {
  const scopes = grantedScopes(scope);
  if (!scopes) return null;
  return scopes.some((item) => item === "calendars.read" || item === "calendars.readwrite");
}

export function grantsCalendarWrite(scope: string | null | undefined) {
  const scopes = grantedScopes(scope);
  if (!scopes) return null;
  return scopes.includes("calendars.readwrite");
}

export function consentProblem(message: string | null | undefined) {
  const text = message ?? "";
  if (/AADSTS65004|\b(user_)?cancel(led)?\b/i.test(text)) return SIGN_IN_CANCELLED;
  if (
    /AADSTS(50020|700016|65001|90094|50194|90008|500011)\b|consent_required|admin (approval|consent)|need admin|not enabled for consumers|unauthorized_client/i.test(
      text,
    )
  ) {
    return ORGANISATION_BLOCKED;
  }
  return null;
}

export function idTokenTenant(idToken: string | null | undefined) {
  const payload = idToken?.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { tid?: unknown };
    return typeof claims.tid === "string" && /^[0-9a-f-]{36}$/i.test(claims.tid) ? claims.tid.toLowerCase() : null;
  } catch {
    return null;
  }
}

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
    const reason =
      parsed.error_description ||
      parsed.error ||
      "Microsoft did not return a token.";
    throw new MicrosoftTokenError(reason);
  }
  return parsed;
}

export class MicrosoftTokenError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(sanitizeMicrosoftError(detail));
    this.name = "MicrosoftTokenError";
    this.detail = detail;
  }
}

export async function exchangeAuthorizationCode(
  origin: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
  purpose: MicrosoftPurpose = "mailbox",
) {
  const credentials = microsoftCredentials();
  const body = new URLSearchParams({
    client_id: credentials.id,
    client_secret: credentials.secret,
    grant_type: "authorization_code",
    code,
    redirect_uri: microsoftRedirectUri(origin),
    scope: scopesFor(purpose),
  });
  const parsed = await tokenRequest(body, fetchImpl);
  if (!parsed.refresh_token)
    throw new Error("Microsoft did not return a refresh token.");
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
  });
  const parsed = await tokenRequest(body, fetchImpl);
  return tokenFrom(parsed.refresh_token || refreshToken, parsed);
}

function tokenFrom(
  refreshToken: string,
  parsed: TokenResponse,
): MicrosoftToken {
  const expiresIn = parsed.expires_in ?? 3600;
  return {
    accessToken: parsed.access_token!,
    refreshToken,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    scope: parsed.scope ?? null,
    tenantId: idTokenTenant(parsed.id_token),
  };
}

export async function fetchMicrosoftProfile(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
) {
  return (await fetchMicrosoftIdentity(accessToken, fetchImpl)).email;
}

export async function fetchMicrosoftIdentity(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
) {
  const response = await fetchImpl(
    "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName",
    {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15000),
    },
  );
  const body = (await response.json().catch(() => ({}))) as {
    mail?: string | null;
    userPrincipalName?: string | null;
    displayName?: string | null;
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(
      sanitizeMicrosoftError(
        body.error?.message || "Could not read the Microsoft account.",
      ),
    );
  }
  return {
    email: body.mail || body.userPrincipalName || "",
    displayName: body.displayName?.replace(/\s+/g, " ").trim().slice(0, 200) || null,
  };
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

const INBOX_LIMIT = 100;
const INBOX_PAGES = 4;

export type InboxFetch = {
  messages: GraphInboxMessage[];
  complete: boolean;
  ordered: boolean;
};

export async function fetchInboxMessages(
  accessToken: string,
  since: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<InboxFetch> {
  const collected: GraphInboxMessage[] = [];
  let ordered = true;
  let truncated = false;
  let next: string | null = inboxUrl(since, true);
  let pages = 0;
  while (next) {
    if (collected.length >= INBOX_LIMIT || pages >= INBOX_PAGES) {
      truncated = true;
      break;
    }
    pages += 1;
    const response = await graphGet(next, accessToken, fetchImpl);
    if (response.status === 400 && ordered && pages === 1) {
      ordered = false;
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
      if (collected.length >= INBOX_LIMIT) {
        truncated = true;
        break;
      }
      if (
        message.receivedDateTime &&
        new Date(message.receivedDateTime) < since
      ) {
        continue;
      }
      collected.push(message);
    }
    next = truncated ? null : (body["@odata.nextLink"] ?? null);
  }
  return { messages: collected, complete: !truncated, ordered };
}

function inboxUrl(since: Date, order: boolean) {
  const url = new URL(
    "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages",
  );
  url.searchParams.set("$top", "50");
  url.searchParams.set(
    "$filter",
    `receivedDateTime ge ${since.toISOString().replace(/\.\d{3}Z$/, "Z")}`,
  );
  url.searchParams.set(
    "$select",
    "id,conversationId,internetMessageId,subject,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,isDraft",
  );
  if (order) url.searchParams.set("$orderby", "receivedDateTime asc");
  return url.toString();
}

export async function sendGraphMail(
  accessToken: string,
  message: {
    to: string;
    toName?: string | null;
    subject: string;
    body: string;
  },
  fetchImpl: typeof fetch = fetch,
) {
  const response = await fetchImpl(
    "https://graph.microsoft.com/v1.0/me/sendMail",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: {
          subject: message.subject,
          body: { contentType: "Text", content: message.body },
          toRecipients: [
            {
              emailAddress: {
                address: message.to,
                ...(message.toName ? { name: message.toName } : {}),
              },
            },
          ],
        },
        saveToSentItems: true,
      }),
      signal: AbortSignal.timeout(15000),
    },
  );
  if (response.ok) return;
  const detail = await graphError(response);
  if (response.status === 403) {
    throw new Error(
      "Microsoft has not allowed sending yet. Add Mail.Send, then disconnect and connect the mailbox again.",
    );
  }
  throw new Error(sanitizeMicrosoftError(detail));
}

async function graphGet(
  url: string,
  accessToken: string,
  fetchImpl: typeof fetch,
) {
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
  if (
    response.status === 401 ||
    body.error?.code === "InvalidAuthenticationToken"
  ) {
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
