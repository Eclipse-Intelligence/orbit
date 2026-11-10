import type { Db } from "@/lib/db/pool";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secret";
import { withActor } from "@/lib/crm/context";
import { createActivityInDb, createEmailActivityOnce } from "@/lib/crm/activities";
import { discardAttachments, loadAttachments } from "@/lib/crm/email-attachments";
import {
  companyHasOpenTask,
  FREE_MAIL_DOMAINS,
  isFreeMailDomain,
  isRecent,
} from "@/lib/crm/communications";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import { canonicalDomain, canonicalEmail } from "@/lib/crm/normalize";
import { hasScope } from "@/lib/crm/scopes";
import { createTaskInDb } from "@/lib/crm/tasks";
import { scheduleTaskDue, withDueNote } from "@/lib/crm/task-due";
import type { Provenance, UserActor } from "@/lib/crm/types";
import { composeEmailHtml, trackingPixelUrl } from "@/lib/mail/html";
import { appNeedsAttention, reconnectProblem } from "@/lib/mail/microsoft";
import { mailOrigin } from "@/lib/mail/origin";
import { routedAway } from "@/lib/mail/routing";
import { readStatusesOn } from "@/lib/mail/tracking";
import {
  fetchInboxMessages,
  MicrosoftError,
  refreshMicrosoftToken,
  sanitizeMicrosoftError,
  sendGraphMail,
  type GraphInboxMessage,
  type InboxFetch,
  type MicrosoftToken,
} from "@/lib/microsoft/oauth";

const LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const OVERLAP_MS = 10 * 60 * 1000;
const SYNC_GAP_MS = 2 * 60 * 1000;
const RECONNECT_MESSAGE =
  "Orbit could not read the saved Microsoft connection. Disconnect, then connect Microsoft again.";
const UNFILED_WARNING = "Sent, but not added to the contact's timeline.";

export type MailboxSummary = {
  id: string;
  email: string;
  status: "connected" | "disconnected";
  lastSyncedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
};

export type InboxMessage = {
  id: string;
  subject: string | null;
  preview: string | null;
  fromName: string | null;
  fromEmail: string | null;
  receivedAt: string | null;
  contactId: string | null;
  contactName: string | null;
  companyId: string | null;
  companyName: string | null;
};

type InboundEmail = {
  providerMessageId: string;
  conversationId?: string | null;
  internetMessageId?: string | null;
  subject?: string | null;
  preview?: string | null;
  fromEmail?: string | null;
  fromName?: string | null;
  toEmails?: string[];
  ccEmails?: string[];
  receivedAt?: string | null;
  isDraft?: boolean;
};

type SyncCounts = {
  attached: number;
  unattached: number;
  skipped: number;
  followUps: number;
  error?: string;
};

export type StoredConnection = MailboxSummary & {
  workspaceId: string;
  microsoftUserId: string | null;
  refreshTokenCipher: string | null;
  accessTokenCipher: string | null;
  accessTokenExpiresAt: string | null;
};

export type PartyMatch = {
  contactId: string | null;
  contactName: string | null;
  companyId: string | null;
  companyName: string | null;
};

export function counterpartEmails(input: {
  mailboxEmail: string;
  fromEmail?: string | null;
  toEmails?: string[];
  ccEmails?: string[];
}) {
  const mailbox = canonicalEmail(input.mailboxEmail);
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const value of [
    input.fromEmail,
    ...(input.toEmails ?? []),
    ...(input.ccEmails ?? []),
  ]) {
    const email = value ? canonicalEmail(value) : null;
    if (!email || email === mailbox || seen.has(email)) continue;
    seen.add(email);
    emails.push(email);
  }
  return emails;
}

export function shouldSyncMailbox(
  lastAttemptAt: string | null,
  now = Date.now(),
) {
  if (!lastAttemptAt) return true;
  const time = new Date(lastAttemptAt).getTime();
  if (Number.isNaN(time)) return true;
  return now - time >= SYNC_GAP_MS;
}

export async function getMailbox(actor: UserActor) {
  return withActor(actor, async (db) => {
    const row = await readSummary(db, actor);
    return row;
  });
}

export async function listInbox(actor: UserActor) {
  return withActor(actor, async (db) => {
    const result = await db.query<{
      id: string;
      subject: string | null;
      preview: string | null;
      from_name: string | null;
      from_email: string | null;
      received_at: Date | string | null;
      contact_id: string | null;
      contact_name: string | null;
      company_id: string | null;
      company_name: string | null;
    }>(
      `select
         m.id,
         m.subject,
         m.preview,
         m.from_name,
         m.from_email,
         m.received_at,
         m.contact_id,
         coalesce(
           nullif(trim(concat_ws(' ', c.first_name, c.last_name)), ''),
           c.email
         ) as contact_name,
         m.company_id,
         co.name as company_name
       from crm.email_messages m
       join crm.mailbox_connections box on box.id = m.connection_id
       left join crm.contacts c on c.id = m.contact_id
       left join crm.companies co on co.id = m.company_id
       where box.user_id = $1 and m.workspace_id = $2
       order by m.received_at desc nulls last, m.created_at desc
       limit 100`,
      [actor.userId, actor.workspaceId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      subject: row.subject,
      preview: row.preview,
      fromName: row.from_name,
      fromEmail: row.from_email,
      receivedAt: row.received_at
        ? new Date(row.received_at).toISOString()
        : null,
      contactId: row.contact_id,
      contactName: row.contact_name,
      companyId: row.company_id,
      companyName: row.company_name,
    }));
  });
}

