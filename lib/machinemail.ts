import { ShownError, notSetUp } from "@/lib/crm/errors";
import { clipReason, logUpstream, unreachable, upstreamMessage } from "@/lib/upstream";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const MACHINE_MAIL_API = "https://api.machinemail.dev/v0";
export const SIGNATURE_TOLERANCE_SECONDS = 300;
export const AGENT_EVENTS = [
  "message.received",
  "message.received.spam",
  "message.received.quarantined",
  "message.received.unauthenticated",
  "message.received.blocked",
];

const ATTACHMENT_LIMIT_BYTES = 30 * 1024 * 1024;

export class MachineMailError extends ShownError {
  readonly status: number;
  readonly detail: string;

  constructor(message: string, status: number, detail = message) {
    super(message);
    this.name = "MachineMailError";
    this.status = status;
    this.detail = detail;
  }
}

export function machineMailKey() {
  return process.env.MACHINE_MAIL_API_KEY?.trim() || null;
}

export function retryableStatus(status: number) {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

export function machineMailConfigured() {
  return Boolean(machineMailKey());
}

function requireKey() {
  const key = machineMailKey();
  if (!key) throw new MachineMailError(notSetUp("MachineMail", "MACHINE_MAIL_API_KEY"), 503);
  return key;
}

function path(value: string) {
  return encodeURIComponent(value);
}

function errorReason(text: string) {
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    return clipReason(typeof body.error === "string" ? body.error : typeof body.error?.message === "string" ? body.error.message : body.message);
  } catch {
    return "";
  }
}

async function readError(response: Response) {
  const text = await response.text().catch(() => "");
  logUpstream("MachineMail", response.status, text);
  const reason = response.status >= 400 && response.status < 500 && ![401, 403, 408, 429].includes(response.status) ? errorReason(text) : "";
  const generic = upstreamMessage("MachineMail", response.status);
  return new MachineMailError(generic, response.status, reason ? `MachineMail returned an error: ${reason}.` : generic);
}

async function call<T>(route: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}, fetchImpl: typeof fetch = fetch): Promise<{ status: number; body: T }> {
  const key = requireKey();
  let response: Response;
  try {
    response = await fetchImpl(`${MACHINE_MAIL_API}${route}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { authorization: `Bearer ${key}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
    });
  } catch (error) {
    logUpstream("MachineMail", null, error);
    throw new MachineMailError(unreachable("MachineMail"), 0);
  }
  if (!response.ok) throw await readError(response);
  const text = await response.text();
  try {
    return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
  } catch {
    logUpstream("MachineMail", response.status, "unreadable reply");
    throw new MachineMailError(unreachable("MachineMail"), 502);
  }
}

export type MachineMailInbox = { inbox_id: string; email?: string; display_name?: string; status?: string };

export function splitAddress(address: string) {
  const at = address.lastIndexOf("@");
  return { username: address.slice(0, at), domain: address.slice(at + 1) };
}

export async function ensureInbox(address: string, displayName: string, fetchImpl: typeof fetch = fetch) {
  const { username, domain } = splitAddress(address);
  try {
    const created = await call<MachineMailInbox>(
      "/inboxes",
      { body: { username, domain, display_name: displayName, client_id: `orbit-agent-${address}`.slice(0, 200) } },
      fetchImpl,
    );
    return { inbox: created.body, created: created.status === 201 };
  } catch (error) {
    if (!(error instanceof MachineMailError) || error.status !== 409) throw error;
  }
  try {
    const found = await call<MachineMailInbox>(`/inboxes/${path(address)}`, {}, fetchImpl);
    return { inbox: found.body, created: false };
  } catch (error) {
    if (error instanceof MachineMailError && error.status === 404) {
      throw new MachineMailError(`${address} is taken. Choose another address.`, 409);
    }
    throw error;
  }
}

export type MachineMailWebhook = { webhook_id: string; url: string; secret?: string; event_types?: string[]; inbox_ids?: string[]; enabled?: boolean };

export function webhookClientId(address: string, url: string) {
  return `orbit-${createHash("sha256").update(`${address}|${url}`).digest("hex").slice(0, 32)}`;
}

export async function ensureWebhook(address: string, url: string, fetchImpl: typeof fetch = fetch) {
  const created = await call<MachineMailWebhook>(
    "/webhooks",
    { body: { url, event_types: AGENT_EVENTS, inbox_ids: [address], client_id: webhookClientId(address, url) } },
    fetchImpl,
  );
  let webhook = created.body;
  const types = new Set(webhook.event_types ?? AGENT_EVENTS);
  const inboxes = webhook.inbox_ids ?? [address];
  if (webhook.url !== url || types.size !== AGENT_EVENTS.length || AGENT_EVENTS.some((type) => !types.has(type)) || !inboxes.includes(address) || webhook.enabled === false) {
    webhook = (
      await call<MachineMailWebhook>(
        `/webhooks/${path(webhook.webhook_id)}`,
        { method: "PATCH", body: { url, event_types: AGENT_EVENTS, add_inbox_ids: [address], enabled: true } },
        fetchImpl,
      )
    ).body;
  }
  if (!webhook.secret) {
    webhook = (await call<MachineMailWebhook>(`/webhooks/${path(webhook.webhook_id)}`, {}, fetchImpl)).body;
  }
  if (!webhook.secret) throw new MachineMailError("MachineMail didn't return the webhook's signing secret.", 502);
  return { id: webhook.webhook_id, secret: webhook.secret };
}

