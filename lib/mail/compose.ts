import { createHash } from "node:crypto";
import { createEmailActivityOnce } from "@/lib/crm/activities";
import { withActor } from "@/lib/crm/context";
import { attachmentSummary, discardAttachments, loadAttachments } from "@/lib/crm/email-attachments";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import { canonicalEmail } from "@/lib/crm/normalize";
import type { UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { composeEmailHtml, imageMarkers, TRACKING_PATH } from "@/lib/mail/html";
import {
  createMicrosoftDraft,
  deleteMicrosoftDraft,
  exportMicrosoftMime,
  fetchDraftState,
  fetchInternetMessageId,
  findSentCopy,
  GraphMailError,
  reconnectProblem,
  saveMicrosoftSentCopy,
  sendMicrosoftDraft,
  sendOutcomeUnknown,
  updateMicrosoftDraft,
  type DraftMode,
  type DraftState,
} from "@/lib/mail/microsoft";
import { threadFiledWorkspaces } from "@/lib/mail/filing";
import { notePreparedSent } from "@/lib/mail/prepare";
import { addressHomesInDb } from "@/lib/mail/routing";
import { mailSourceToken } from "@/lib/mail/sync";
import { readStatusesOn } from "@/lib/mail/tracking";
import type { MailAddress } from "@/lib/mail/types";
import { replyDefaults, type ComposeAccount, type MailDraft } from "@/lib/mail/view";
import {
  defaultSentSaver,
  defaultSmtpSender,
  identityForSend,
  noteIdentityError,
  rewriteMime,
  type SentSaver,
  type SmtpSender,
} from "@/lib/mail/identities";
import { attachToDraft } from "@/lib/microsoft/oauth";
import { followUpDueAt, readFollowUpBody, readFollowUpDays } from "@/lib/mail/follow-up-rules";

export const DRAFT_MODES: DraftMode[] = ["new", "reply", "reply_all", "forward"];
const BODY_MAX = 20_000;
const SUBJECT_MAX = 300;
const RECIPIENT_MAX = 100;

type DraftInput = {
  id?: string | null;
  mode: DraftMode;
  messageId: string | null;
  sourceId: string | null;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  body: string;
  signature: boolean;
  remindHours: number | null;
  followUpDays?: number | null;
  followUpBody?: string | null;
  replaces?: string | null;
  identityId?: string | null;
  sendKey?: string | null;
};

const SCHEDULE_MIN_MS = 30_000;
const SCHEDULE_MAX_MS = 366 * 24 * 60 * 60 * 1000;

type DraftRow = {
  id: string;
  source_id: string;
  provider_draft_id: string;
  mode: DraftMode;
  reply_to: string | null;
  thread_key: string | null;
  quote_html: string | null;
  to_recipients: MailAddress[];
  cc_recipients: MailAddress[];
  bcc_recipients: MailAddress[];
  subject: string | null;
  body: string;
  tracking_id: string | null;
  updated_at: Date | string;
  send_at: Date | string | null;
  send_error: string | null;
  content_hash: string | null;
  identity_id: string | null;
  attachments: string[];
  remind_hours: number | null;
  follow_up_days: number | null;
  follow_up_body: string | null;
  send_attempted_at: Date | string | null;
  sent_internet_id: string | null;
};

type Target = { id: string | null; source_id: string; provider_message_id: string | null; thread_key: string | null; email: string };

function cleanList(list: unknown, label: string): MailAddress[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: MailAddress[] = [];
  for (const item of list) {
    const raw = typeof item === "string" ? item : (item as { address?: unknown })?.address;
    const address = typeof raw === "string" ? canonicalEmail(raw) : null;
    if (!address) throw new CrmError("invalid_input", `${String(raw ?? "").slice(0, 80) || "That"} isn't an email address.`, 400, { field: label });
    if (seen.has(address)) continue;
    seen.add(address);
    const name = typeof item === "object" && item && typeof (item as { name?: unknown }).name === "string" ? (item as { name: string }).name.trim().slice(0, 200) : null;
    out.push({ address, name: name || null });
  }
  if (out.length > RECIPIENT_MAX) throw new CrmError("invalid_input", `Send to at most ${RECIPIENT_MAX} people in ${label}.`, 400, { field: label });
  return out;
}

export function readDraftInput(value: unknown): DraftInput {
  const input = (value ?? {}) as Record<string, unknown>;
  const mode = DRAFT_MODES.find((item) => item === input.mode);
  if (!mode) throw new CrmError("invalid_input", "Choose reply, reply all or forward.", 400);
  const messageId = typeof input.messageId === "string" && isUuid(input.messageId) ? input.messageId : null;
  const sourceId = typeof input.sourceId === "string" && isUuid(input.sourceId) ? input.sourceId : null;
  if (mode === "new" ? !sourceId : !messageId) {
    throw new CrmError("not_found", mode === "new" ? "Choose an account to send from." : "Email not found.", mode === "new" ? 400 : 404);
  }
  const body = typeof input.body === "string" ? input.body.replace(/\r\n/g, "\n") : "";
  if (body.length > BODY_MAX) throw new CrmError("invalid_input", "Keep the message under 20,000 characters.", 400, { field: "body" });
  const subject = typeof input.subject === "string" ? input.subject.replace(/\s+/g, " ").trim() : "";
  if (subject.length > SUBJECT_MAX) throw new CrmError("invalid_input", "Keep the subject under 300 characters.", 400, { field: "subject" });
  return {
    id: typeof input.id === "string" && isUuid(input.id) ? input.id : null,
    mode,
    messageId: mode === "new" ? null : messageId,
    sourceId,
    to: cleanList(input.to, "To"),
    cc: cleanList(input.cc, "Cc"),
    bcc: cleanList(input.bcc, "Bcc"),
    subject,
    body,
    signature: input.signature !== false,
    replaces: typeof input.replaces === "string" && isUuid(input.replaces) ? input.replaces : null,
    identityId: typeof input.identityId === "string" && isUuid(input.identityId) ? input.identityId : null,
    sendKey: typeof input.sendKey === "string" && isUuid(input.sendKey) ? input.sendKey : null,
    remindHours:
      typeof input.remindHours === "number" && Number.isInteger(input.remindHours) && input.remindHours >= 1 && input.remindHours <= 2160
        ? input.remindHours
        : null,
    followUpDays: input.followUpDays === undefined ? undefined : readFollowUpDays(input.followUpDays),
    followUpBody: input.followUpBody === undefined ? undefined : readFollowUpBody(input.followUpBody),
  };
}

function toDraft(row: DraftRow): MailDraft {
  return {
    id: row.id,
    sourceId: row.source_id,
    mode: row.mode,
    messageId: row.reply_to,
    to: row.to_recipients ?? [],
    cc: row.cc_recipients ?? [],
    bcc: row.bcc_recipients ?? [],
    subject: row.subject ?? "",
    body: row.body,
    savedAt: new Date(row.updated_at).toISOString(),
    sendAt: row.send_at ? new Date(row.send_at).toISOString() : null,
    sendError: row.send_error,
    identityId: row.identity_id,
    remindHours: row.remind_hours ?? null,
    followUpDays: row.follow_up_days ?? null,
    followUpBody: row.follow_up_body ?? null,
  };
}

const DRAFT_COLUMNS = `id, source_id, provider_draft_id, mode, reply_to, thread_key, quote_html, to_recipients, cc_recipients,
  bcc_recipients, subject, body, tracking_id, updated_at, send_at, send_error, content_hash, identity_id, attachments,
  remind_hours, follow_up_days, follow_up_body, send_attempted_at, sent_internet_id`;

async function loadTarget(db: Db, actor: UserActor, messageId: string) {
  const result = await db.query<Target>(
    `select m.id, m.source_id, m.provider_message_id, m.thread_key, s.email
     from crm.mail_messages m join crm.mail_sources s on s.id = m.source_id
     where m.id = $1 and m.user_id = $2`,
    [messageId, actor.userId],
  );
  const target = result.rows[0];
  if (!target) throw new CrmError("not_found", "That email is no longer in Orbit. Open the conversation again.", 404);
  return target;
}

async function loadSourceTarget(db: Db, actor: UserActor, sourceId: string): Promise<Target> {
  const result = await db.query<{ id: string; email: string }>("select id, email from crm.mail_sources where id = $1 and user_id = $2", [
    sourceId,
    actor.userId,
  ]);
  const source = result.rows[0];
  if (!source) throw new CrmError("not_found", "That account isn't connected any more. Choose another one to send from.", 404);
  return { id: null, source_id: source.id, provider_message_id: null, thread_key: null, email: source.email };
}

async function senderEmail(db: Db, actor: UserActor, input: DraftInput, fallback: string) {
  if (!input.identityId) return fallback;
  const found = await db.query<{ email: string }>("select email from crm.send_identities where id = $1 and user_id = $2", [input.identityId, actor.userId]);
  return found.rows[0]?.email ?? fallback;
}

async function signatureFor(db: Db, actor: UserActor, email: string) {
  const result = await db.query<{ body: string }>(
    "select body from crm.email_signatures where user_id = $1 and sender_email = $2 order by updated_at desc limit 1",
    [actor.userId, email.toLowerCase()],
  );
  return result.rows[0]?.body ?? null;
}

function graphProblem(error: unknown, email?: string): never {
  if (error instanceof CrmError) throw error;
  const reconnect = reconnectProblem(error, email);
  if (reconnect) throw new CrmError("upstream_error", reconnect, 502);
  if (error instanceof GraphMailError) throw new CrmError("upstream_error", error.message, 502);
  throw new CrmError("upstream_error", error instanceof Error ? error.message.slice(0, 240) : "Outlook didn't accept the email.", 502);
}

function pixelUrl(origin: string | null, trackingId: string | null) {
  return origin && trackingId ? `${origin}${TRACKING_PATH}${trackingId}` : null;
}

async function createDraft(
  actor: UserActor,
  input: DraftInput,
  target: Target,
  token: string,
  origin: string | null,
  fetchImpl: typeof fetch,
) {
  const created = await createMicrosoftDraft(token, target.provider_message_id, target.provider_message_id ? input.mode : "new", fetchImpl).catch((error) =>
    graphProblem(error, target.email),
  );
  if (input.replaces) await deleteDraftMessage(actor, input.replaces, fetchImpl).catch(() => undefined);
  const tracked = origin ? await readStatusesOn(actor) : false;
  return withActor(actor, async (db) => {
    const tracking = tracked
      ? await db.query<{ id: string }>(
          "insert into crm.mail_tracking (workspace_id, user_id, sender_email) values ($1, $2, $3) returning id",
          [actor.workspaceId, actor.userId, target.email],
        )
      : null;
    const result = await db.query<DraftRow>(
      `insert into crm.mail_drafts (workspace_id, user_id, source_id, provider_draft_id, mode, reply_to, thread_key, quote_html, subject, tracking_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning ${DRAFT_COLUMNS}`,
      [
        actor.workspaceId,
        actor.userId,
        target.source_id,
        created.id,
        input.mode,
        target.id,
        target.thread_key ?? created.threadKey,
        created.html,
        created.subject,
        tracking?.rows[0]?.id ?? null,
      ],
    );
    return result.rows[0];
  });
}

function contentHash(input: DraftInput, signature: string | null, subject: string) {
  return createHash("sha256")
    .update(JSON.stringify([subject, input.body, signature, input.identityId ?? null, ...[input.to, input.cc, input.bcc].map((list) => list.map((item) => [item.address, item.name ?? null]))]))
    .digest("hex")
    .slice(0, 32);
}

async function readDraftContext(actor: UserActor, input: DraftInput, row: DraftRow | null) {
  return withActor(actor, async (db) => {
    const target =
      row?.reply_to || (!row && input.messageId)
        ? await loadTarget(db, actor, (row?.reply_to ?? input.messageId)!)
        : await loadSourceTarget(db, actor, (row?.source_id ?? input.sourceId)!);
    return { target, signature: input.signature ? await signatureFor(db, actor, await senderEmail(db, actor, input, target.email)) : null };
  });
}

function mergeIds(...lists: (string[] | null | undefined)[]) {
  return [...new Set(lists.flatMap((list) => list ?? []))];
}

function sameIds(left: string[], right: string[]) {
  return left.length === right.length && left.every((id) => right.includes(id));
}

async function draftAttachmentIds(actor: UserActor, id: string | null | undefined) {
  if (!id || !isUuid(id)) return [];
  return withActor(actor, async (db) => {
    const result = await db.query<{ attachments: string[] }>("select attachments from crm.mail_drafts where id = $1 and user_id = $2", [id, actor.userId]);
    return result.rows[0]?.attachments ?? [];
  });
}

export type StoredFiles = "replace" | "keep";

async function draftFileList(actor: UserActor, input: { id?: string | null; attachments?: string[] }, storedFiles: StoredFiles) {
  return storedFiles === "replace" ? mergeIds(input.attachments) : mergeIds(input.attachments, await draftAttachmentIds(actor, input.id));
}

async function withFiles(db: Db, rows: DraftRow[]): Promise<MailDraft[]> {
  const ids = mergeIds(...rows.map((row) => row.attachments));
  const files = ids.length
    ? (
        await db.query<{ id: string; name: string; size: number; content_type: string }>(
          "select id, name, size, content_type from crm.email_attachments where id = any($1::uuid[])",
          [ids],
        )
      ).rows
    : [];
  return rows.map((row) => ({
    ...toDraft(row),
    attachments: (row.attachments ?? []).flatMap((id) => {
      const file = files.find((item) => item.id === id);
      return file ? [{ id: file.id, name: file.name, size: file.size, contentType: file.content_type }] : [];
    }),
  }));
}

async function writeDraft(
  actor: UserActor,
  input: DraftInput,
  options: { origin: string | null; fetchImpl: typeof fetch; inline?: Record<string, string>; attachments?: string[] },
) {
  const first = await withActor(actor, async (db) => {
    const found = input.id
      ? (await db.query<DraftRow>(`select ${DRAFT_COLUMNS} from crm.mail_drafts where id = $1 and user_id = $2`, [input.id, actor.userId])).rows[0] ?? null
      : null;
    const moved = Boolean(found && input.mode === "new" && input.sourceId && found.source_id !== input.sourceId);
    if (moved) return { found, moved, target: null, signature: null };
    const target =
      found?.reply_to || (!found && input.messageId)
        ? await loadTarget(db, actor, (found?.reply_to ?? input.messageId)!)
        : await loadSourceTarget(db, actor, (found?.source_id ?? input.sourceId)!);
    return { found, moved, target, signature: input.signature ? await signatureFor(db, actor, await senderEmail(db, actor, input, target.email)) : null };
  });
  if (first.found && first.moved) await discardMailDraft(actor, first.found.id, options.fetchImpl);
  const existing = first.moved ? null : first.found;
  const { target, signature } = first.target ? { target: first.target, signature: first.signature } : await readDraftContext(actor, input, null);
  const token = await mailSourceToken(actor, target.source_id, options.fetchImpl);
  let row = existing ?? (await createDraft(actor, input, target, token, options.origin, options.fetchImpl));
  const html = () =>
    composeEmailHtml({ body: input.body, signature, pixel: pixelUrl(options.origin, row.tracking_id), quote: row.quote_html, inline: options.inline });
  const subject = input.subject || row.subject || "";
  const inlineKey = Object.entries(options.inline ?? {}).map(([name, cid]) => `${name}=${cid}`).join("|");
  const hash = contentHash(input, signature, inlineKey ? `${subject}\u0000${inlineKey}` : subject);
  const files = mergeIds(options.attachments ?? first.found?.attachments);
  if (existing && existing.content_hash === hash && sameIds(existing.attachments ?? [], files)) return { row: existing, target, token };
  try {
    await updateMicrosoftDraft(token, row.provider_draft_id, { subject, html: html(), to: input.to, cc: input.cc, bcc: input.bcc }, options.fetchImpl);
  } catch (error) {
    if (!(error instanceof GraphMailError && error.status === 404 && existing)) graphProblem(error, target.email);
    if (existing.send_attempted_at) throw maybeSent();
    await withActor(actor, (db) => db.query("delete from crm.mail_drafts where id = $1", [existing.id]));
    row = await createDraft(actor, input, target, token, options.origin, options.fetchImpl);
    await updateMicrosoftDraft(token, row.provider_draft_id, { subject, html: html(), to: input.to, cc: input.cc, bcc: input.bcc }, options.fetchImpl).catch((retry) =>
      graphProblem(retry, target.email),
    );
  }
  const saved = await withActor(actor, async (db) => {
    const result = await db.query<DraftRow>(
      `update crm.mail_drafts set to_recipients = $2, cc_recipients = $3, bcc_recipients = $4, subject = $5, body = $6,
         signature = $7, content_hash = $8, identity_id = $9, attachments = $10::uuid[], updated_at = now()
       where id = $1 returning ${DRAFT_COLUMNS}`,
      [row.id, JSON.stringify(input.to), JSON.stringify(input.cc), JSON.stringify(input.bcc), subject, input.body, input.signature, hash, input.identityId ?? null, files],
    );
    return result.rows[0];
  });
  return { row: saved, target, token };
}

export async function saveMailDraft(
  actor: UserActor,
  input: DraftInput & { attachments?: string[] },
  options: { origin: string | null; fetchImpl?: typeof fetch; storedFiles: StoredFiles },
): Promise<MailDraft> {
  const attachments = await draftFileList(actor, input, options.storedFiles);
  const { row } = await writeDraft(actor, input, { origin: options.origin, fetchImpl: options.fetchImpl ?? fetch, attachments });
  if (input.followUpDays === undefined) return toDraft(row);
  return withActor(actor, async (db) => {
    const result = await db.query<DraftRow>(
      `update crm.mail_drafts set remind_hours = $2, follow_up_days = $3, follow_up_body = $4 where id = $1 returning ${DRAFT_COLUMNS}`,
      [row.id, input.followUpDays ? null : input.remindHours, input.followUpDays, input.followUpDays ? (input.followUpBody ?? null) : null],
    );
    return toDraft(result.rows[0] ?? row);
  });
}

type SentReply = { replyTo: string | null; internetMessageId: string | null };

async function replyWorkspaces(actor: UserActor, input: DraftInput, sent: SentReply) {
  if (input.mode === "new" || input.mode === "forward" || !sent.replyTo) return [actor];
  const thread = await withActor(actor, async (db) => {
    const result = await db.query<{ source_id: string; tk: string }>(
      "select source_id, coalesce(thread_key, 'm:' || id::text) as tk from crm.mail_messages where id = $1 and user_id = $2",
      [sent.replyTo, actor.userId],
    );
    return result.rows[0] ?? null;
  });
  return thread ? threadFiledWorkspaces(actor, thread.source_id, thread.tk) : [];
}

async function logReply(actor: UserActor, input: DraftInput, subject: string, from: string, attachments: { name: string }[], sent: SentReply) {
  const addresses = [...input.to, ...input.cc].map((item) => item.address);
  if (addresses.length === 0) return;
  for (const target of await replyWorkspaces(actor, input, sent)) {
    await withActor(target, async (db) => {
      const contacts = await db.query<{ id: string; company_id: string | null; normalized_email: string }>(
        `select id, company_id, normalized_email from crm.contacts
         where workspace_id = $1 and archived_at is null and normalized_email = any($2::text[])
         limit 10`,
        [target.workspaceId, addresses],
      );
      for (const contact of contacts.rows) {
        await createEmailActivityOnce(
          db,
          target,
          {
            type: "email",
            title: subject.slice(0, 200) || "(no subject)",
            body: input.body.trim().slice(0, 8000) || null,
            companyId: contact.company_id,
            contactId: contact.id,
            metadata: {
              source: "microsoft",
              direction: "outbound",
              to: contact.normalized_email,
              from,
              mode: input.mode,
              ...(sent.internetMessageId ? { internetMessageId: sent.internetMessageId } : {}),
              ...(attachments.length ? { attachments } : {}),
            },
          },
          { internetMessageId: sent.internetMessageId },
          { operation: "send_email", source: "microsoft" },
        );
      }
    });
  }
}

function checkSendable(input: DraftInput) {
  if (input.to.length + input.cc.length + input.bcc.length === 0) {
    throw new CrmError("invalid_input", "Add at least one person to send to.", 400, { field: "To" });
  }
  if (!input.body.trim() && input.mode !== "forward") throw new CrmError("invalid_input", "Write a message first.", 400, { field: "body" });
  if (input.mode === "new" && !input.subject) throw new CrmError("invalid_input", "Add a subject.", 400, { field: "subject" });
}

export function readAttachmentIds(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && isUuid(item)).slice(0, 10) : [];
}