export async function saveMailbox(
  actor: UserActor,
  input: {
    email: string;
    refreshToken: string;
    accessToken: string;
    expiresAt: string;
    expected?: string | null;
    microsoftUserId?: string | null;
    tenantId?: string | null;
    aliases?: string[];
  },
) {
  const email = canonicalEmail(input.email);
  if (!email) {
    throw new CrmError(
      "invalid_input",
      "Microsoft did not return an email address.",
      400,
      {
        field: "email",
      },
    );
  }
  await withActor(actor, async (db) => {
    const existing = await readStored(db, actor);
    const signedIn: SignedInAccount = { email, id: input.microsoftUserId ?? null, aliases: input.aliases ?? [] };
    const extra = await isExtraAccount(db, actor, signedIn);
    const expected = existing ?? (input.expected ? { email: input.expected, microsoftUserId: null } : null);
    if (expected && !sameMicrosoftAccount(expected, signedIn)) throw wrongAccount(email, canonicalEmail(expected.email) || expected.email, !extra);
    if (extra && !existing) {
      throw new CrmError(
        "conflict",
        `${email} is already connected as another account. Sign in with the account you want as your main one.`,
        409,
        { signedIn: email },
      );
    }
    if (existing) {
      await db.query(
        `update crm.mailbox_connections set
           email = $2,
           status = 'connected',
           refresh_token = $3,
           access_token = $4,
           access_token_expires_at = $5,
           last_error = null,
           microsoft_user_id = coalesce($6, microsoft_user_id),
           tenant_id = coalesce($7, tenant_id)
         where id = $1`,
        [existing.id, email, encryptSecret(input.refreshToken), encryptSecret(input.accessToken), input.expiresAt, input.microsoftUserId ?? null, input.tenantId ?? null],
      );
      await db.query("update crm.mail_sources set last_error = null where connection_id = $1", [existing.id]);
      return;
    }
    await db.query(
      `insert into crm.mailbox_connections (
         workspace_id, user_id, provider, email, status,
         refresh_token, access_token, access_token_expires_at, last_error, microsoft_user_id, tenant_id
       ) values ($1, $2, 'microsoft', $3, 'connected', $4, $5, $6, null, $7, $8)
       on conflict (workspace_id, user_id, provider) do update set
         email = excluded.email,
         status = 'connected',
         refresh_token = excluded.refresh_token,
         access_token = excluded.access_token,
         access_token_expires_at = excluded.access_token_expires_at,
         last_error = null,
         microsoft_user_id = coalesce(excluded.microsoft_user_id, crm.mailbox_connections.microsoft_user_id),
         tenant_id = coalesce(excluded.tenant_id, crm.mailbox_connections.tenant_id)`,
      [
        actor.workspaceId,
        actor.userId,
        email,
        encryptSecret(input.refreshToken),
        encryptSecret(input.accessToken),
        input.expiresAt,
        input.microsoftUserId ?? null,
        input.tenantId ?? null,
      ],
    );
  });
}

export type SignedInAccount = { email: string; id: string | null; aliases: string[] };

export function sameMicrosoftAccount(known: { email: string | null; microsoftUserId: string | null }, signedIn: SignedInAccount) {
  if (known.microsoftUserId && signedIn.id) return known.microsoftUserId === signedIn.id;
  const wanted = canonicalEmail(known.email ?? "");
  return Boolean(wanted) && [signedIn.email, ...signedIn.aliases].some((item) => canonicalEmail(item) === wanted);
}

export function wrongAccount(signedIn: string, expected: string, canAdd: boolean, adding = false) {
  return new CrmError("conflict", `You signed in as ${signedIn}. Sign in as ${expected} to ${adding ? "add" : "reconnect"} it.`, 409, {
    signedIn,
    add: canAdd ? signedIn : null,
  });
}

export async function isExtraAccount(db: Db, actor: UserActor, signedIn: SignedInAccount) {
  const result = await db.query<{ email: string | null; microsoft_user_id: string | null }>(
    "select email, microsoft_user_id from crm.calendar_accounts where user_id = $1 and provider = 'microsoft'",
    [actor.userId],
  );
  return result.rows.some((row) => sameMicrosoftAccount({ email: row.email, microsoftUserId: row.microsoft_user_id }, signedIn));
}

export type Sender = { id: string; email: string; label: string; primary: boolean; signature: string | null };

const SIGNATURE_MAX_LENGTH = 2000;

async function signatureFor(db: Db, actor: UserActor, email: string) {
  const result = await db.query<{ body: string }>(
    "select body from crm.email_signatures where user_id = $1 and sender_email = $2",
    [actor.userId, email.toLowerCase()],
  );
  return result.rows[0]?.body ?? null;
}

