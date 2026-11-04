import { mailboxTargets } from "@/lib/agent-mail/mailbox";
import { bareAddress, displayName, judgeMail, quarantinedForInstructionsOnly, type AuthenticationResults } from "@/lib/agent-mail/senders";
import { query } from "@/lib/db/pool";
import { verifySignature } from "@/lib/machinemail";

export const WEBHOOK_MAX_BYTES = 5 * 1024 * 1024;
const TEXT_MAX = 1_000_000;
const ATTACHMENTS_MAX = 50;

export type IncomingAttachment = {
  attachment_id: string;
  filename: string | null;
  content_type: string | null;
  size: number | null;
  disposition: string | null;
  content_id: string | null;
  risk: string | null;
};

export type RawMessage = Record<string, unknown> & {
  message_id?: unknown;
  inbox_id?: unknown;
  thread_id?: unknown;
  from?: unknown;
  to?: unknown;
  cc?: unknown;
  subject?: unknown;
  timestamp?: unknown;
  extracted_text?: unknown;
  direction?: unknown;
  trust_level?: unknown;
  trust?: { level?: unknown; reasons?: unknown; content?: { text?: unknown }; attachments?: unknown; authentication?: { aligned?: unknown } };
  authentication_results?: unknown;
  attachments?: unknown;
};

export type ReceiveResult = {
  status: number;
  body: Record<string, unknown>;
  job?: { mailId: string; userId: string; workspaceId: string };
};

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown, max: number) {
  return typeof value === "string" ? value.slice(0, max) : null;
}

function list(value: unknown) {
  const items = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return items.flatMap((item) => (typeof item === "string" ? [bareAddress(item) ?? item.slice(0, 320)] : [])).slice(0, 100);
}

export function cleanedText(message: RawMessage) {
  const safe = message.trust?.content?.text;
  if (typeof safe === "string" && safe.trim()) return { text: safe.slice(0, TEXT_MAX), cleaned: true };
  return { text: typeof message.extracted_text === "string" ? message.extracted_text.slice(0, TEXT_MAX) : "", cleaned: false };
}

export function attachmentsOf(message: RawMessage): IncomingAttachment[] {
  const risks = new Map<string, string>();
  for (const entry of Array.isArray(message.trust?.attachments) ? message.trust.attachments : []) {
    const item = record(entry);
    if (item && typeof item.attachment_id === "string" && typeof item.risk === "string") risks.set(item.attachment_id, item.risk);
  }
  return (Array.isArray(message.attachments) ? message.attachments : []).slice(0, ATTACHMENTS_MAX).flatMap((entry) => {
    const item = record(entry);
    if (!item || typeof item.attachment_id !== "string" || !item.attachment_id) return [];
    return [
      {
        attachment_id: item.attachment_id.slice(0, 200),
        filename: text(item.filename, 200),
        content_type: text(item.content_type, 200),
        size: typeof item.size === "number" && Number.isFinite(item.size) ? item.size : null,
        disposition: text(item.content_disposition, 40),
        content_id: text(item.content_id, 200),
        risk: risks.get(item.attachment_id) ?? null,
      },
    ];
  });
}

function authenticationOf(value: unknown): AuthenticationResults | null {
  const item = record(value);
  if (!item) return null;
  const out: Record<string, string> = {};
  for (const key of ["spf", "spf_domain", "dkim", "dkim_domain", "dmarc", "dmarc_domain"]) {
    if (typeof item[key] === "string") out[key] = (item[key] as string).slice(0, 255).toLowerCase();
  }
  return out as AuthenticationResults;
}