async function inlineImages(actor: UserActor, body: string, ids: string[]) {
  const wanted = imageMarkers(body);
  const attachmentIds = ids.filter(isUuid);
  if (wanted.length === 0 || attachmentIds.length === 0) return {};
  const rows = await withActor(actor, async (db) => {
    const result = await db.query<{ name: string; content_type: string }>(
      "select name, content_type from crm.email_attachments where id = any($1::uuid[])",
      [attachmentIds],
    );
    return result.rows;
  });
  const inline: Record<string, string> = {};
  for (const row of rows) {
    if (!row.content_type.startsWith("image/") || !wanted.includes(row.name) || inline[row.name]) continue;
    inline[row.name] = `image${Object.keys(inline).length + 1}@orbit`;
  }
  return inline;
}

async function addSendFollowUp(
  db: Db,
  actor: UserActor,
  input: {
    sourceId: string;
    threadKey: string;
    days: number;
    body: string | null;
    recipients: { to: MailAddress[]; cc: MailAddress[]; bcc: MailAddress[] };
    identityId: string | null;
    subject: string | null;
    originalId: string | null;
  },
) {
  await db.query(
    `update crm.mail_reminders set state = case when action = 'send' then 'cancelled' else 'done' end
     where user_id = $1 and source_id = $2 and thread_key = $3 and kind = 'follow_up' and state = 'waiting' and not deferral`,
    [actor.userId, input.sourceId, input.threadKey],
  );
  await db.query(
    `insert into crm.mail_reminders (workspace_id, user_id, source_id, thread_key, kind, action, due_at, subject, follow_up_body, recipients, identity_id, used_identity, original_internet_id)
     values ($1, $2, $3, $4, 'follow_up', 'send', $5, $6, $7, $8, $9, $10, $11)`,
    [
      actor.workspaceId,
      actor.userId,
      input.sourceId,
      input.threadKey,
      followUpDueAt(Date.now(), input.days).toISOString(),
      input.subject,
      input.body,
      JSON.stringify(input.recipients),
      input.identityId,
      Boolean(input.identityId),
      input.originalId,
    ],
  );
}