export async function saveSignature(actor: UserActor, senderEmail: string, body: string) {
  const email = canonicalEmail(senderEmail);
  const senders = await listSenders(actor);
  const identities = await withActor(actor, async (db) => {
    const result = await db.query<{ email: string }>("select email from crm.send_identities where user_id = $1", [actor.userId]);
    return result.rows.map((row) => row.email.toLowerCase());
  });
  if (!email || !(senders.some((sender) => sender.email.toLowerCase() === email) || identities.includes(email))) {
    throw new CrmError("not_found", "You can only add a signature to an address you send from.", 404, { field: "email" });
  }
  const text = body.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
  if (text.length > SIGNATURE_MAX_LENGTH) {
    throw new CrmError("invalid_input", `Keep the signature under ${SIGNATURE_MAX_LENGTH} characters.`, 400, { field: "signature" });
  }
  await withActor(actor, async (db) => {
    if (!text) {
      await db.query("delete from crm.email_signatures where user_id = $1 and sender_email = $2", [actor.userId, email]);
      return;
    }
    await db.query(
      `insert into crm.email_signatures (workspace_id, user_id, sender_email, body)
       values ($1, $2, $3, $4)
       on conflict (workspace_id, user_id, sender_email) do update set body = excluded.body, updated_at = now()`,
      [actor.workspaceId, actor.userId, email, text],
    );
  });
  return text || null;
}

const PRIMARY_SENDER = "primary";

type ResolvedSender = {
  email: string;
  signature: string | null;
  tokens: StoredTokens;
  save: (db: Db, token: MicrosoftToken) => Promise<void>;
};

export async function listSenders(actor: UserActor): Promise<Sender[]> {
  return withActor(actor, async (db) => {
    const primary = await readStored(db, actor);
    const accounts = await db.query<{ id: string; email: string; display_name: string | null }>(
      `select id, email, display_name from crm.calendar_accounts
       where user_id = $1 and provider = 'microsoft' and status = 'connected' and can_send and email is not null
       order by created_at, email`,
      [actor.userId],
    );
    const signatures = await db.query<{ sender_email: string; body: string }>(
      "select sender_email, body from crm.email_signatures where user_id = $1",
      [actor.userId],
    );
    const signature = (email: string) => signatures.rows.find((row) => row.sender_email === email.toLowerCase())?.body ?? null;
    return [
      ...(primary && primary.status === "connected" && primary.refreshTokenCipher
        ? [{ id: PRIMARY_SENDER, email: primary.email, label: primary.email, primary: true, signature: signature(primary.email) }]
        : []),
      ...accounts.rows.map((row) => ({ id: row.id, email: row.email, label: row.email, primary: false, signature: signature(row.email) })),
    ];
  });
}

async function resolveSender(db: Db, actor: UserActor, from: string | null | undefined): Promise<ResolvedSender> {
  if (!from || from === PRIMARY_SENDER) {
    const mailbox = await readStored(db, actor);
    if (!mailbox || mailbox.status !== "connected" || !mailbox.refreshTokenCipher) {
      throw new CrmError("invalid_input", "Connect Microsoft in Settings › Email before sending.", 400, { stopsRun: true });
    }
    return {
      email: mailbox.email,
      signature: await signatureFor(db, actor, mailbox.email),
      tokens: mailbox,
      save: (inner, token) => storeToken(inner, mailbox.id, token),
    };
  }
  const found = isUuid(from)
    ? await db.query<{
        id: string;
        email: string;
        can_send: boolean;
        status: string;
        refresh_token: string | null;
        access_token: string | null;
        access_token_expires_at: Date | string | null;
      }>(
        `select id, email, can_send, status, refresh_token, access_token, access_token_expires_at
         from crm.calendar_accounts
         where id = $1 and user_id = $2 and provider = 'microsoft'`,
        [from, actor.userId],
      )
    : { rows: [] };
  const account = found.rows[0];
  if (!account) throw new CrmError("not_found", "That email account isn't connected.", 404, { field: "from" });
  if (account.status !== "connected" || !account.refresh_token) {
    throw new CrmError("invalid_input", `Reconnect ${account.email} in ${account.can_send ? "Settings › Email" : "Settings › Calendars"} before sending from it.`, 400, { field: "from", stopsRun: true });
  }
  if (!account.can_send) {
    throw new CrmError("invalid_input", `Add mail for ${account.email} in Settings › Calendars first.`, 400, { field: "from" });
  }
  return {
    email: account.email,
    signature: await signatureFor(db, actor, account.email),
    tokens: {
      refreshTokenCipher: account.refresh_token,
      accessTokenCipher: account.access_token,
      accessTokenExpiresAt: account.access_token_expires_at ? new Date(account.access_token_expires_at).toISOString() : null,
    },
    save: async (inner, token) => {
      await inner.query(
        `update crm.calendar_accounts
         set refresh_token = $2, access_token = $3, access_token_expires_at = $4
         where id = $1`,
        [account.id, encryptSecret(token.refreshToken), encryptSecret(token.accessToken), token.expiresAt],
      );
    },
  };
}

