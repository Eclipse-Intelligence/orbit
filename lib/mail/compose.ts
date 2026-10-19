import { createActivityInDb } from "@/lib/crm/activities";
import { withActor } from "@/lib/crm/context";
import { discardAttachments, loadAttachments } from "@/lib/crm/email-attachments";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import { canonicalEmail } from "@/lib/crm/normalize";
import type { UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { composeEmailHtml, TRACKING_PATH } from "@/lib/mail/html";
import {
  createMicrosoftDraft,
  deleteMicrosoftDraft,
  GraphMailError,
  sendMicrosoftDraft,
  updateMicrosoftDraft,
  type DraftMode,
} from "@/lib/mail/microsoft";
import { mailSourceToken } from "@/lib/mail/sync";
import { readStatusesOn } from "@/lib/mail/tracking";
import type { MailAddress } from "@/lib/mail/types";
import type { ComposeAccount, MailDraft } from "@/lib/mail/view";
import { attachToDraft } from "@/lib/microsoft/oauth";

export const DRAFT_MODES: DraftMode[] = ["new", "reply", "reply_all", "forward"];
const BODY_MAX = 20_000;
const SUBJECT_MAX = 300;
const RECIPIENT_MAX = 100;

export type DraftInput = {
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
};

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
  };
}

const DRAFT_COLUMNS = `id, source_id, provider_draft_id, mode, reply_to, thread_key, quote_html, to_recipients, cc_recipients,
  bcc_recipients, subject, body, tracking_id, updated_at`;

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

async function signatureFor(db: Db, actor: UserActor, email: string) {
  const result = await db.query<{ body: string }>(
    "select body from crm.email_signatures where workspace_id = $1 and user_id = $2 and sender_email = $3",
    [actor.workspaceId, actor.userId, email.toLowerCase()],
  );
  return result.rows[0]?.body ?? null;
}

function graphProblem(error: unknown): never {
  if (error instanceof CrmError) throw error;
  if (error instanceof GraphMailError) {
    if (error.status === 401 || error.status === 403) {
      throw new CrmError("upstream_error", "Microsoft didn't allow Orbit to write this email. Connect the account again in Capture.", 502);
    }
    throw new CrmError("upstream_error", error.message, 502);
  }
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
  const created = await createMicrosoftDraft(token, target.provider_message_id, target.provider_message_id ? input.mode : "new", fetchImpl).catch(
    graphProblem,
  );
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

async function writeDraft(actor: UserActor, input: DraftInput, options: { origin: string | null; fetchImpl: typeof fetch }) {
  const found = input.id
    ? await withActor(actor, async (db) => {
        const result = await db.query<DraftRow>(`select ${DRAFT_COLUMNS} from crm.mail_drafts where id = $1 and user_id = $2`, [input.id, actor.userId]);
        return result.rows[0] ?? null;
      })
    : null;
  const moved = Boolean(found && input.mode === "new" && input.sourceId && found.source_id !== input.sourceId);
  if (found && moved) await discardMailDraft(actor, found.id, options.fetchImpl);
  const { target, existing, signature } = await withActor(actor, async (db) => {
    const row = moved ? null : found;
    const target =
      row?.reply_to || (!row && input.messageId)
        ? await loadTarget(db, actor, (row?.reply_to ?? input.messageId)!)
        : await loadSourceTarget(db, actor, (row?.source_id ?? input.sourceId)!);
    return { target, existing: row, signature: input.signature ? await signatureFor(db, actor, target.email) : null };
  });
  const token = await mailSourceToken(actor, target.source_id, options.fetchImpl);
  let row = existing ?? (await createDraft(actor, input, target, token, options.origin, options.fetchImpl));
  const html = () =>
    composeEmailHtml({ body: input.body, signature, pixel: pixelUrl(options.origin, row.tracking_id), quote: row.quote_html });
  const subject = input.subject || row.subject || "";
  try {
    await updateMicrosoftDraft(token, row.provider_draft_id, { subject, html: html(), to: input.to, cc: input.cc, bcc: input.bcc }, options.fetchImpl);
  } catch (error) {
    if (!(error instanceof GraphMailError && error.status === 404 && existing)) graphProblem(error);
    await withActor(actor, (db) => db.query("delete from crm.mail_drafts where id = $1", [existing.id]));
    row = await createDraft(actor, input, target, token, options.origin, options.fetchImpl);
    await updateMicrosoftDraft(token, row.provider_draft_id, { subject, html: html(), to: input.to, cc: input.cc, bcc: input.bcc }, options.fetchImpl).catch(
      graphProblem,
    );
  }
  const saved = await withActor(actor, async (db) => {
    const result = await db.query<DraftRow>(
      `update crm.mail_drafts set to_recipients = $2, cc_recipients = $3, bcc_recipients = $4, subject = $5, body = $6, updated_at = now()
       where id = $1 returning ${DRAFT_COLUMNS}`,
      [row.id, JSON.stringify(input.to), JSON.stringify(input.cc), JSON.stringify(input.bcc), subject, input.body],
    );
    return result.rows[0];
  });
  return { row: saved, target, token };
}

export async function saveMailDraft(
  actor: UserActor,
  input: DraftInput,
  options: { origin: string | null; fetchImpl?: typeof fetch },
): Promise<MailDraft> {
  const { row } = await writeDraft(actor, input, { origin: options.origin, fetchImpl: options.fetchImpl ?? fetch });
  return toDraft(row);
}

async function logReply(actor: UserActor, input: DraftInput, subject: string, from: string, attachments: { name: string }[]) {
  const addresses = [...input.to, ...input.cc].map((item) => item.address);
  if (addresses.length === 0) return;
  await withActor(actor, async (db) => {
    const contacts = await db.query<{ id: string; company_id: string | null; normalized_email: string }>(
      `select id, company_id, normalized_email from crm.contacts
       where workspace_id = $1 and archived_at is null and normalized_email = any($2::text[])
       limit 10`,
      [actor.workspaceId, addresses],
    );
    for (const contact of contacts.rows) {
      await createActivityInDb(
        db,
        actor,
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
            ...(attachments.length ? { attachments } : {}),
          },
        },
        { operation: "send_email", source: "microsoft" },
      );
    }
  });
}