function mimeMessageId(raw: string) {
  const split = raw.search(/\r?\n\r?\n/);
  const headers = split === -1 ? raw : raw.slice(0, split);
  return /^message-id:[ \t]*(<[^>\r\n]+>)/im.exec(headers)?.[1]?.slice(0, 1000) ?? null;
}

type SendOptions = {
  origin: string | null;
  fetchImpl?: typeof fetch;
  smtp?: SmtpSender;
  saveSent?: SentSaver;
  onDraftRow?: (id: string) => void | Promise<void>;
  storedFiles: StoredFiles;
  logOnTimeline?: boolean;
  claimed?: boolean;
  force?: boolean;
};

export const ALREADY_SENDING = "This email was already sending, so Orbit didn't send it again. Check Sent in Mail.";
export const DRAFT_GONE = "This draft was already sent or deleted.";
export const MAYBE_SENT = "This email may already have been sent. Check Sent, and if it isn't there, use Send anyway.";
export const SEND_FAILED = "The email didn't send. Try again.";
export const SEND_UNCONFIRMED = "Outlook didn't confirm the email was sent. Check Sent before sending it again.";
export const ALREADY_SENT_WARNING = "Outlook had already sent this email, so Orbit didn't send it again.";
const RESEND_AFTER_MS = 2 * 60_000;

type SendKeyClaim = { state: "new" | "retry"; draftId: string | null } | { state: "sent" } | { state: "busy" };

async function claimSendKey(actor: UserActor, key: string, draftId: string | null): Promise<SendKeyClaim> {
  return withActor(actor, async (db) => {
    await db.query("delete from crm.mail_send_keys where user_id = $1 and created_at < now() - interval '7 days'", [actor.userId]);
    const inserted = await db.query(
      `insert into crm.mail_send_keys (user_id, workspace_id, key, draft_id) values ($1, $2, $3, $4)
       on conflict (user_id, key) do nothing returning key`,
      [actor.userId, actor.workspaceId, key, draftId],
    );
    if (inserted.rowCount) return { state: "new", draftId };
    const found = await db.query<{ draft_id: string | null; sent: boolean; fresh: boolean }>(
      `select draft_id, sent_at is not null as sent, created_at > now() - ${SENDING_FRESH} as fresh
       from crm.mail_send_keys where user_id = $1 and key = $2 for update`,
      [actor.userId, key],
    );
    const row = found.rows[0];
    if (!row) return { state: "busy" };
    if (row.sent) return { state: "sent" };
    if (row.draft_id) return { state: "retry", draftId: row.draft_id };
    if (row.fresh) return { state: "busy" };
    await db.query("update crm.mail_send_keys set draft_id = $3, created_at = now() where user_id = $1 and key = $2", [actor.userId, key, draftId]);
    return { state: "new", draftId };
  });
}

async function holdNewDraft(actor: UserActor, id: string, sendKey: string | null) {
  await withActor(actor, async (db) => {
    await db.query("update crm.mail_drafts set sending_at = now() where id = $1 and user_id = $2", [id, actor.userId]);
    if (sendKey) await db.query("update crm.mail_send_keys set draft_id = $3 where user_id = $1 and key = $2", [actor.userId, sendKey, id]);
  });
}