export async function sendContactEmail(
  actor: UserActor,
  contactId: string,
  input: {
    subject: string;
    body: string;
    attachments?: string[];
    keepAttachments?: boolean;
    from?: string | null;
    signature?: boolean;
    provenance?: Provenance;
    origin?: string | null;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{ warning: string | null }> {
  const subject = input.subject.replace(/\s+/g, " ").trim();
  const body = input.body.trim();
  if (!subject || !body) {
    throw new CrmError("invalid_input", "Enter a subject and a message.", 400);
  }
  if (subject.length > 200) {
    throw new CrmError(
      "invalid_input",
      "Keep the subject under 200 characters.",
      400,
      {
        field: "subject",
      },
    );
  }
  if (body.length > 8000) {
    throw new CrmError(
      "invalid_input",
      "Keep the message under 8000 characters.",
      400,
      {
        field: "body",
      },
    );
  }
  if (!hasScope(actor.scopes, "activities:write")) {
    throw new CrmError("forbidden", "Missing scope activities:write.", 403, {
      scope: "activities:write",
    });
  }

  const prepared = await withActor(actor, async (db) => {
    const found = await db.query<{
      id: string;
      email: string | null;
      name: string | null;
      company_id: string | null;
    }>(
      `select
         id,
         email,
         coalesce(nullif(trim(concat_ws(' ', first_name, last_name)), ''), email) as name,
         company_id
       from crm.contacts
       where id = $1 and workspace_id = $2 and archived_at is null`,
      [contactId, actor.workspaceId],
    );
    return {
      contact: found.rows[0] ?? null,
      sender: found.rows[0] ? await resolveSender(db, actor, input.from) : null,
    };
  });
  const contact = prepared.contact;
  if (!contact) throw new CrmError("not_found", "Contact not found.", 404);
  const to = canonicalEmail(contact.email ?? "");
  if (!to) {
    throw new CrmError(
      "invalid_input",
      "Add an email address before sending.",
      400,
      {
        field: "email",
      },
    );
  }
  const sender = prepared.sender!;
  const attached = await loadAttachments(actor, input.attachments ?? [], fetchImpl);
  const origin = input.origin === undefined ? mailOrigin() : input.origin;
  const trackingId = origin && (await readStatusesOn(actor)) ? await startTracking(actor, sender.email) : null;
  let token: MicrosoftToken;
  try {
    token = await currentToken(sender.tokens, fetchImpl);
    await sendGraphMail(
      token.accessToken,
      {
        to,
        toName: contact.name,
        subject,
        body: composeEmailHtml({
          body,
          signature: input.signature !== false ? sender.signature : null,
          pixel: trackingPixelUrl(origin, trackingId),
          plain: true,
        }),
        html: true,
        attachments: attached.files,
      },
      fetchImpl,
    );
  } catch (error) {
    if (trackingId) await dropUnsentTracking(actor, trackingId).catch(() => undefined);
    const reconnect = reconnectProblem(error, sender.email);
    throw new CrmError(
      "upstream_error",
      reconnect ??
        sanitizeMicrosoftError(
          error instanceof Error ? error.message : "Couldn't send the email.",
        ),
      502,
      { stopsRun: Boolean(reconnect) || appNeedsAttention(error) || (error instanceof MicrosoftError && error.stopsRun) },
    );
  }

  try {
    await withActor(actor, async (db) => {
      await sender.save(db, token);
    });
  } catch {}
  if (trackingId) {
    await markTrackingSent(actor, trackingId, { recipients: [{ name: contact.name, address: to }], subject, senderEmail: sender.email }).catch((error: unknown) =>
      console.error("Couldn't mark the read status as sent", error),
    );
  }
  if (attached.summary.length && !input.keepAttachments) await discardAttachments(actor, input.attachments ?? [], fetchImpl);
  try {
    await withActor(actor, async (db) => {
      const activity = await createActivityInDb(
        db,
        actor,
        {
          type: "email",
          title: subject,
          body,
          companyId: contact.company_id,
          contactId: contact.id,
          metadata: {
            source: "microsoft",
            direction: "outbound",
            to,
            from: sender.email,
            ...(attached.summary.length ? { attachments: attached.summary } : {}),
          },
        },
        input.provenance ?? { operation: "send_email", source: "microsoft" },
      );
      if (trackingId && activity) {
        await db.query("update crm.mail_tracking set activity_id = $2 where id = $1 and user_id = $3", [trackingId, activity.id, actor.userId]);
      }
    });
  } catch {
    return { warning: UNFILED_WARNING };
  }
  return { warning: null };
}

async function startTracking(actor: UserActor, senderEmail: string) {
  return withActor(actor, async (db) => {
    const created = await db.query<{ id: string }>(
      "insert into crm.mail_tracking (workspace_id, user_id, sender_email) values ($1, $2, $3) returning id",
      [actor.workspaceId, actor.userId, senderEmail],
    );
    return created.rows[0].id;
  });
}

async function dropUnsentTracking(actor: UserActor, trackingId: string) {
  await withActor(actor, (db) =>
    db.query("delete from crm.mail_tracking where id = $1 and user_id = $2 and sent_at is null", [trackingId, actor.userId]),
  );
}

async function markTrackingSent(
  actor: UserActor,
  trackingId: string,
  sent: { recipients: { name: string | null; address: string }[]; subject: string; senderEmail: string },
) {
  await withActor(actor, (db) =>
    db.query(
      "update crm.mail_tracking set sent_at = now(), recipients = $3, subject = $4, sender_email = $5 where id = $1 and user_id = $2",
      [trackingId, actor.userId, JSON.stringify(sent.recipients), sent.subject, sent.senderEmail],
    ),
  );
}

export async function disconnectMailbox(actor: UserActor) {
  await withActor(actor, async (db) => {
    await db.query(
      `update crm.mailbox_connections
       set status = 'disconnected',
           refresh_token = null,
           access_token = null,
           access_token_expires_at = null,
           last_error = null
       where user_id = $1 and provider = 'microsoft'`,
      [actor.userId],
    );
  });
}

export async function syncMailbox(
  actor: UserActor,
  fetchImpl: typeof fetch = fetch,
): Promise<SyncCounts> {
  const stored = await withActor(actor, async (db) => readStored(db, actor));
  if (
    !stored ||
    stored.status !== "connected" ||
    !stored.refreshTokenCipher
  ) {
    return {
      attached: 0,
      unattached: 0,
      skipped: 0,
      followUps: 0,
      error: "Connect Microsoft to sync this inbox.",
    };
  }
  const owner = mailboxActor(actor, stored);
  try {
    const token = await currentToken(stored, fetchImpl);
    const since = stored.lastSyncedAt
      ? new Date(new Date(stored.lastSyncedAt).getTime() - OVERLAP_MS)
      : new Date(Date.now() - LOOKBACK_MS);
    const fetched = await fetchInboxMessages(
      token.accessToken,
      since,
      fetchImpl,
    );
    const inbound = fetched.messages
      .map(graphToInbound)
      .filter((message) => message.providerMessageId);
    const watermark = syncWatermark(stored, since, fetched);
    const candidates: FollowUpCandidate[] = [];
    const counts = await withActor(owner, async (db) => {
      await lockMailbox(db, stored.id);
      await storeToken(db, stored.id, token);
      const counts = await fileMessages(db, owner, stored, inbound, candidates);
      await db.query("savepoint attach_unmatched");
      try {
        counts.attached += await attachUnmatched(db, owner, stored);
        await db.query("release savepoint attach_unmatched");
      } catch (error) {
        await db.query("rollback to savepoint attach_unmatched");
        console.error("Could not attach earlier inbox mail", error);
      }
      await db.query(
        `update crm.mailbox_connections
         set last_synced_at = least(coalesce($2::timestamptz, now()), now()),
             last_attempt_at = now(),
             last_error = null
         where id = $1`,
        [stored.id, watermark],
      );
      return counts;
    });
    const followUpIds = await suggestFollowUps(owner, candidates);
    counts.followUps = followUpIds.length;
    await sendFollowUpsToClickUp(owner, followUpIds);
    return counts;
  } catch (error) {
    const message = sanitizeMicrosoftError(
      error instanceof Error ? error.message : "Couldn't sync the inbox.",
    );
    await withActor(owner, async (db) => {
      await db.query(
        `update crm.mailbox_connections
         set last_attempt_at = now(), last_error = $2
         where id = $1 and user_id = $3`,
        [stored.id, message, owner.userId],
      );
    });
    return {
      attached: 0,
      unattached: 0,
      skipped: 0,
      followUps: 0,
      error: message,
    };
  }
}

function syncWatermark(
  stored: StoredConnection,
  since: Date,
  fetched: InboxFetch,
) {
  if (fetched.complete) return null;
  if (fetched.ordered) {
    let newest = Number.NEGATIVE_INFINITY;
    for (const message of fetched.messages) {
      const time = message.receivedDateTime
        ? new Date(message.receivedDateTime).getTime()
        : Number.NaN;
      if (!Number.isNaN(time) && time > newest) newest = time;
    }
    if (Number.isFinite(newest))
      return new Date(newest + OVERLAP_MS).toISOString();
  }
  return (
    stored.lastSyncedAt ?? new Date(since.getTime() + OVERLAP_MS).toISOString()
  );
}

export async function fileInboundMessages(
  actor: UserActor,
  messages: InboundEmail[],
): Promise<SyncCounts> {
  const stored = await withActor(actor, (db) => readStored(db, actor));
  if (!stored) {
    throw new CrmError(
      "invalid_input",
      "Connect Microsoft before filing mail.",
      400,
    );
  }
  const owner = mailboxActor(actor, stored);
  const candidates: FollowUpCandidate[] = [];
  const counts = await withActor(owner, async (db) => {
    await lockMailbox(db, stored.id);
    return fileMessages(db, owner, stored, messages, candidates);
  });
  const followUpIds = await suggestFollowUps(owner, candidates);
  counts.followUps = followUpIds.length;
  await sendFollowUpsToClickUp(owner, followUpIds);
  return counts;
}

type FollowUpCandidate = { companyId: string; contactId: string | null; who: string };

async function suggestFollowUps(actor: UserActor, candidates: FollowUpCandidate[]) {
  const taskIds: string[] = [];
  const checked = new Set<string>();
  for (const candidate of candidates) {
    if (checked.has(candidate.companyId)) continue;
    checked.add(candidate.companyId);
    try {
      if (await companyHasOpenTask(actor.workspaceId, candidate.companyId)) continue;
      const due = await scheduleTaskDue(actor, { days: 2 });
      const task = await withActor(actor, (db) =>
        createTaskInDb(
          db,
          actor,
          {
            title: `Follow up with ${candidate.who}`.slice(0, 200),
            description: withDueNote("Suggested after an email arrived.", due),
            dueAt: due?.dueAt ?? null,
            companyId: candidate.companyId,
            contactId: candidate.contactId,
            priority: "normal",
          },
          { operation: "suggest_follow_up", source: "microsoft" },
        ),
      );
      if (task) taskIds.push(task.id);
    } catch (error) {
      console.error("Could not suggest a follow-up task", error);
    }
  }
  return taskIds;
}

function mailboxActor(actor: UserActor, stored: StoredConnection): UserActor {
  return stored.workspaceId === actor.workspaceId ? actor : { ...actor, workspaceId: stored.workspaceId };
}

async function sendFollowUpsToClickUp(actor: UserActor, taskIds: string[]) {
  if (taskIds.length === 0) return;
  const { sendTaskToDefaultList } = await import("@/lib/crm/clickup");
  for (const taskId of taskIds) {
    try {
      await sendTaskToDefaultList(actor, taskId);
    } catch (error) {
      console.error("Could not send the follow-up task to ClickUp", error);
    }
  }
}

async function lockMailbox(db: Db, connectionId: string) {
  await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    connectionId,
  ]);
}