export async function sendMailDraft(
  actor: UserActor,
  input: DraftInput & { attachments?: string[] },
  options: { origin: string | null; fetchImpl?: typeof fetch },
): Promise<{ warning: string | null }> {
  if (input.to.length + input.cc.length + input.bcc.length === 0) {
    throw new CrmError("invalid_input", "Add at least one person to send to.", 400, { field: "To" });
  }
  if (!input.body.trim() && input.mode !== "forward") throw new CrmError("invalid_input", "Write a message first.", 400, { field: "body" });
  if (input.mode === "new" && !input.subject) throw new CrmError("invalid_input", "Add a subject.", 400, { field: "subject" });
  const fetchImpl = options.fetchImpl ?? fetch;
  const attached = await loadAttachments(actor, input.attachments ?? [], fetchImpl);
  const { row, target, token } = await writeDraft(actor, input, { origin: options.origin, fetchImpl });
  const draftUrl = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(row.provider_draft_id)}`;
  try {
    if (attached.files.length) await attachToDraft(token, draftUrl, attached.files, fetchImpl);
    await sendMicrosoftDraft(token, row.provider_draft_id, fetchImpl);
  } catch (error) {
    graphProblem(error);
  }
  await withActor(actor, async (db) => {
    if (row.tracking_id) {
      await db.query("update crm.mail_tracking set sent_at = now(), recipients = $2, subject = $3 where id = $1", [
        row.tracking_id,
        JSON.stringify([...input.to, ...input.cc, ...input.bcc]),
        row.subject,
      ]);
    }
    await db.query("delete from crm.mail_drafts where id = $1", [row.id]);
  });
  if (attached.summary.length) await discardAttachments(actor, input.attachments ?? [], fetchImpl).catch(() => undefined);
  try {
    await logReply(actor, input, row.subject ?? "", target.email, attached.summary);
  } catch {
    return { warning: "Sent, but Orbit couldn't add it to the contact's timeline." };
  }
  return { warning: null };
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
    drafts: result.rows.map(toDraft),
    providerIds: result.rows.map((row) => row.provider_draft_id),
  };
}

export async function composeAccounts(actor: UserActor): Promise<ComposeAccount[]> {
  return withActor(actor, async (db) => {
    const result = await db.query<{ id: string; email: string; signature: string | null }>(
      `select s.id, s.email, sig.body as signature
       from crm.mail_sources s
       left join crm.email_signatures sig on sig.workspace_id = s.workspace_id and sig.user_id = s.user_id and sig.sender_email = lower(s.email)
       where s.user_id = $1 and s.workspace_id = $2
       order by s.connection_id is null, s.created_at`,
      [actor.userId, actor.workspaceId],
    );
    return result.rows;
  });
}