async function releaseDraft(actor: UserActor, id: string) {
  await withActor(actor, (db) => db.query("update crm.mail_drafts set sending_at = null where id = $1 and user_id = $2", [id, actor.userId]));
}

async function sendKeySent(actor: UserActor, key: string) {
  return withActor(actor, async (db) => {
    const result = await db.query("select 1 from crm.mail_send_keys where user_id = $1 and key = $2 and sent_at is not null", [actor.userId, key]);
    return (result.rowCount ?? 0) > 0;
  });
}

async function dropSendKey(actor: UserActor, key: string) {
  await withActor(actor, (db) => db.query("delete from crm.mail_send_keys where user_id = $1 and key = $2 and sent_at is null", [actor.userId, key]));
}

export async function sendMailDraft(
  actor: UserActor,
  input: DraftInput & { attachments?: string[] },
  options: SendOptions,
): Promise<{ warning: string | null }> {
  checkSendable(input);
  const sendKey = !options.claimed && input.sendKey ? input.sendKey : null;
  const key = sendKey ? await claimSendKey(actor, sendKey, input.id ?? null) : null;
  if (key?.state === "sent") return { warning: null };
  if (key?.state === "busy") throw new CrmError("conflict", ALREADY_SENDING, 409);
  const id = (key && "draftId" in key ? key.draftId : null) ?? input.id ?? null;
  const claim = id && !options.claimed ? await claimScheduledDraft(actor, id) : null;
  if (claim === "gone") {
    if (sendKey && (await sendKeySent(actor, sendKey))) return { warning: null };
    throw new CrmError("conflict", DRAFT_GONE, 409);
  }
  if (claim === "sending") throw new CrmError("conflict", ALREADY_SENDING, 409);
  let current = id;
  try {
    return await deliverDraft(actor, { ...input, id }, {
      ...options,
      onDraftRow: async (row) => {
        const made = row !== current;
        current = row;
        if (made && !options.claimed) await holdNewDraft(actor, row, sendKey);
        await options.onDraftRow?.(row);
      },
    });
  } catch (error) {
    const problem = await sendProblem(actor, error, current);
    if (!options.claimed && current) {
      const settle = claim === "scheduled" ? failDueDraft(actor, current, problem.message) : releaseDraft(actor, current);
      await settle.catch(() => undefined);
    }
    if (sendKey && !current) await dropSendKey(actor, sendKey).catch(() => undefined);
    throw problem;
  }
}

function maybeSent() {
  return new CrmError("conflict", MAYBE_SENT, 409, { maybeSent: true });
}

async function sendProblem(actor: UserActor, error: unknown, draftId: string | null) {
  if (error instanceof CrmError) return draftId ? new CrmError(error.code, error.message, error.status, { ...error.details, draftId }) : error;
  console.error("mail send failed", error);
  const marked = draftId ? Boolean(await attemptedDraft(actor, draftId).catch(() => null)) : false;
  return new CrmError("send_failed", marked ? SEND_UNCONFIRMED : SEND_FAILED, marked ? 502 : 500, draftId ? { draftId } : null);
}

async function attemptedDraft(actor: UserActor, id: string) {
  return withActor(actor, async (db) => {
    const result = await db.query<DraftRow>(`select ${DRAFT_COLUMNS} from crm.mail_drafts where id = $1 and user_id = $2 and send_attempted_at is not null`, [
      id,
      actor.userId,
    ]);
    return result.rows[0] ?? null;
  });
}

async function markAttempt(actor: UserActor, id: string, internetId: string | null) {
  await withActor(actor, (db) =>
    db.query("update crm.mail_drafts set send_attempted_at = now(), sent_internet_id = $2 where id = $1", [id, internetId?.slice(0, 1000) ?? null]),
  );
}

async function clearAttempt(actor: UserActor, id: string) {
  await withActor(actor, (db) => db.query("update crm.mail_drafts set send_attempted_at = null where id = $1", [id]));
}

async function settleEarlierSend(actor: UserActor, row: DraftRow, fetchImpl: typeof fetch): Promise<"sent" | "unsent"> {
  const attempted = new Date(row.send_attempted_at!);
  let found: { state: DraftState; copy: boolean };
  try {
    const token = await mailSourceToken(actor, row.source_id, fetchImpl);
    const [state, copy] = await Promise.all([
      fetchDraftState(token, row.provider_draft_id, fetchImpl),
      findSentCopy(
        token,
        {
          internetMessageId: row.sent_internet_id,
          conversationId: row.thread_key,
          subject: row.subject,
          recipients: [...(row.to_recipients ?? []), ...(row.cc_recipients ?? []), ...(row.bcc_recipients ?? [])].map((item) => item.address),
          since: attempted,
        },
        fetchImpl,
      ),
    ]);
    found = { state, copy };
  } catch {
    throw maybeSent();
  }
  if (found.copy || found.state === "sent") return "sent";
  const unsent = found.state === "draft" && !row.identity_id && Date.now() - attempted.getTime() >= RESEND_AFTER_MS;
  if (!unsent) throw maybeSent();
  await clearAttempt(actor, row.id);
  return "unsent";
}

class SendUnsettled extends Error {
  constructor(readonly kind: "unconfirmed" | "vanished") {
    super(kind === "unconfirmed" ? SEND_UNCONFIRMED : MAYBE_SENT);
  }
}

async function sendOnce(actor: UserActor, rowId: string, internetId: string | null, send: () => Promise<void>) {
  await markAttempt(actor, rowId, internetId);
  try {
    await send();
  } catch (error) {
    if (error instanceof GraphMailError && error.status === 404) throw new SendUnsettled("vanished");
    if (sendOutcomeUnknown(error)) throw new SendUnsettled("unconfirmed");
    await clearAttempt(actor, rowId).catch(() => undefined);
    throw error;
  }
}

function smtpUnsure(error: unknown) {
  const detail = (error ?? {}) as { responseCode?: unknown; code?: unknown; command?: unknown; message?: unknown };
  if (typeof detail.responseCode === "number") return false;
  if (typeof detail.command === "string" && !/data/i.test(detail.command)) return false;
  return /ETIMEDOUT|ESOCKET|ECONNRESET|EPIPE|timed? ?out|socket|reset|closed unexpectedly/i.test(`${String(detail.code ?? "")} ${String(detail.message ?? "")}`);
}

type Finish = {
  row: DraftRow;
  from: string;
  identityId: string | null;
  originalId: string | null;
  ids: string[];
  summary: { name: string }[];
  fetchImpl: typeof fetch;
  logOnTimeline?: boolean;
};

async function finishSend(actor: UserActor, input: DraftInput, finish: Finish): Promise<{ warning: string | null }> {
  const { row, from, originalId, ids, summary, fetchImpl } = finish;
  await withActor(actor, async (db) => {
    if (row.tracking_id) {
      await db.query("update crm.mail_tracking set sent_at = now(), recipients = $2, subject = $3, sender_email = $4 where id = $1", [
        row.tracking_id,
        JSON.stringify([...input.to, ...input.cc, ...input.bcc]),
        row.subject,
        from,
      ]);
    }
    await db.query("delete from crm.mail_drafts where id = $1", [row.id]);
    await db.query("update crm.mail_send_keys set sent_at = now() where user_id = $1 and (draft_id = $2 or key = $3::uuid)", [
      actor.userId,
      row.id,
      input.sendKey ?? null,
    ]);
    if (input.messageId) await notePreparedSent(db, actor, input.messageId, input.body);
    const threadKey = row.thread_key ?? (row.reply_to ? `m:${row.reply_to}` : null);
    if (input.followUpDays && threadKey) {
      await addSendFollowUp(db, actor, {
        sourceId: row.source_id,
        threadKey,
        days: input.followUpDays,
        body: input.followUpBody ?? null,
        recipients: { to: input.to, cc: input.cc, bcc: input.bcc },
        identityId: finish.identityId,
        subject: row.subject,
        originalId,
      });
    } else if (input.remindHours && threadKey) {
      await db.query(
        `insert into crm.mail_reminders (workspace_id, user_id, source_id, thread_key, kind, due_at, subject)
         values ($1, $2, $3, $4, 'follow_up', now() + make_interval(hours => $5), $6)`,
        [actor.workspaceId, actor.userId, row.source_id, threadKey, input.remindHours, row.subject],
      );
    }
  });
  const [, logged] = await Promise.all([
    ids.length ? discardAttachments(actor, ids, fetchImpl).catch(() => undefined) : Promise.resolve(),
    finish.logOnTimeline === false
      ? Promise.resolve(true)
      : logReply(actor, input, row.subject ?? "", from, summary, { replyTo: row.reply_to, internetMessageId: originalId }).then(
          () => true,
          () => false,
        ),
  ]);
  return { warning: logged ? null : "Sent, but Orbit couldn't add it to the contact's timeline." };
}