async function fileActivity(
  db: Db,
  actor: UserActor,
  message: Pick<
    InboundEmail,
    "providerMessageId" | "subject" | "preview" | "fromEmail" | "receivedAt" | "internetMessageId"
  >,
  match: PartyMatch,
) {
  const internetMessageId = message.internetMessageId || null;
  const saved = await createEmailActivityOnce(
    db,
    actor,
    {
      type: "email",
      title: clip(message.subject, 200) || "Email",
      body: clip(message.preview, 4000),
      occurredAt: validTime(message.receivedAt),
      companyId: match.companyId,
      contactId: match.contactId,
      metadata: {
        source: "microsoft",
        providerMessageId: message.providerMessageId,
        ...(internetMessageId ? { internetMessageId } : {}),
        from: canonicalEmail(message.fromEmail ?? "") ?? null,
      },
    },
    { internetMessageId, providerMessageId: message.providerMessageId },
    { operation: "sync_inbox", source: "microsoft" },
  );
  return saved.id;
}

async function attachUnmatched(
  db: Db,
  actor: UserActor,
  mailbox: StoredConnection,
) {
  const pending = await db.query<{
    id: string;
    provider_message_id: string;
    subject: string | null;
    preview: string | null;
    from_email: string;
    received_at: Date | string | null;
    conversation_id: string | null;
    internet_message_id: string | null;
  }>(
    `select m.id, m.provider_message_id, m.subject, m.preview, m.from_email, m.received_at, m.conversation_id, m.internet_message_id
     from crm.email_messages m
     where m.connection_id = $1
       and m.workspace_id = $2
       and m.contact_id is null
       and m.company_id is null
       and m.activity_id is null
       and m.from_email is not null
       and m.from_email <> $3
       and (
         exists (
           select 1 from crm.contacts c
           where c.workspace_id = m.workspace_id
             and c.archived_at is null
             and c.normalized_email = m.from_email
         )
         or (
           split_part(m.from_email, '@', 2) <> all($4::text[])
           and exists (
             select 1 from crm.companies co
             where co.workspace_id = m.workspace_id
               and co.archived_at is null
               and co.domain = split_part(m.from_email, '@', 2)
           )
         )
       )
     order by m.received_at asc nulls last
     limit 200`,
    [
      mailbox.id,
      actor.workspaceId,
      canonicalEmail(mailbox.email) ?? mailbox.email,
      [...FREE_MAIL_DOMAINS],
    ],
  );
  let attached = 0;
  for (const row of pending.rows) {
    const parties = counterpartEmails({
      mailboxEmail: mailbox.email,
      fromEmail: row.from_email,
    });
    const match = await matchParties(db, actor.workspaceId, parties);
    if (!match.contactId && !match.companyId) continue;
    if (await routedAway(db, actor.userId, actor.workspaceId, row.conversation_id, row.from_email, mailbox.id)) continue;
    const activityId = await fileActivity(
      db,
      actor,
      {
        providerMessageId: row.provider_message_id,
        subject: row.subject,
        preview: row.preview,
        fromEmail: row.from_email,
        receivedAt: iso(row.received_at),
        internetMessageId: row.internet_message_id,
      },
      match,
    );
    await db.query(
      `update crm.email_messages
       set contact_id = $2, company_id = $3, activity_id = $4
       where id = $1`,
      [row.id, match.contactId, match.companyId, activityId],
    );
    attached += 1;
  }
  return attached;
}

