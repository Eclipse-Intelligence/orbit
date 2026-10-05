import type { Db } from "@/lib/db/pool";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secret";
import { withActor } from "@/lib/crm/context";
import { createActivityInDb } from "@/lib/crm/activities";
import { CrmError } from "@/lib/crm/errors";
import { canonicalDomain, canonicalEmail } from "@/lib/crm/normalize";
import { hasScope } from "@/lib/crm/scopes";
import { createTaskInDb } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import {
  fetchInboxMessages,
  refreshMicrosoftToken,
  sanitizeMicrosoftError,
  type GraphInboxMessage,
  type MicrosoftToken,
} from "@/lib/microsoft/oauth";

const LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const OVERLAP_MS = 10 * 60 * 1000;
const RECENT_MS = 48 * 60 * 60 * 1000;
const SYNC_GAP_MS = 2 * 60 * 1000;

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

export type InboundEmail = {
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

export type SyncCounts = {
  attached: number;
  unattached: number;
  skipped: number;
  followUps: number;
  error?: string;
};

type StoredConnection = MailboxSummary & {
  refreshToken: string | null;
  accessToken: string | null;
  accessTokenExpiresAt: string | null;
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
  for (const value of [input.fromEmail, ...(input.toEmails ?? []), ...(input.ccEmails ?? [])]) {
    const email = value ? canonicalEmail(value) : null;
    if (!email || email === mailbox || seen.has(email)) continue;
    seen.add(email);
    emails.push(email);
  }
  return emails;
}

export function shouldSyncMailbox(lastAttemptAt: string | null, now = Date.now()) {
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
      receivedAt: row.received_at ? new Date(row.received_at).toISOString() : null,
      contactId: row.contact_id,
      contactName: row.contact_name,
      companyId: row.company_id,
      companyName: row.company_name,
    }));
  });
}