async function finishEarlierSend(actor: UserActor, input: DraftInput, row: DraftRow, ids: string[], options: SendOptions) {
  const [{ target }, identity, summary] = await Promise.all([
    readDraftContext(actor, { ...input, signature: false }, row),
    row.identity_id ? identityForSend(actor, row.identity_id).catch(() => null) : Promise.resolve(null),
    attachmentSummary(actor, ids).catch(() => []),
  ]);
  const result = await finishSend(actor, input, {
    row,
    from: identity?.email ?? target.email,
    identityId: identity?.id ?? null,
    originalId: row.sent_internet_id,
    ids,
    summary,
    fetchImpl: options.fetchImpl ?? fetch,
    logOnTimeline: options.logOnTimeline,
  });
  return { warning: result.warning ?? ALREADY_SENT_WARNING };
}

async function deliverDraft(actor: UserActor, input: DraftInput & { attachments?: string[] }, options: SendOptions): Promise<{ warning: string | null }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const ids = await draftFileList(actor, input, options.storedFiles);
  const earlier = input.id ? await attemptedDraft(actor, input.id) : null;
  if (earlier && options.force) await clearAttempt(actor, earlier.id);
  else if (earlier && (await settleEarlierSend(actor, earlier, fetchImpl)) === "sent") return finishEarlierSend(actor, input, earlier, ids, options);
  const inline = await inlineImages(actor, input.body, ids);
  const [attached, written, identity] = await Promise.all([
    loadAttachments(actor, ids, fetchImpl),
    writeDraft(actor, input, { origin: options.origin, fetchImpl, inline, attachments: ids }),
    input.identityId ? identityForSend(actor, input.identityId) : Promise.resolve(null),
  ]);
  let { row } = written;
  await options.onDraftRow?.(row.id);
  const { target, token } = written;
  if (identity && identity.sourceId !== row.source_id) {
    throw new CrmError("invalid_input", `${identity.email} sends through a different mailbox. Choose it again in From.`, 400);
  }
  let originalId: string | null = null;
  const deliver = async (draft: DraftRow) => {
    const draftUrl = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(draft.provider_draft_id)}`;
    if (attached.files.length) {
      await attachToDraft(token, draftUrl, attached.files.map((file) => (inline[file.name] ? { ...file, contentId: inline[file.name] } : file)), fetchImpl);
    }
    if (!identity) {
      originalId = await fetchInternetMessageId(token, draft.provider_draft_id, fetchImpl).catch((error) => {
        if (error instanceof GraphMailError && error.status === 404) throw error;
        return null;
      });
      await sendOnce(actor, draft.id, originalId, () => sendMicrosoftDraft(token, draft.provider_draft_id, fetchImpl));
      return;
    }
    const raw = rewriteMime(await exportMicrosoftMime(token, draft.provider_draft_id, fetchImpl), {
      name: identity.displayName,
      address: identity.email,
    });
    originalId = mimeMessageId(raw);
    await markAttempt(actor, draft.id, originalId);
    try {
      await (options.smtp ?? defaultSmtpSender)(identity, { from: identity.email, to: [...input.to, ...input.cc, ...input.bcc].map((item) => item.address), raw });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await noteIdentityError(actor, identity.id, reason).catch(() => undefined);
      if (smtpUnsure(error)) throw new CrmError("upstream_error", `${identity.email} didn't confirm the email was sent. Check Sent before sending it again.`, 502);
      await clearAttempt(actor, draft.id).catch(() => undefined);
      throw new CrmError("upstream_error", `${identity.email} couldn't send: ${reason.slice(0, 200)}`, 502);
    }
    await noteIdentityError(actor, identity.id, null).catch(() => undefined);
    await Promise.all([
      saveMicrosoftSentCopy(token, raw, fetchImpl)
        .then(() => deleteMicrosoftDraft(token, draft.provider_draft_id, fetchImpl))
        .catch((error) => console.error("Sent copy failed", error)),
      (options.saveSent ?? defaultSentSaver)(identity, raw).catch((error) => console.error("Saving to Sent failed", error)),
    ]);
  };
  const unsettled = async (error: SendUnsettled, draft: DraftRow) => {
    if (error.kind === "unconfirmed") throw new CrmError("upstream_error", SEND_UNCONFIRMED, 502);
    const marked = await attemptedDraft(actor, draft.id);
    if (marked && (await settleEarlierSend(actor, marked, fetchImpl)) === "sent") return finishEarlierSend(actor, input, marked, ids, options);
    throw maybeSent();
  };
  try {
    await deliver(row);
  } catch (error) {
    if (error instanceof SendUnsettled) return unsettled(error, row);
    if (!(error instanceof GraphMailError && error.status === 404)) graphProblem(error, target.email);
    await withActor(actor, (db) => db.query("delete from crm.mail_drafts where id = $1", [row.id]));
    row = (await writeDraft(actor, { ...input, id: null }, { origin: options.origin, fetchImpl, inline, attachments: ids })).row;
    await options.onDraftRow?.(row.id);
    try {
      await deliver(row);
    } catch (retry) {
      if (retry instanceof SendUnsettled) return unsettled(retry, row);
      graphProblem(retry, target.email);
    }
  }
  return finishSend(actor, input, {
    row,
    from: identity?.email ?? target.email,
    identityId: identity?.id ?? null,
    originalId,
    ids: attached.summary.length ? ids : [],
    summary: attached.summary,
    fetchImpl,
    logOnTimeline: options.logOnTimeline,
  });
}

function scheduleTime(sendAt: string) {
  const at = new Date(sendAt);
  if (Number.isNaN(at.getTime()) || at.getTime() < Date.now() + SCHEDULE_MIN_MS || at.getTime() > Date.now() + SCHEDULE_MAX_MS) {
    throw new CrmError("invalid_input", "Choose a time at least a minute from now and within a year.", 400, { field: "sendAt" });
  }
  return at;
}

export async function scheduleMailDraft(
  actor: UserActor,
  input: DraftInput & { attachments?: string[]; sendAt: string },
  options: { origin: string | null; fetchImpl?: typeof fetch; storedFiles: StoredFiles },
): Promise<MailDraft> {
  checkSendable(input);
  const at = scheduleTime(input.sendAt);
  const ids = await draftFileList(actor, input, options.storedFiles);
  await attachmentSummary(actor, ids);
  const { row } = await writeDraft(actor, input, { origin: options.origin, fetchImpl: options.fetchImpl ?? fetch, attachments: ids });
  return withActor(actor, async (db) => {
    const result = await db.query<DraftRow>(
      `update crm.mail_drafts set send_at = $2, remind_hours = $3, signature = $4, follow_up_days = $5, follow_up_body = $6, send_error = null
       where id = $1 returning ${DRAFT_COLUMNS}`,
      [
        row.id,
        at.toISOString(),
        input.followUpDays ? null : input.remindHours,
        input.signature,
        input.followUpDays ?? null,
        input.followUpDays ? (input.followUpBody ?? null) : null,
      ],
    );
    return toDraft(result.rows[0]);
  });
}

export async function unscheduleMailDraft(actor: UserActor, id: string): Promise<MailDraft> {
  if (!isUuid(id)) throw new CrmError("not_found", SCHEDULED_GONE, 404);
  const outcome = await withActor(actor, async (db) => {
    const found = await db.query<{ busy: boolean }>(
      `select coalesce(sending_at > now() - ${SENDING_FRESH}, false) as busy from crm.mail_drafts where id = $1 and user_id = $2 for update`,
      [id, actor.userId],
    );
    if (!found.rows[0]) return "gone" as const;
    if (found.rows[0].busy) return "sending" as const;
    const result = await db.query<DraftRow>(
      `update crm.mail_drafts set send_at = null, send_error = null where id = $1 and user_id = $2 returning ${DRAFT_COLUMNS}`,
      [id, actor.userId],
    );
    return toDraft(result.rows[0]);
  });
  if (outcome === "gone") throw new CrmError("not_found", SCHEDULED_GONE, 404);
  if (outcome === "sending") throw new CrmError("conflict", SCHEDULED_NOT_WAITING, 409);
  return outcome;
}

export async function listScheduledDrafts(actor: UserActor): Promise<MailDraft[]> {
  return withActor(actor, async (db) => {
    const result = await db.query<DraftRow>(
      `select ${DRAFT_COLUMNS} from crm.mail_drafts
       where user_id = $1 and (send_at is not null or send_error is not null)
       order by send_at nulls first, updated_at desc
       limit 200`,
      [actor.userId],
    );
    return withFiles(db, result.rows);
  });
}