async function fileMessages(
  db: Db,
  actor: UserActor,
  mailbox: StoredConnection,
  messages: InboundEmail[],
  followUps: FollowUpCandidate[],
): Promise<SyncCounts> {
  const counts: SyncCounts = {
    attached: 0,
    unattached: 0,
    skipped: 0,
    followUps: 0,
  };
  for (const message of messages) {
    const providerMessageId = message.providerMessageId.trim().slice(0, 400);
    if (!providerMessageId || message.isDraft) {
      counts.skipped += 1;
      continue;
    }
    const existing = await db.query(
      `select 1 from crm.email_messages
       where workspace_id = $1 and provider_message_id = $2`,
      [actor.workspaceId, providerMessageId],
    );
    if ((existing.rowCount ?? 0) > 0) {
      counts.skipped += 1;
      continue;
    }
    const parties = counterpartEmails({
      mailboxEmail: mailbox.email,
      fromEmail: message.fromEmail,
      toEmails: message.toEmails,
      ccEmails: message.ccEmails,
    });
    const found = await matchParties(db, actor.workspaceId, parties);
    const away = (found.contactId || found.companyId) && (await routedAway(db, actor.userId, actor.workspaceId, message.conversationId, message.fromEmail, mailbox.id));
    const match = away ? { contactId: null, contactName: null, companyId: null, companyName: null } : found;
    let activityId: string | null = null;
    const internetMessageId = clip(message.internetMessageId, 400);
    const logged = internetMessageId
      ? await db.query<{ id: string }>(
          `select id from crm.activities
           where workspace_id = $1 and type = 'email' and metadata->>'internetMessageId' = $2
           limit 1`,
          [actor.workspaceId, internetMessageId],
        )
      : null;
    if (logged?.rows[0]) {
      activityId = logged.rows[0].id;
    } else if (match.contactId || match.companyId) {
      activityId = await fileActivity(
        db,
        actor,
        { ...message, providerMessageId, internetMessageId },
        match,
      );
      if (match.companyId && isRecent(message.receivedAt) && hasScope(actor.scopes, "tasks:write")) {
        followUps.push({
          companyId: match.companyId,
          contactId: match.contactId,
          who: match.contactName || match.companyName || "them",
        });
      }
    }
    const inserted = await db.query(
      `insert into crm.email_messages (
         workspace_id, connection_id, provider_message_id, conversation_id,
         internet_message_id, direction, subject, preview, from_email, from_name,
         received_at, contact_id, company_id, activity_id
       ) values (
         $1, $2, $3, $4, $5, 'inbound', $6, $7, $8, $9, $10::timestamptz, $11, $12, $13
       )
       on conflict (workspace_id, provider_message_id) do nothing`,
      [
        actor.workspaceId,
        mailbox.id,
        providerMessageId,
        clip(message.conversationId, 400),
        clip(message.internetMessageId, 400),
        clip(message.subject, 500),
        clip(message.preview, 4000),
        canonicalEmail(message.fromEmail ?? ""),
        clip(message.fromName, 200),
        validTime(message.receivedAt) ?? null,
        match.contactId,
        match.companyId,
        activityId,
      ],
    );
    if ((inserted.rowCount ?? 0) === 0) {
      counts.skipped += 1;
      continue;
    }
    if (match.contactId || match.companyId) counts.attached += 1;
    else counts.unattached += 1;
  }
  return counts;
}