export async function deleteWebhook(id: string, fetchImpl: typeof fetch = fetch) {
  await call(`/webhooks/${path(id)}`, { method: "DELETE" }, fetchImpl);
}

export type OutgoingMail = { to?: string[]; cc?: string[]; subject?: string; text: string; html?: string };
export type SentMail = { message_id: string; thread_id: string; timestamp?: string };

export async function replyToMessage(inbox: string, messageId: string, mail: OutgoingMail, fetchImpl: typeof fetch = fetch) {
  const body = {
    text: mail.text,
    ...(mail.html ? { html: mail.html } : {}),
    ...(mail.to?.length ? { to: mail.to } : {}),
    ...(mail.cc?.length ? { cc: mail.cc } : {}),
    reply_all: false,
  };
  return (await call<SentMail>(`/inboxes/${path(inbox)}/messages/${path(messageId)}/reply`, { body }, fetchImpl)).body;
}

export async function sendNewMessage(inbox: string, mail: OutgoingMail, fetchImpl: typeof fetch = fetch) {
  const body = {
    to: mail.to ?? [],
    ...(mail.cc?.length ? { cc: mail.cc } : {}),
    subject: mail.subject ?? "",
    text: mail.text,
    ...(mail.html ? { html: mail.html } : {}),
  };
  return (await call<SentMail>(`/inboxes/${path(inbox)}/messages/send`, { body }, fetchImpl)).body;
}

export type MachineMailListedMessage = { message_id: string; labels?: string[]; direction?: string; timestamp?: string };

const HIDDEN_KINDS = ["include_spam", "include_quarantine", "include_unauthenticated", "include_blocked"];

export async function listRecentMessages(inbox: string, after: Date, fetchImpl: typeof fetch = fetch) {
  const params = new URLSearchParams({ after: after.toISOString(), limit: "100" });
  for (const kind of HIDDEN_KINDS) params.set(kind, "true");
  const response = await call<{ messages?: MachineMailListedMessage[] }>(`/inboxes/${path(inbox)}/messages?${params.toString()}`, {}, fetchImpl);
  return (response.body.messages ?? []).filter((message) => typeof message?.message_id === "string" && message.message_id);
}

export async function getMessage(inbox: string, messageId: string, fetchImpl: typeof fetch = fetch) {
  return (await call<Record<string, unknown>>(`/inboxes/${path(inbox)}/messages/${path(messageId)}`, {}, fetchImpl)).body;
}

export async function downloadAttachment(inbox: string, messageId: string, attachmentId: string, maxBytes: number, fetchImpl: typeof fetch = fetch) {
  const key = requireKey();
  let response: Response;
  try {
    response = await fetchImpl(`${MACHINE_MAIL_API}/inboxes/${path(inbox)}/messages/${path(messageId)}/attachments/${path(attachmentId)}/download`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    logUpstream("MachineMail", null, error);
    throw new MachineMailError(unreachable("MachineMail"), 0);
  }
  if (!response.ok) throw await readError(response);
  const limit = Math.min(maxBytes, ATTACHMENT_LIMIT_BYTES);
  const tooLarge = () => new MachineMailError("The file is too large.", 413);
  if (Number(response.headers.get("content-length") ?? 0) > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) return { bytes: new Uint8Array(), contentType: response.headers.get("content-type") };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, contentType: response.headers.get("content-type") };
}

export function signatureParts(header: string | null) {
  const parts = new Map<string, string>();
  for (const piece of (header ?? "").split(",")) {
    const index = piece.indexOf("=");
    if (index > 0) parts.set(piece.slice(0, index).trim(), piece.slice(index + 1).trim());
  }
  const timestamp = Number(parts.get("t"));
  const signature = parts.get("v1") ?? "";
  return Number.isInteger(timestamp) && /^[0-9a-f]{64}$/i.test(signature) ? { timestamp, signature: signature.toLowerCase() } : null;
}

export function signPayload(secret: string, timestamp: number, rawBody: string) {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export function verifySignature(secret: string, header: string | null, rawBody: string, nowMs = Date.now()) {
  if (!secret) return false;
  const parts = signatureParts(header);
  if (!parts) return false;
  if (Math.abs(nowMs / 1000 - parts.timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(signPayload(secret, parts.timestamp, rawBody), "hex");
  const given = Buffer.from(parts.signature, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}