type DueDraft = DraftRow & { signature: boolean };

const SCHEDULED_GONE = "That scheduled email isn't in Orbit Mail any more. It has probably been sent or discarded, so check Sent in Mail.";
const SCHEDULED_NOT_WAITING =
  "That email isn't waiting to send any more. Either it's sending now (check Sent in Mail) or it was unscheduled and is in Drafts.";

async function scheduledRow(actor: UserActor, id: string) {
  if (!isUuid(id)) return null;
  return withActor(actor, async (db) => {
    const result = await db.query<DueDraft>(`select ${DRAFT_COLUMNS}, signature from crm.mail_drafts where id = $1 and user_id = $2`, [id, actor.userId]);
    return result.rows[0] ?? null;
  });
}

function waiting(row: DraftRow) {
  return Boolean(row.send_at || row.send_error);
}

export async function getScheduledDraft(actor: UserActor, id: string): Promise<MailDraft | null> {
  const row = await scheduledRow(actor, id);
  if (!row || !waiting(row)) return null;
  return withActor(actor, async (db) => (await withFiles(db, [row]))[0]);
}

export async function cancelScheduledDraft(actor: UserActor, id: string): Promise<MailDraft> {
  if (!isUuid(id)) throw new CrmError("not_found", SCHEDULED_GONE, 404);
  const cancelled = await withActor(actor, async (db) => {
    const result = await db.query<DraftRow>(
      `update crm.mail_drafts set send_at = null, send_error = null
       where id = $1 and user_id = $2 and (send_at is not null or send_error is not null)
       returning ${DRAFT_COLUMNS}`,
      [id, actor.userId],
    );
    return result.rows[0] ?? null;
  });
  if (cancelled) return toDraft(cancelled);
  throw (await scheduledRow(actor, id)) ? new CrmError("conflict", SCHEDULED_NOT_WAITING, 409) : new CrmError("not_found", SCHEDULED_GONE, 404);
}

export type ScheduledChanges = { sendAt?: string; subject?: string; body?: string; to?: string[]; cc?: string[]; bcc?: string[] };

export async function changeScheduledDraft(
  actor: UserActor,
  id: string,
  changes: ScheduledChanges,
  options: { origin: string | null; fetchImpl?: typeof fetch },
): Promise<MailDraft> {
  const row = await scheduledRow(actor, id);
  if (!row) throw new CrmError("not_found", SCHEDULED_GONE, 404);
  if (!waiting(row)) throw new CrmError("conflict", SCHEDULED_NOT_WAITING, 409);
  const current = dueDraftInput(row);
  const body = changes.body === undefined ? current.body : changes.body.replace(/\r\n/g, "\n");
  if (body.length > BODY_MAX) throw new CrmError("invalid_input", "Keep the message under 20,000 characters.", 400, { field: "body" });
  const subject = changes.subject === undefined ? current.subject : changes.subject.replace(/\s+/g, " ").trim();
  if (subject.length > SUBJECT_MAX) throw new CrmError("invalid_input", "Keep the subject under 300 characters.", 400, { field: "subject" });
  const input = {
    ...current,
    body,
    subject,
    to: changes.to === undefined ? current.to : cleanList(changes.to, "To"),
    cc: changes.cc === undefined ? current.cc : cleanList(changes.cc, "Cc"),
    bcc: changes.bcc === undefined ? current.bcc : cleanList(changes.bcc, "Bcc"),
  };
  const sendAt = changes.sendAt ?? (row.send_at ? new Date(row.send_at).toISOString() : null);
  if (!sendAt) throw new CrmError("invalid_input", "This one didn't send, so give it a new send time.", 400, { field: "sendAt" });
  scheduleTime(sendAt);
  checkSendable(input);
  const held = await withActor(actor, async (db) => {
    const result = await db.query(
      "update crm.mail_drafts set send_at = null where id = $1 and user_id = $2 and (send_at is not null or send_error is not null) returning id",
      [id, actor.userId],
    );
    return (result.rowCount ?? 0) > 0;
  });
  if (!held) throw new CrmError("conflict", SCHEDULED_NOT_WAITING, 409);
  try {
    const draft = await scheduleMailDraft(actor, { ...input, sendAt }, { origin: options.origin, fetchImpl: options.fetchImpl, storedFiles: "keep" });
    return (await getScheduledDraft(actor, draft.id)) ?? draft;
  } catch (error) {
    await withActor(actor, (db) =>
      db.query("update crm.mail_drafts set send_at = $2, send_error = $3 where id = $1 and send_at is null", [id, row.send_at, row.send_error]),
    ).catch(() => undefined);
    throw error;
  }
}

export async function claimDueDrafts(actor: UserActor, limit = 5): Promise<DueDraft[]> {
  return withActor(actor, async (db) => {
    const result = await db.query<DueDraft>(
      `with picked as materialized (
         select id from crm.mail_drafts
         where user_id = $1 and send_at <= now() and (sending_at is null or sending_at < now() - ${SENDING_FRESH})
         order by send_at, id limit $2 for update skip locked
       )
       update crm.mail_drafts d set send_at = null, sending_at = now()
       from picked where d.id = picked.id
       returning ${DRAFT_COLUMNS.split(",").map((column) => `d.${column.trim()}`).join(", ")}, d.signature`,
      [actor.userId, limit],
    );
    return result.rows;
  });
}

export function dueDraftInput(row: DueDraft): DraftInput & { attachments: string[] } {
  return {
    id: row.id,
    mode: row.mode,
    messageId: row.reply_to,
    sourceId: row.source_id,
    to: row.to_recipients ?? [],
    cc: row.cc_recipients ?? [],
    bcc: row.bcc_recipients ?? [],
    subject: row.subject ?? "",
    body: row.body,
    signature: row.signature,
    remindHours: row.remind_hours,
    followUpDays: row.follow_up_days,
    followUpBody: row.follow_up_body,
    identityId: row.identity_id,
    attachments: row.attachments ?? [],
  };
}

export async function failDueDraft(actor: UserActor, id: string, message: string) {
  await withActor(actor, (db) => db.query("update crm.mail_drafts set send_error = $2, sending_at = null where id = $1", [id, message.slice(0, 500)]));
}

export async function discardMailDraft(actor: UserActor, id: string, fetchImpl: typeof fetch = fetch) {
  if (!isUuid(id)) return;
  const row = await withActor(actor, async (db) => {
    const result = await db.query<DraftRow>(`select ${DRAFT_COLUMNS} from crm.mail_drafts where id = $1 and user_id = $2`, [id, actor.userId]);
    return result.rows[0] ?? null;
  });
  if (!row) return;
  const token = await mailSourceToken(actor, row.source_id, fetchImpl);
  await deleteMicrosoftDraft(token, row.provider_draft_id, fetchImpl).catch(graphProblem);
  await withActor(actor, async (db) => {
    await db.query("delete from crm.mail_drafts where id = $1", [row.id]);
    await db.query("delete from crm.mail_messages where source_id = $1 and provider_message_id = $2", [row.source_id, row.provider_draft_id]);
    if (row.tracking_id) await db.query("delete from crm.mail_tracking where id = $1 and sent_at is null", [row.tracking_id]);
  });
}

export async function threadDrafts(db: Db, actor: UserActor, sourceId: string, threadKey: string) {
  const result = await db.query<DraftRow>(
    `select ${DRAFT_COLUMNS} from crm.mail_drafts
     where user_id = $1 and source_id = $2 and coalesce(thread_key, 'm:' || reply_to::text) = $3
     order by updated_at desc limit 5`,
    [actor.userId, sourceId, threadKey],
  );
  return {
    drafts: await withFiles(db, result.rows),
    providerIds: result.rows.map((row) => row.provider_draft_id),
  };
}

export async function composeAccounts(actor: UserActor): Promise<ComposeAccount[]> {
  return withActor(actor, async (db) => {
    const result = await db.query<{ id: string; email: string; signature: string | null }>(
      `select s.id, s.email, sig.body as signature
       from crm.mail_sources s
       left join lateral (
         select e.body from crm.email_signatures e
         where e.user_id = s.user_id and e.sender_email = lower(s.email)
         order by e.updated_at desc limit 1
       ) sig on true
       where s.user_id = $1
       order by s.connection_id is null, s.created_at`,
      [actor.userId],
    );
    const identities = await db.query<{ id: string; email: string; source_id: string; signature: string | null }>(
      `select i.id, i.email, i.source_id, sig.body as signature
       from crm.send_identities i
       left join lateral (
         select e.body from crm.email_signatures e
         where e.user_id = i.user_id and e.sender_email = lower(i.email)
         order by e.updated_at desc limit 1
       ) sig on true
       where i.user_id = $1
       order by i.created_at`,
      [actor.userId],
    );
    const accounts: ComposeAccount[] = [
      ...result.rows.map((row) => ({ id: row.id, email: row.email, signature: row.signature })),
      ...identities.rows.map((row) => ({ id: `smtp:${row.id}`, email: row.email, signature: row.signature, sourceId: row.source_id, identityId: row.id })),
    ];
    const chosen = await workspaceSender(db, actor, accounts);
    return accounts.map((item) => (item === chosen ? { ...item, default: true } : item));
  });
}