export async function matchParties(
  db: Db,
  workspaceId: string,
  emails: string[],
): Promise<PartyMatch> {
  for (const email of emails) {
    const found = await db.query<{
      id: string;
      company_id: string | null;
      name: string | null;
    }>(
      `select
         id,
         company_id,
         coalesce(nullif(trim(concat_ws(' ', first_name, last_name)), ''), email) as name
       from crm.contacts
       where workspace_id = $1 and archived_at is null and normalized_email = $2
       limit 1`,
      [workspaceId, email],
    );
    const contact = found.rows[0];
    if (!contact) continue;
    return {
      contactId: contact.id,
      contactName: contact.name,
      companyId: contact.company_id,
      companyName: contact.company_id
        ? await companyName(db, contact.company_id)
        : null,
    };
  }
  for (const email of emails) {
    const domain = canonicalDomain(email.split("@")[1] ?? "");
    if (!domain || isFreeMailDomain(domain)) continue;
    const found = await db.query<{ id: string; name: string }>(
      `select id, name from crm.companies
       where workspace_id = $1 and archived_at is null and domain = $2
       limit 1`,
      [workspaceId, domain],
    );
    const company = found.rows[0];
    if (!company) continue;
    return {
      contactId: null,
      contactName: null,
      companyId: company.id,
      companyName: company.name,
    };
  }
  return {
    contactId: null,
    contactName: null,
    companyId: null,
    companyName: null,
  };
}

async function companyName(db: Db, companyId: string) {
  const result = await db.query<{ name: string }>(
    "select name from crm.companies where id = $1",
    [companyId],
  );
  return result.rows[0]?.name ?? null;
}

function validTime(value: string | null | undefined) {
  if (!value) return undefined;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return undefined;
  return new Date(time).toISOString();
}

