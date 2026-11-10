import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { needsReconnecting, RECONNECT_NEEDED, reconnectHref, type MailboxKind, type ReconnectTarget, type RemovalImpact } from "@/lib/mail/mailboxes";
import { GraphMailError, reconnectProblem } from "@/lib/mail/microsoft";
import { grantsMailWrite } from "@/lib/microsoft/oauth";

export type ReconnectSource = { id: string; email: string; main: boolean; scopes?: string | null };

export const SOURCE_SCOPES = `case when s.connection_id is not null
    then (select i.granted_scopes from crm.integration_state i where i.connection_id = s.connection_id and i.source = 'calendar')
    else (select a.granted_scopes from crm.calendar_accounts a where a.id = s.account_id)
  end`;

export function reconnectTarget(source: ReconnectSource | null | undefined): ReconnectTarget {
  if (!source) return { sourceId: null, email: null, href: null };
  return { sourceId: source.id, email: source.email, href: reconnectHref(source.main ? "main" : "account", source.email) };
}

export function reconnectError(message: string, source: ReconnectSource | null | undefined) {
  return new CrmError(RECONNECT_NEEDED, message, 502, { reconnect: reconnectTarget(source) });
}

export function graphReconnect(error: unknown, source: ReconnectSource | null | undefined) {
  if (error instanceof CrmError) return error.code === RECONNECT_NEEDED ? error : null;
  const message = reconnectProblem(error, source?.email, source ? grantsMailWrite(source.scopes) : null);
  return message ? reconnectError(message, source) : null;
}

export async function readReconnectSource(db: Db, actor: UserActor, sourceId: string): Promise<ReconnectSource | null> {
  const result = await db.query<{ id: string; email: string; main: boolean; scopes: string | null }>(
    `select s.id, s.email, s.connection_id is not null as main, ${SOURCE_SCOPES} as scopes from crm.mail_sources s where s.id = $1 and s.user_id = $2`,
    [sourceId, actor.userId],
  );
  return result.rows[0] ?? null;
}

export async function sourceReconnect(actor: UserActor, sourceId: string, error: unknown) {
  if (error instanceof CrmError) return error.code === RECONNECT_NEEDED ? error : null;
  if (!(error instanceof GraphMailError && error.status === 403) && !reconnectProblem(error, null)) return null;
  const source = await withActor(actor, (db) => readReconnectSource(db, actor, sourceId)).catch(() => null);
  return graphReconnect(error, source);
}

export async function readRemovalImpacts(db: Db, actor: UserActor) {
  const result = await db.query<{ account_id: string | null; connection_id: string | null; emails: number; drafts: number; scheduled: number; addresses: string[] }>(
    `select s.account_id, s.connection_id,
       (select coalesce(sum(f.synced_count), 0)::int from crm.mail_folders f where f.source_id = s.id and f.sync_state <> 'skipped') as emails,
       (select count(*)::int from crm.mail_drafts d where d.source_id = s.id and d.send_at is null) as drafts,
       (select count(*)::int from crm.mail_drafts d where d.source_id = s.id and d.send_at is not null) as scheduled,
       coalesce((select array_agg(i.email order by i.created_at) from crm.send_identities i where i.source_id = s.id), '{}') as addresses
     from crm.mail_sources s where s.user_id = $1`,
    [actor.userId],
  );
  const impacts = new Map<string, RemovalImpact>();
  for (const row of result.rows) {
    const key = row.account_id ?? row.connection_id;
    if (key) impacts.set(key, { emails: row.emails, drafts: row.drafts, scheduled: row.scheduled, addresses: row.addresses });
  }
  return impacts;
}

export type Mailbox = {
  kind: MailboxKind;
  id: string;
  email: string;
  connected: boolean;
  needsReconnect: boolean;
  problem: string | null;
  lastSyncedAt: string | null;
  reconnectHref: string;
  removes: RemovalImpact | null;
};

function iso(value: Date | string | null) {
  return value ? new Date(value).toISOString() : null;
}

export async function listMailboxes(actor: UserActor): Promise<Mailbox[]> {
  return withActor(actor, async (db) => {
    const main = await db.query<{
      id: string;
      email: string;
      connected: boolean;
      last_error: string | null;
      source_error: string | null;
      source_synced: Date | string | null;
    }>(
      `select c.id, c.email, c.status = 'connected' and c.refresh_token is not null as connected, c.last_error,
         s.last_error as source_error, s.last_synced_at as source_synced
       from crm.mailbox_connections c
       left join crm.mail_sources s on s.connection_id = c.id
       where c.user_id = $1 and c.provider = 'microsoft'
       order by c.status = 'connected' desc, c.created_at desc
       limit 1`,
      [actor.userId],
    );
    const accounts = await db.query<{
      id: string;
      email: string;
      connected: boolean;
      last_error: string | null;
      source_error: string | null;
      source_synced: Date | string | null;
    }>(
      `select a.id, a.email, a.status = 'connected' and a.refresh_token is not null as connected, a.last_error,
         s.last_error as source_error, s.last_synced_at as source_synced
       from crm.calendar_accounts a
       left join crm.mail_sources s on s.account_id = a.id
       where a.user_id = $1 and a.provider = 'microsoft' and a.can_send and a.email is not null
       order by a.created_at, a.email, a.id`,
      [actor.userId],
    );
    const impacts = await readRemovalImpacts(db, actor);
    const toMailbox = (kind: MailboxKind) => (row: (typeof main.rows)[number]): Mailbox => {
      const problem = row.source_error ?? (kind === "main" || needsReconnecting(row.last_error) ? row.last_error : null);
      return {
        kind,
        id: row.id,
        email: row.email,
        connected: row.connected,
        needsReconnect: !row.connected || needsReconnecting(problem),
        problem,
        lastSyncedAt: iso(row.source_synced),
        reconnectHref: reconnectHref(kind, row.email),
        removes: kind === "account" ? (impacts.get(row.id) ?? { emails: 0, drafts: 0, scheduled: 0, addresses: [] }) : null,
      };
    };
    return [...main.rows.map(toMailbox("main")), ...accounts.rows.map(toMailbox("account"))];
  });
}