async function workspaceSender(db: Db, actor: UserActor, accounts: ComposeAccount[]) {
  if (accounts.length === 0) return null;
  const homes = new Map((await addressHomesInDb(db, actor)).map((home) => [home.address, home]));
  const homeOf = (item: ComposeAccount) => homes.get(item.email.toLowerCase());
  const chosenHere = (item: ComposeAccount) => homeOf(item)?.workspaceId === actor.workspaceId && homeOf(item)?.defaultWorkspaceId !== actor.workspaceId;
  const here = (item: ComposeAccount) => homeOf(item)?.workspaceId === actor.workspaceId;
  return accounts.find(chosenHere) ?? accounts.find(here) ?? accounts.find((item) => !item.identityId) ?? accounts[0];
}

export async function defaultSender(actor: UserActor) {
  return (await composeAccounts(actor)).find((item) => item.default) ?? null;
}

function receivingIdentity(accounts: ComposeAccount[], sourceId: string, addressed: MailAddress[]) {
  const to = new Set(addressed.map((item) => item.address.toLowerCase()));
  const identity = accounts.find((item) => item.identityId && item.sourceId === sourceId && to.has(item.email.toLowerCase()));
  return identity?.identityId ? { sourceId, identityId: identity.identityId, email: identity.email } : null;
}

export async function plannedSender(actor: UserActor, input: { draftId?: string | null; replyTo?: string | null }) {
  const accounts = await composeAccounts(actor);
  const emailOf = (sourceId: string, identityId: string | null) =>
    (identityId ? accounts.find((item) => item.identityId === identityId) : accounts.find((item) => item.id === sourceId))?.email ?? null;
  if (input.draftId) {
    const stored = await storedDraft(actor, input.draftId);
    if (stored) return emailOf(stored.source_id, stored.identity_id);
  }
  if (input.replyTo && isUuid(input.replyTo)) {
    const original = await withActor(actor, async (db) => {
      const result = await db.query<{ source_id: string; to_recipients: MailAddress[] | null; cc_recipients: MailAddress[] | null }>(
        "select source_id, to_recipients, cc_recipients from crm.mail_messages where id = $1 and user_id = $2",
        [input.replyTo, actor.userId],
      );
      return result.rows[0] ?? null;
    });
    if (!original) return null;
    return receivingIdentity(accounts, original.source_id, [...(original.to_recipients ?? []), ...(original.cc_recipients ?? [])])?.email ?? emailOf(original.source_id, null);
  }
  return accounts.find((item) => item.default)?.email ?? null;
}

export async function deleteDraftMessage(actor: UserActor, messageId: string, fetchImpl: typeof fetch = fetch) {
  if (!isUuid(messageId)) throw new CrmError("not_found", "Draft not found.", 404);
  const row = await withActor(actor, async (db) => {
    const result = await db.query<{ id: string; source_id: string; provider_message_id: string }>(
      `select m.id, m.source_id, m.provider_message_id from crm.mail_messages m
       join crm.mail_folders f on f.id = m.folder_id
       where m.id = $1 and m.user_id = $2 and m.is_draft and f.role = 'drafts'`,
      [messageId, actor.userId],
    );
    return result.rows[0] ?? null;
  });
  if (!row) throw new CrmError("not_found", "That draft has already gone.", 404);
  const token = await mailSourceToken(actor, row.source_id, fetchImpl);
  await deleteMicrosoftDraft(token, row.provider_message_id, fetchImpl).catch(graphProblem);
  await withActor(actor, (db) => db.query("delete from crm.mail_messages where id = $1", [row.id]));
}

export async function resolveSendAccount(actor: UserActor, from: string | null | undefined) {
  const accounts = await composeAccounts(actor);
  const wanted = from?.trim().toLowerCase();
  const account = wanted
    ? accounts.find((item) => item.id === from || item.email.toLowerCase() === wanted)
    : (accounts.find((item) => item.default) ?? accounts.find((item) => !item.identityId));
  if (!account) {
    const choices = accounts.map((item) => item.email).join(", ");
    throw new CrmError("invalid_input", wanted ? `You can't send from ${from}. You can send from: ${choices || "no connected accounts"}.` : "Connect a mailbox in Settings › Email first.", 400, {
      field: "from",
    });
  }
  return { sourceId: account.sourceId ?? account.id, identityId: account.identityId ?? null, email: account.email };
}

type ToolDraftInput = {
  replyTo?: string | null;
  replyAll?: boolean;
  from?: string | null;
  to: string[];
  cc?: string[];
  subject?: string;
  body: string;
  remindHours?: number | null;
  followUp?: { afterDays: number; body?: string | null } | null;
  attachments?: string[];
};

export async function saveDraftForAgent(actor: UserActor, input: ToolDraftInput, options: { origin: string | null; fetchImpl?: typeof fetch }) {
  const replying = Boolean(input.replyTo);
  const chosen = replying && !input.from ? null : await resolveSendAccount(actor, input.from);
  const thread = replying
    ? await withActor(actor, async (db) => {
        if (!isUuid(input.replyTo!)) return null;
        const result = await db.query<{
          source_id: string;
          tk: string;
          subject: string | null;
          from_email: string | null;
          from_name: string | null;
          to_recipients: MailAddress[] | null;
          cc_recipients: MailAddress[] | null;
        }>(
          "select source_id, coalesce(thread_key, 'm:' || id::text) as tk, subject, from_email, from_name, to_recipients, cc_recipients from crm.mail_messages where id = $1 and user_id = $2",
          [input.replyTo, actor.userId],
        );
        return result.rows[0] ?? null;
      })
    : null;
  if (replying && !thread) throw new CrmError("not_found", "That email isn't in Orbit Mail. Search for it again.", 404);
  const accounts = await composeAccounts(actor);
  const account = chosen ?? (thread ? receivingIdentity(accounts, thread.source_id, [...(thread.to_recipients ?? []), ...(thread.cc_recipients ?? [])]) : null);
  if (!replying && !input.subject?.trim()) throw new CrmError("invalid_input", "Add a subject.", 400, { field: "subject" });
  const mode: DraftMode = replying ? (input.replyAll ? "reply_all" : "reply") : "new";
  const defaults = thread
    ? replyDefaults(
        mode,
        { from: thread.from_email ? { address: thread.from_email, name: thread.from_name } : null, to: thread.to_recipients ?? [], cc: thread.cc_recipients ?? [] },
        thread.subject,
        [actor.email, ...accounts.map((item) => item.email)],
      )
    : { to: [] as MailAddress[], cc: [] as MailAddress[], subject: input.subject ?? "" };
  const recipients = mergeRecipients(defaults.to, defaults.cc, [], input.to, input.cc ?? []);
  const ids = readAttachmentIds(input.attachments);
  const attachments = await attachmentSummary(actor, ids);
  const draft = await saveMailDraft(
    actor,
    {
      ...readDraftInput({
      mode,
      messageId: input.replyTo ?? null,
      sourceId: account?.sourceId ?? thread?.source_id ?? null,
      identityId: account?.identityId ?? null,
      to: recipients.to,
      cc: recipients.cc,
      bcc: [],
      subject: input.subject?.trim() || defaults.subject,
      body: input.body,
      }),
      attachments: ids,
    },
    { ...options, storedFiles: "keep" },
  );
  const href = thread ? `/mail?thread=${encodeURIComponent(`${thread.source_id}|${thread.tk}`)}` : "/mail?view=drafts";
  return { draft, href, attachments };
}

function mergeRecipients(to: MailAddress[], cc: MailAddress[], bcc: MailAddress[], moreTo: string[], moreCc: string[]) {
  const taken = new Set<string>();
  const pick = (list: (MailAddress | string)[], label: string) =>
    cleanList(list, label).filter((item) => {
      if (taken.has(item.address)) return false;
      taken.add(item.address);
      return true;
    });
  const nextTo = pick([...to, ...moreTo], "To");
  const nextCc = pick([...cc, ...moreCc], "Cc");
  return { to: nextTo, cc: nextCc, bcc: pick(bcc, "Bcc") };
}