function clip(value: string | null | undefined, max: number) {
  const trimmed = value?.replace(/\s+/g, " ").trim() ?? "";
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function graphToInbound(message: GraphInboxMessage): InboundEmail {
  return {
    providerMessageId: message.id?.trim() ?? "",
    conversationId: message.conversationId ?? null,
    internetMessageId: message.internetMessageId ?? null,
    subject: message.subject ?? null,
    preview: message.bodyPreview ?? null,
    fromEmail: message.from?.emailAddress?.address ?? null,
    fromName: message.from?.emailAddress?.name ?? null,
    toEmails: addresses(message.toRecipients),
    ccEmails: addresses(message.ccRecipients),
    receivedAt: message.receivedDateTime ?? null,
    isDraft: Boolean(message.isDraft),
  };
}

function addresses(recipients: GraphInboxMessage["toRecipients"]) {
  return (recipients ?? [])
    .map((recipient) => recipient.emailAddress?.address ?? "")
    .filter(Boolean);
}

export function readSecret(value: string | null) {
  if (!value) return null;
  try {
    return decryptSecret(value);
  } catch {
    return null;
  }
}

export type StoredTokens = Pick<
  StoredConnection,
  "refreshTokenCipher" | "accessTokenCipher" | "accessTokenExpiresAt"
>;

export async function currentToken(
  stored: StoredTokens,
  fetchImpl: typeof fetch,
): Promise<MicrosoftToken> {
  const refreshToken = readSecret(stored.refreshTokenCipher);
  if (!refreshToken) throw new MicrosoftError(RECONNECT_MESSAGE, { stopsRun: true });
  const accessToken = readSecret(stored.accessTokenCipher);
  const expires = stored.accessTokenExpiresAt
    ? new Date(stored.accessTokenExpiresAt).getTime()
    : 0;
  if (accessToken && expires > Date.now() + 60_000) {
    return {
      accessToken,
      refreshToken,
      expiresAt: stored.accessTokenExpiresAt!,
    };
  }
  return refreshMicrosoftToken(refreshToken, fetchImpl);
}

export async function storeToken(db: Db, connectionId: string, token: MicrosoftToken) {
  await db.query(
    `update crm.mailbox_connections
     set refresh_token = $2, access_token = $3, access_token_expires_at = $4
     where id = $1`,
    [
      connectionId,
      encryptSecret(token.refreshToken),
      encryptSecret(token.accessToken),
      token.expiresAt,
    ],
  );
}

async function readSummary(db: Db, actor: UserActor) {
  const stored = await readStored(db, actor);
  if (!stored) return null;
  return summary(stored);
}

export async function readStored(
  db: Db,
  actor: UserActor,
): Promise<StoredConnection | null> {
  const result = await db.query<{
    id: string;
    workspace_id: string;
    email: string;
    status: "connected" | "disconnected";
    refresh_token: string | null;
    access_token: string | null;
    access_token_expires_at: Date | string | null;
    last_synced_at: Date | string | null;
    last_attempt_at: Date | string | null;
    last_error: string | null;
    microsoft_user_id: string | null;
  }>(
    `select id, workspace_id, email, status, refresh_token, access_token, access_token_expires_at, microsoft_user_id,
            last_synced_at, last_attempt_at, last_error
     from crm.mailbox_connections
     where user_id = $1 and provider = 'microsoft'
     order by status = 'connected' desc, created_at desc
     limit 1`,
    [actor.userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    email: row.email,
    status: row.status,
    lastSyncedAt: iso(row.last_synced_at),
    lastAttemptAt: iso(row.last_attempt_at),
    lastError: row.last_error,
    refreshTokenCipher: row.refresh_token,
    accessTokenCipher: row.access_token,
    accessTokenExpiresAt: iso(row.access_token_expires_at),
    microsoftUserId: row.microsoft_user_id,
  };
}

function summary(stored: StoredConnection): MailboxSummary {
  return {
    id: stored.id,
    email: stored.email,
    status: stored.status,
    lastSyncedAt: stored.lastSyncedAt,
    lastAttemptAt: stored.lastAttemptAt,
    lastError: stored.lastError,
  };
}

function iso(value: Date | string | null) {
  if (!value) return null;
  return new Date(value).toISOString();
}

export async function sendOwnMail(
  actor: UserActor,
  message: { to: string; toName?: string | null; subject: string; body: string },
  fetchImpl: typeof fetch = fetch,
) {
  const mailbox = await withActor(actor, (db) => readStored(db, actor));
  if (!mailbox || mailbox.status !== "connected" || !mailbox.refreshTokenCipher) {
    throw new CrmError("invalid_input", "Connect Microsoft in Settings › Email to send this by email.", 400);
  }
  let token: MicrosoftToken;
  try {
    token = await currentToken(mailbox, fetchImpl);
    await sendGraphMail(token.accessToken, message, fetchImpl);
  } catch (error) {
    throw new CrmError(
      "upstream_error",
      reconnectProblem(error, mailbox.email) ?? sanitizeMicrosoftError(error instanceof Error ? error.message : "Couldn't send the email."),
      502,
    );
  }
  try {
    await withActor(actor, (db) => storeToken(db, mailbox.id, token));
  } catch {}
}
