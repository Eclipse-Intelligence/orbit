export type AiProvider = "chatgpt";

export const AI_PROVIDERS: AiProvider[] = ["chatgpt"];

export const PROVIDER_NAMES: Record<AiProvider, string> = { chatgpt: "ChatGPT" };

export type Tokens = {
  access: string;
  refresh: string;
  expiresAt: Date;
  accountId: string | null;
  label: string | null;
};

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthError";
  }
}

const TIMEOUT_MS = 15_000;
const DEVICE_WINDOW_MS = 15 * 60 * 1000;

const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_ISSUER = "https://auth.openai.com";
const OPENAI_TOKEN_URL = `${OPENAI_ISSUER}/oauth/token`;
const OPENAI_DEVICE_CODE_URL = `${OPENAI_ISSUER}/api/accounts/deviceauth/usercode`;
const OPENAI_DEVICE_TOKEN_URL = `${OPENAI_ISSUER}/api/accounts/deviceauth/token`;
export const OPENAI_DEVICE_PAGE = `${OPENAI_ISSUER}/codex/device`;
const OPENAI_DEVICE_REDIRECT = `${OPENAI_ISSUER}/deviceauth/callback`;
const OPENAI_CLAIMS = "https://api.openai.com/auth";

export const ORIGINATOR = "orbit";

export type DevicePending = { kind: "device"; deviceAuthId: string; userCode: string; intervalMs: number; deadlineAt: number };
export type Pending = DevicePending;

function signal() {
  return AbortSignal.timeout(TIMEOUT_MS);
}

async function reason(response: Response) {
  try {
    const body = (await response.json()) as Record<string, unknown>;
    const error = body.error as { message?: unknown } | string | undefined;
    const text =
      typeof body.error_description === "string"
        ? body.error_description
        : typeof error === "string"
          ? error
          : typeof error?.message === "string"
            ? error.message
            : typeof body.detail === "string"
              ? body.detail
              : "";
    return text.replace(/\s+/g, " ").trim().slice(0, 200);
  } catch {
    return "";
  }
}

async function post(fetchImpl: typeof fetch, url: string, init: { json?: unknown; form?: Record<string, string> }) {
  try {
    return await fetchImpl(url, {
      method: "POST",
      headers: init.form ? { "content-type": "application/x-www-form-urlencoded" } : { "content-type": "application/json" },
      body: init.form ? new URLSearchParams(init.form).toString() : JSON.stringify(init.json),
      signal: signal(),
    });
  } catch {
    throw new OAuthError("Couldn't reach the sign-in service. Try again.");
  }
}

function decodeJwt(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function openAiClaim(payload: Record<string, unknown> | null, key: string) {
  if (!payload) return null;
  const nested = payload[OPENAI_CLAIMS] as Record<string, unknown> | undefined;
  const value = payload[key] ?? nested?.[key];
  return typeof value === "string" && value ? value : null;
}

type TokenJson = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
};

function expiry(seconds: number | undefined) {
  return new Date(Date.now() + (typeof seconds === "number" && seconds > 0 ? seconds : 3600) * 1000);
}

function openAiTokens(json: TokenJson, previous?: { refresh: string; accountId: string | null; label: string | null }): Tokens {
  if (!json.access_token) throw new OAuthError("ChatGPT didn't return a sign-in token.");
  const id = decodeJwt(json.id_token);
  const access = decodeJwt(json.access_token);
  const accountId = openAiClaim(id, "chatgpt_account_id") ?? openAiClaim(access, "chatgpt_account_id") ?? previous?.accountId ?? null;
  if (!accountId) throw new OAuthError("That ChatGPT sign-in has no ChatGPT account attached.");
  return {
    access: json.access_token,
    refresh: json.refresh_token ?? previous?.refresh ?? "",
    expiresAt: expiry(json.expires_in),
    accountId,
    label: openAiClaim(id, "email") ?? openAiClaim(access, "email") ?? previous?.label ?? null,
  };
}