function receivedAt(value: unknown) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function receiveAgentMail(headers: Headers, raw: string, options: { now?: number } = {}): Promise<ReceiveResult> {
  if (Buffer.byteLength(raw) > WEBHOOK_MAX_BYTES) return { status: 413, body: { error: "Too large." } };
  const signature = headers.get("x-machinemail-signature");
  if (!signature) return { status: 401, body: { error: "Missing signature." } };
  const now = options.now ?? Date.now();
  const target = (await mailboxTargets()).find((candidate) => verifySignature(candidate.secret, signature, raw, now));
  if (!target) return { status: 401, body: { error: "Bad signature." } };
  let envelope: Record<string, unknown> | null;
  try {
    envelope = record(JSON.parse(raw));
  } catch {
    return { status: 400, body: { error: "Not JSON." } };
  }
  if (!envelope) return { status: 400, body: { error: "Not an event." } };
  const headerId = headers.get("x-machinemail-event-id")?.trim() || null;
  const bodyId = typeof envelope.event_id === "string" ? envelope.event_id.trim() : null;
  if (headerId && bodyId && headerId !== bodyId) return { status: 400, body: { error: "Event ids don't match." } };
  const eventId = headerId ?? bodyId;
  if (!eventId || eventId.length > 200) return { status: 400, body: { error: "Missing event id." } };
  const eventType = typeof envelope.event_type === "string" ? envelope.event_type.slice(0, 80) : "";
  if (eventType === "webhook.test") return { status: 200, body: { ok: true, test: true } };
  if (!eventType.startsWith("message.received")) return { status: 200, body: { ok: true, ignored: true } };
  const message = (record(record(envelope.data)?.message) ?? record(envelope.message)) as RawMessage | null;
  if (!message || typeof message.message_id !== "string" || !message.message_id) return { status: 200, body: { ok: true, ignored: true } };
  return storeAgentMessage(target, eventId, eventType, message);
}

export async function storeAgentMessage(
  target: { mailbox_id: string; workspace_id: string; address: string },
  eventId: string,
  eventType: string,
  message: RawMessage,
): Promise<ReceiveResult> {
  if (typeof message.message_id !== "string" || !message.message_id) return { status: 200, body: { ok: true, ignored: true } };
  const inbox = typeof message.inbox_id === "string" ? message.inbox_id.trim().toLowerCase() : "";
  if (inbox !== target.address) return { status: 200, body: { ok: true, ignored: true } };
  const from = bareAddress(message.from);
  const authentication = authenticationOf(message.authentication_results);
  const trustLevel = typeof message.trust?.level === "string" ? message.trust.level : null;
  const trustAligned = typeof message.trust?.authentication?.aligned === "boolean" ? message.trust.authentication.aligned : null;
  const verdict = judgeMail({
    eventType,
    direction: message.direction,
    from,
    inbox: target.address,
    auth: authentication,
    trustAligned,
    trustLevel,
    instructionsOnly: quarantinedForInstructionsOnly(message.trust?.reasons),
  });
  const body = cleanedText(message);
  const row = {
    message_id: message.message_id.slice(0, 200),
    thread_id: text(message.thread_id, 200),
    event_type: eventType,
    from_address: from ?? (typeof message.from === "string" ? message.from.slice(0, 320) : null),
    from_name: displayName(message.from),
    to: list(message.to),
    cc: list(message.cc),
    subject: text(message.subject, 2000),
    received_at: receivedAt(message.timestamp),
    text: body.text,
    text_cleaned: body.cleaned,
    trust_level: trustLevel?.slice(0, 40) ?? null,
    authentication,
    attachments: attachmentsOf(message),
  };
  const stored = await query<{ id: string; user_id: string | null; status: string }>("select * from private.agent_mail_receive($1, $2, $3::jsonb, $4, $5)", [
    target.mailbox_id,
    eventId,
    JSON.stringify(row),
    verdict.actionable && Boolean(from),
    verdict.reason ?? "",
  ]);
  const saved = stored.rows[0];
  if (!saved) return { status: 200, body: { ok: true, duplicate: true } };
  if (saved.status !== "received" || !saved.user_id) return { status: 200, body: { ok: true, stored: true, acted: false } };
  return { status: 200, body: { ok: true, stored: true, acted: true }, job: { mailId: saved.id, userId: saved.user_id, workspaceId: target.workspace_id } };
}