export async function saveMailbox(
  actor: UserActor,
  input: { email: string; refreshToken: string; accessToken: string; expiresAt: string },
) {
  const email = canonicalEmail(input.email);
  if (!email) {
    throw new CrmError("invalid_input", "Microsoft did not return an email address.", 400, {
      field: "email",
    });
  }
  await withActor(actor, async (db) => {
    await db.query(
      `insert into crm.mailbox_connections (
         workspace_id, user_id, provider, email, status,
         refresh_token, access_token, access_token_expires_at, last_error
       ) values ($1, $2, 'microsoft', $3, 'connected', $4, $5, $6, null)
       on conflict (workspace_id, user_id, provider) do update set
         email = excluded.email,
         status = 'connected',
         refresh_token = excluded.refresh_token,
         access_token = excluded.access_token,
         access_token_expires_at = excluded.access_token_expires_at,
         last_error = null`,
      [
        actor.workspaceId,
        actor.userId,
        email,
        encryptSecret(input.refreshToken),
        encryptSecret(input.accessToken),
        input.expiresAt,
      ],
    );
  });
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
       where user_id = $1 and workspace_id = $2 and provider = 'microsoft'`,
      [actor.userId, actor.workspaceId],
    );
  });
}

export async function syncMailbox(
  actor: UserActor,
  fetchImpl: typeof fetch = fetch,
): Promise<SyncCounts> {
  const stored = await withActor(actor, async (db) => readStored(db, actor));
  if (!stored || stored.status !== "connected" || !stored.refreshToken) {
    return { attached: 0, unattached: 0, skipped: 0, followUps: 0, error: "Connect Microsoft to sync this inbox." };
  }
  try {
    const token = await currentToken(stored, fetchImpl);
    const since = stored.lastSyncedAt
      ? new Date(new Date(stored.lastSyncedAt).getTime() - OVERLAP_MS)
      : new Date(Date.now() - LOOKBACK_MS);
    const graphMessages = await fetchInboxMessages(token.accessToken, since, fetchImpl);
    const inbound = graphMessages.map(graphToInbound).filter((message) => message.providerMessageId);
    return await withActor(actor, async (db) => {
      await storeToken(db, stored.id, token);
      const counts = await fileMessages(db, actor, stored, inbound);
      await db.query(
        `update crm.mailbox_connections
         set last_synced_at = now(), last_attempt_at = now(), last_error = null
         where id = $1`,
        [stored.id],
      );
      return counts;
    });
  } catch (error) {
    const message = sanitizeMicrosoftError(
      error instanceof Error ? error.message : "Could not sync the inbox.",
    );
    await withActor(actor, async (db) => {
      await db.query(
        `update crm.mailbox_connections
         set last_attempt_at = now(), last_error = $2
         where id = $1 and user_id = $3`,
        [stored.id, message, actor.userId],
      );
    });
    return { attached: 0, unattached: 0, skipped: 0, followUps: 0, error: message };
  }
}

export async function fileInboundMessages(
  actor: UserActor,
  messages: InboundEmail[],
): Promise<SyncCounts> {
  return withActor(actor, async (db) => {
    const stored = await readStored(db, actor);
    if (!stored) {
      throw new CrmError("invalid_input", "Connect Microsoft before filing mail.", 400);
    }
    return fileMessages(db, actor, stored, messages);
  });
}

async function fileMessages(
  db: Db,
  actor: UserActor,
  mailbox: StoredConnection,
  messages: InboundEmail[],
): Promise<SyncCounts> {
  const counts: SyncCounts = { attached: 0, unattached: 0, skipped: 0, followUps: 0 };
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
    const match = await matchParties(db, actor.workspaceId, parties);
    let activityId: string | null = null;
    if (match.contactId || match.companyId) {
      const activity = await createActivityInDb(
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
            providerMessageId,
            from: canonicalEmail(message.fromEmail ?? "") ?? null,
          },
        },
        { operation: "sync_inbox", source: "microsoft" },
      );
      activityId = activity.id;
      if (
        match.companyId &&
        isRecent(message.receivedAt) &&
        hasScope(actor.scopes, "tasks:write") &&
        (await openTasks(db, match.companyId)) === 0
      ) {
        const who = match.contactName || match.companyName || "them";
        await createTaskInDb(
          db,
          actor,
          {
            title: `Follow up with ${who}`.slice(0, 200),
            description: "Suggested after an email arrived.",
            dueAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
            companyId: match.companyId,
            contactId: match.contactId,
            priority: "normal",
          },
          { operation: "suggest_follow_up", source: "microsoft" },
        );
        counts.followUps += 1;
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

async function matchParties(db: Db, workspaceId: string, emails: string[]) {
  for (const email of emails) {
    const found = await db.query<{ id: string; company_id: string | null; name: string | null }>(
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
      companyName: contact.company_id ? await companyName(db, contact.company_id) : null,
    };
  }
  for (const email of emails) {
    const domain = canonicalDomain(email.split("@")[1] ?? "");
    if (!domain) continue;
    const found = await db.query<{ id: string; name: string }>(
      `select id, name from crm.companies
       where workspace_id = $1 and archived_at is null and domain = $2
       limit 1`,
      [workspaceId, domain],
    );
    const company = found.rows[0];
    if (!company) continue;
    return { contactId: null, contactName: null, companyId: company.id, companyName: company.name };
  }
  return { contactId: null, contactName: null, companyId: null, companyName: null };
}

async function companyName(db: Db, companyId: string) {
  const result = await db.query<{ name: string }>("select name from crm.companies where id = $1", [
    companyId,
  ]);
  return result.rows[0]?.name ?? null;
}

async function openTasks(db: Db, companyId: string) {
  const result = await db.query<{ total: number }>(
    `select count(*)::int as total from crm.tasks
     where company_id = $1 and archived_at is null and completed_at is null`,
    [companyId],
  );
  return result.rows[0]?.total ?? 0;
}

function validTime(value: string | null | undefined) {
  if (!value) return undefined;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return undefined;
  return new Date(time).toISOString();
}

function isRecent(receivedAt: string | null | undefined) {
  if (!receivedAt) return false;
  const time = new Date(receivedAt).getTime();
  if (Number.isNaN(time)) return false;
  const age = Date.now() - time;
  return age <= RECENT_MS && age >= -5 * 60 * 1000;
}

function clip(value: string | null | undefined, max: number) {
  const trimmed = value?.replace(/\s+/g, " ").trim() ?? "";
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

export function graphToInbound(message: GraphInboxMessage): InboundEmail {
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

async function currentToken(stored: StoredConnection, fetchImpl: typeof fetch) {
  const expires = stored.accessTokenExpiresAt ? new Date(stored.accessTokenExpiresAt).getTime() : 0;
  if (stored.accessToken && expires > Date.now() + 60_000) {
    return {
      accessToken: stored.accessToken,
      refreshToken: stored.refreshToken!,
      expiresAt: stored.accessTokenExpiresAt!,
    } satisfies MicrosoftToken;
  }
  return refreshMicrosoftToken(stored.refreshToken!, fetchImpl);
}

async function storeToken(db: Db, connectionId: string, token: MicrosoftToken) {
  await db.query(
    `update crm.mailbox_connections
     set refresh_token = $2, access_token = $3, access_token_expires_at = $4
     where id = $1`,
    [connectionId, encryptSecret(token.refreshToken), encryptSecret(token.accessToken), token.expiresAt],
  );
}

async function readSummary(db: Db, actor: UserActor) {
  const stored = await readStored(db, actor);
  if (!stored) return null;
  return summary(stored);
}

async function readStored(db: Db, actor: UserActor): Promise<StoredConnection | null> {
  const result = await db.query<{
    id: string;
    email: string;
    status: "connected" | "disconnected";
    refresh_token: string | null;
    access_token: string | null;
    access_token_expires_at: Date | string | null;
    last_synced_at: Date | string | null;
    last_attempt_at: Date | string | null;
    last_error: string | null;
  }>(
    `select id, email, status, refresh_token, access_token, access_token_expires_at,
            last_synced_at, last_attempt_at, last_error
     from crm.mailbox_connections
     where user_id = $1 and workspace_id = $2 and provider = 'microsoft'`,
    [actor.userId, actor.workspaceId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    lastSyncedAt: iso(row.last_synced_at),
    lastAttemptAt: iso(row.last_attempt_at),
    lastError: row.last_error,
    refreshToken: row.refresh_token ? decryptSecret(row.refresh_token) : null,
    accessToken: row.access_token ? decryptSecret(row.access_token) : null,
    accessTokenExpiresAt: iso(row.access_token_expires_at),
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