const SENDING_FRESH = "interval '10 minutes'";

async function claimScheduledDraft(actor: UserActor, id: string): Promise<"gone" | "sending" | "scheduled" | "draft"> {
  if (!isUuid(id)) return "gone";
  return withActor(actor, async (db) => {
    const found = await db.query<{ scheduled: boolean; busy: boolean }>(
      `select (send_at is not null or send_error is not null) as scheduled, coalesce(sending_at > now() - ${SENDING_FRESH}, false) as busy
       from crm.mail_drafts where id = $1 and user_id = $2 for update`,
      [id, actor.userId],
    );
    const row = found.rows[0];
    if (!row) return "gone";
    if (row.busy) return "sending";
    await db.query("update crm.mail_drafts set send_at = null, send_error = null, sending_at = now() where id = $1", [id]);
    return row.scheduled ? "scheduled" : "draft";
  });
}

type StoredDraft = {
  id: string;
  source_id: string;
  identity_id: string | null;
  mode: DraftMode;
  reply_to: string | null;
  subject: string | null;
  to_recipients: MailAddress[];
  cc_recipients: MailAddress[];
  bcc_recipients: MailAddress[];
  send_at: Date | string | null;
  send_error: string | null;
  remind_hours: number | null;
  follow_up_days: number | null;
  follow_up_body: string | null;
};

async function storedDraft(actor: UserActor, id: string) {
  if (!isUuid(id)) return null;
  return withActor(actor, async (db) => {
    const result = await db.query<StoredDraft>(
      `select id, source_id, identity_id, mode, reply_to, subject, to_recipients, cc_recipients, bcc_recipients, send_at, send_error,
         remind_hours, follow_up_days, follow_up_body
       from crm.mail_drafts where id = $1 and user_id = $2`,
      [id, actor.userId],
    );
    return result.rows[0] ?? null;
  });
}

export async function sendForAgent(
  actor: UserActor,
  input: ToolDraftInput & { draftId?: string | null; sendAt?: string | null },
  options: { origin: string | null; fetchImpl?: typeof fetch; smtp?: SmtpSender; saveSent?: SentSaver },
) {
  const stored = input.draftId ? await storedDraft(actor, input.draftId) : null;
  if (input.draftId && !stored) throw new CrmError("not_found", "That draft isn't in Orbit Mail any more. Save it again.", 404);
  const replyTo = input.replyTo ?? stored?.reply_to ?? null;
  const replying = Boolean(replyTo);
  const accounts = await composeAccounts(actor);
  let account: { sourceId: string; identityId: string | null } | null = input.from
    ? await resolveSendAccount(actor, input.from)
    : stored
      ? { sourceId: stored.source_id, identityId: stored.identity_id }
      : replying
        ? null
        : await resolveSendAccount(actor, null);
  const original = replying
    ? await withActor(actor, async (db) => {
        if (!isUuid(replyTo!)) return null;
        const result = await db.query<{ source_id: string; tk: string; subject: string | null; from_email: string | null; from_name: string | null; to_recipients: MailAddress[]; cc_recipients: MailAddress[] }>(
          `select source_id, coalesce(thread_key, 'm:' || id::text) as tk, subject, from_email, from_name, to_recipients, cc_recipients
           from crm.mail_messages where id = $1 and user_id = $2`,
          [replyTo, actor.userId],
        );
        return result.rows[0] ?? null;
      })
    : null;
  if (replying && !original) throw new CrmError("not_found", "That email isn't in Orbit Mail. Search for it again.", 404);
  if (original && !account) account = receivingIdentity(accounts, original.source_id, [...(original.to_recipients ?? []), ...(original.cc_recipients ?? [])]);
  const subject = input.subject?.trim() || stored?.subject?.trim() || "";
  if (!replying && !subject) throw new CrmError("invalid_input", "Add a subject.", 400, { field: "subject" });
  const mode: DraftMode = stored?.mode === "forward" && !input.replyTo ? "forward" : replying ? (input.replyAll ? "reply_all" : "reply") : "new";
  const defaults = original
    ? replyDefaults(
        mode,
        { from: original.from_email ? { address: original.from_email, name: original.from_name } : null, to: original.to_recipients ?? [], cc: original.cc_recipients ?? [] },
        original.subject,
        [actor.email, ...accounts.map((item) => item.email)],
      )
    : { to: [], cc: [], subject };
  const kept = stored && (stored.to_recipients ?? []).length + (stored.cc_recipients ?? []).length + (stored.bcc_recipients ?? []).length > 0 ? stored : null;
  const recipients = mergeRecipients(
    kept ? kept.to_recipients ?? [] : defaults.to,
    kept ? kept.cc_recipients ?? [] : defaults.cc,
    kept ? kept.bcc_recipients ?? [] : [],
    input.to,
    input.cc ?? [],
  );
  const followUp =
    input.followUp !== undefined
      ? input.followUp
      : stored?.follow_up_days
        ? { afterDays: stored.follow_up_days, body: stored.follow_up_body }
        : null;
  const remindHours = input.remindHours !== undefined ? input.remindHours : (stored?.remind_hours ?? null);
  const draft = readDraftInput({
    id: input.draftId ?? null,
    mode,
    messageId: replyTo,
    sourceId: account?.sourceId ?? original?.source_id ?? null,
    identityId: account?.identityId ?? null,
    ...recipients,
    subject: subject || defaults.subject,
    body: input.body,
    remindHours: followUp ? null : remindHours,
    followUpDays: followUp ? followUp.afterDays : null,
    followUpBody: followUp?.body ?? null,
  });
  const attachments = readAttachmentIds(input.attachments);
  const summary = {
    to: draft.to.map((item) => item.address),
    cc: draft.cc.map((item) => item.address),
    subject: draft.subject,
  };
  const threadHref = original ? `/mail?thread=${encodeURIComponent(`${original.source_id}|${original.tk}`)}` : null;
  if (input.sendAt) {
    const scheduled = await scheduleMailDraft(actor, { ...draft, attachments, sendAt: input.sendAt }, { ...options, storedFiles: "keep" });
    return { ...summary, followUp, warning: null, scheduled: true, sendAt: scheduled.sendAt, draftId: scheduled.id, href: threadHref ?? "/mail?view=scheduled" };
  }
  const result = await sendMailDraft(actor, { ...draft, attachments }, { ...options, storedFiles: "keep" });
  return { ...summary, followUp, warning: result.warning, scheduled: false, sendAt: null, draftId: null, href: threadHref ?? "/mail?view=sent" };
}

export async function plannedRecipients(
  actor: UserActor,
  input: { draftId?: string | null; replyTo?: string | null; replyAll?: boolean; to: string[]; cc?: string[] },
) {
  const stored = input.draftId ? await storedDraft(actor, input.draftId) : null;
  if (input.draftId && !stored) return null;
  const replyTo = input.replyTo ?? stored?.reply_to ?? null;
  const replying = Boolean(replyTo);
  const kept = stored && (stored.to_recipients ?? []).length + (stored.cc_recipients ?? []).length + (stored.bcc_recipients ?? []).length > 0 ? stored : null;
  let defaults = { to: [] as MailAddress[], cc: [] as MailAddress[] };
  if (!kept && replying) {
    const original = await withActor(actor, async (db) => {
      if (!isUuid(replyTo!)) return null;
      const result = await db.query<{ subject: string | null; from_email: string | null; from_name: string | null; to_recipients: MailAddress[]; cc_recipients: MailAddress[] }>(
        "select subject, from_email, from_name, to_recipients, cc_recipients from crm.mail_messages where id = $1 and user_id = $2",
        [replyTo, actor.userId],
      );
      return result.rows[0] ?? null;
    });
    if (!original) return null;
    const accounts = await composeAccounts(actor);
    const mode: DraftMode = stored?.mode === "forward" && !input.replyTo ? "forward" : input.replyAll ? "reply_all" : "reply";
    defaults = replyDefaults(
      mode,
      { from: original.from_email ? { address: original.from_email, name: original.from_name } : null, to: original.to_recipients ?? [], cc: original.cc_recipients ?? [] },
      original.subject,
      [actor.email, ...accounts.map((item) => item.email)],
    );
  }
  const recipients = mergeRecipients(
    kept ? kept.to_recipients ?? [] : defaults.to,
    kept ? kept.cc_recipients ?? [] : defaults.cc,
    kept ? kept.bcc_recipients ?? [] : [],
    input.to,
    input.cc ?? [],
  );
  return {
    to: recipients.to.map((item) => item.address),
    cc: recipients.cc.map((item) => item.address),
    bcc: recipients.bcc.map((item) => item.address),
  };
}