export async function startDeviceLogin(fetchImpl: typeof fetch = fetch): Promise<DevicePending> {
  const response = await post(fetchImpl, OPENAI_DEVICE_CODE_URL, { json: { client_id: OPENAI_CLIENT_ID, originator: ORIGINATOR } });
  if (!response.ok) {
    const detail = await reason(response);
    throw new OAuthError(`ChatGPT sign-in couldn't start (${response.status}${detail ? `: ${detail}` : ""}).`);
  }
  const body = (await response.json()) as { device_auth_id?: string; user_code?: string; usercode?: string; interval?: string | number };
  const userCode = body.user_code ?? body.usercode;
  if (!body.device_auth_id || !userCode) throw new OAuthError("ChatGPT sign-in returned an incomplete code.");
  const interval = typeof body.interval === "number" ? body.interval : Number.parseInt(body.interval ?? "", 10) || 5;
  return {
    kind: "device",
    deviceAuthId: body.device_auth_id,
    userCode,
    intervalMs: Math.max(interval, 2) * 1000,
    deadlineAt: Date.now() + DEVICE_WINDOW_MS,
  };
}

export type DevicePoll = { status: "pending" } | { status: "complete"; tokens: Tokens } | { status: "failed"; error: string };

export async function pollDeviceLogin(pending: DevicePending, fetchImpl: typeof fetch = fetch): Promise<DevicePoll> {
  if (Date.now() >= pending.deadlineAt) return { status: "failed", error: "The code expired. Start again." };
  const response = await post(fetchImpl, OPENAI_DEVICE_TOKEN_URL, {
    json: { device_auth_id: pending.deviceAuthId, user_code: pending.userCode },
  });
  if (response.status === 403 || response.status === 404) return { status: "pending" };
  if (!response.ok) {
    const detail = await reason(response);
    return { status: "failed", error: `ChatGPT sign-in failed (${response.status}${detail ? `: ${detail}` : ""}).` };
  }
  const body = (await response.json()) as { authorization_code?: string; code_verifier?: string };
  if (!body.authorization_code || !body.code_verifier) return { status: "failed", error: "ChatGPT sign-in returned an incomplete answer." };
  const exchange = await post(fetchImpl, OPENAI_TOKEN_URL, {
    form: {
      grant_type: "authorization_code",
      client_id: OPENAI_CLIENT_ID,
      code: body.authorization_code,
      code_verifier: body.code_verifier,
      redirect_uri: OPENAI_DEVICE_REDIRECT,
    },
  });
  if (!exchange.ok) {
    const detail = await reason(exchange);
    return { status: "failed", error: `ChatGPT sign-in failed (${exchange.status}${detail ? `: ${detail}` : ""}).` };
  }
  try {
    return { status: "complete", tokens: openAiTokens((await exchange.json()) as TokenJson) };
  } catch (error) {
    return { status: "failed", error: error instanceof OAuthError ? error.message : "ChatGPT sign-in failed." };
  }
}

export async function refreshTokens(
  provider: AiProvider,
  current: { refresh: string; accountId: string | null; label: string | null },
  fetchImpl: typeof fetch = fetch,
): Promise<Tokens> {
  if (!current.refresh) throw new OAuthError(`Your ${PROVIDER_NAMES[provider]} sign-in has expired. Reconnect it in Settings.`);
  const response = await post(fetchImpl, OPENAI_TOKEN_URL, {
    form: { grant_type: "refresh_token", refresh_token: current.refresh, client_id: OPENAI_CLIENT_ID },
  });
  if (!response.ok) {
    const detail = await reason(response);
    throw new OAuthError(
      `Your ${PROVIDER_NAMES[provider]} sign-in has expired (${response.status}${detail ? `: ${detail}` : ""}). Reconnect it in Settings.`,
    );
  }
  const json = (await response.json()) as TokenJson;
  return openAiTokens(json, current);
}
