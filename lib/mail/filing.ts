import { cache } from "react";
import { brandOrEmpty, type BrandProfile } from "@/lib/crm/brand";
import { withActor } from "@/lib/crm/context";
import { FREE_MAIL_DOMAINS } from "@/lib/crm/communications";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import { canonicalEmail } from "@/lib/crm/normalize";
import { assertScope } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import { actorIn, workspaceActors } from "@/lib/crm/workspaces";
import type { Db } from "@/lib/db/pool";
import {
  addressHomesInDb,
  captureWorkspaceSql,
  chosenWorkspaces,
  contactElsewhere,
  effectiveFilingInDb,
  ensureContactInDb,
  filingDomain,
  homesJson,
  NOT_AUTOMATED,
  parseRouteKey,
  refs,
  setDomainRule,
  threadFilingInDb,
  threadRoute,
  upsertRoute,
} from "@/lib/mail/routing";
import { splitCase, splitJoin, UNSUBSCRIBE_TEXT } from "@/lib/mail/split";
import { fileMailOnTimeline } from "@/lib/mail/timeline";
import { captureCutoff, ownAddressesSql } from "@/lib/mail/waiting";
import type { ThreadFiling } from "@/lib/mail/view";

const CAPTURE_SCAN = 300;
const CAPTURE_SHOWN = 30;

export type UnknownEmail = {
  key: string;
  messageId: string;
  name: string | null;
  email: string;
  address: string;
  subject: string | null;
  snippet: string | null;
  at: string;
  workspaceId: string;
};

type ThreadInfo = {
  latestId: string;
  counterpart: { email: string; name: string | null } | null;
  people: string[];
  own: Set<string>;
};

async function ownAddresses(db: Db, actor: UserActor) {
  const result = await db.query<{ email: string }>(
    "select lower(email) as email from crm.mail_sources where user_id = $1 union select lower(email) from crm.send_identities where user_id = $1",
    [actor.userId],
  );
  return new Set([...result.rows.map((row) => row.email), actor.email.toLowerCase()]);
}

async function threadInfo(db: Db, actor: UserActor, sourceId: string, key: string): Promise<ThreadInfo> {
  const result = await db.query<{ id: string; from_email: string | null; from_name: string | null; to_recipients: { address?: string; name?: string | null }[] | null; cc_recipients: { address?: string; name?: string | null }[] | null }>(
    `select m.id, m.from_email, m.from_name, m.to_recipients, m.cc_recipients
     from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id
     where m.user_id = $1 and m.source_id = $2 and coalesce(m.thread_key, 'm:' || m.id::text) = $3 and not m.is_draft and f.role <> 'outbox'
     order by coalesce(m.received_at, m.sent_at, m.created_at) asc, m.id asc
     limit 200`,
    [actor.userId, sourceId, key],
  );
  if (result.rows.length === 0) throw new CrmError("not_found", "Conversation not found.", 404);
  const own = await ownAddresses(db, actor);
  const people = new Map<string, string | null>();
  for (const row of result.rows) {
    for (const entry of [{ address: row.from_email ?? "", name: row.from_name }, ...(row.to_recipients ?? []), ...(row.cc_recipients ?? [])]) {
      const email = canonicalEmail(entry.address ?? "");
      if (!email || own.has(email) || people.has(email)) continue;
      people.set(email, entry.name?.trim() || null);
    }
  }
  const fromThem = result.rows.filter((row) => row.from_email && !own.has(row.from_email.toLowerCase()));
  const latest = fromThem.at(-1) ?? result.rows[result.rows.length - 1];
  const sender = fromThem.at(-1)?.from_email ? canonicalEmail(fromThem.at(-1)!.from_email!) : null;
  const first = [...people.keys()][0] ?? null;
  const counterpartEmail = sender ?? first;
  return {
    latestId: latest.id,
    counterpart: counterpartEmail ? { email: counterpartEmail, name: people.get(counterpartEmail) ?? null } : null,
    people: [...people.keys()],
    own,
  };
}

async function filingFor(actor: UserActor, actors: UserActor[], sourceId: string, key: string) {
  return withActor(actor, async (db) => {
    const info = await threadInfo(db, actor, sourceId, key);
    return threadFilingInDb(db, actor, actors, sourceId, key, { latestId: info.latestId, counterpart: info.counterpart?.email ?? null, own: info.own });
  });
}

async function threadMessagesFiledIn(actor: UserActor, sourceId: string, key: string, workspaceIds: string[]) {
  if (workspaceIds.length === 0) return [];
  return withActor(actor, async (db) => {
    const result = await db.query<{ workspace_id: string }>(
      `select distinct a.workspace_id from crm.activities a
       where a.workspace_id = any($4::uuid[]) and a.type = 'email' and a.metadata->>'mailMessageId' in (
         select m.id::text from crm.mail_messages m
         where m.user_id = $1 and m.source_id = $2 and coalesce(m.thread_key, 'm:' || m.id::text) = $3
       )`,
      [actor.userId, sourceId, key, workspaceIds],
    );
    return result.rows.map((row) => row.workspace_id);
  });
}

export async function threadBrand(actor: UserActor, sourceId: string, key: string): Promise<BrandProfile | null> {
  const actors = await workspaceActors(actor);
  if (actors.length < 2) return brandOrEmpty(actors[0] ?? actor);
  const effective = await withActor(actor, async (db) => {
    const info = await threadInfo(db, actor, sourceId, key);
    return effectiveFilingInDb(db, actor, actors, sourceId, key, { latestId: info.latestId, counterpart: info.counterpart?.email ?? null, own: info.own });
  }).catch(() => null);
  if (!effective || effective.filedIn.length !== 1) return null;
  return brandOrEmpty(actorIn(actors, effective.filedIn[0]));
}

export type FilingChange = { filing: ThreadFiling | null; kept: string[] };

export async function setThreadFiling(actor: UserActor, threadKey: string, workspaceIds: unknown): Promise<FilingChange> {
  const { sourceId, key } = parseRouteKey(threadKey);
  const actors = await workspaceActors(actor);
  const chosen = chosenWorkspaces(actors, workspaceIds);
  const before = await filingFor(actor, actors, sourceId, key);
  const info = await withActor(actor, (db) => threadInfo(db, actor, sourceId, key));
  const allIds = actors.map((item) => item.workspaceId);
  for (const id of chosen) {
    const target = actorIn(actors, id);
    await withActor(target, async (db) => {
      const known = await db.query(
        "select 1 from crm.contacts where workspace_id = $1 and archived_at is null and normalized_email = any($2::text[]) limit 1",
        [id, info.people],
      );
      if (known.rowCount || !info.counterpart) return;
      const copy = await contactElsewhere(db, info.counterpart.email, allIds, id);
      await ensureContactInDb(db, target, info.counterpart, copy, { operation: "file_mail_thread", source: "mail" });
    });
  }
  await withActor(actor, async (db) => {
    const route = await threadRoute(db, actor, sourceId, key);
    const contact = route?.contact_id
      ? (await db.query<{ workspace_id: string }>("select workspace_id from crm.contacts where id = $1", [route.contact_id])).rows[0]
      : undefined;
    const keepContact = !route?.contact_id || (contact !== undefined && chosen.includes(contact.workspace_id));
    await upsertRoute(db, actor, sourceId, key, { filedIn: chosen, ignored: false, ...(keepContact ? {} : { contactId: null }) });
  });
  await fileMailOnTimeline(actor, { filter: { thread: { sourceId, key } }, actors });
  const dropped = (before?.filedIn ?? []).filter((id) => !chosen.includes(id));
  const kept = await threadMessagesFiledIn(actor, sourceId, key, dropped);
  return {
    filing: await filingFor(actor, actors, sourceId, key),
    kept: actors.filter((item) => kept.includes(item.workspaceId)).map((item) => item.workspaceName),
  };
}

export async function setThreadDomainRule(actor: UserActor, threadKey: string, workspaceIds: unknown): Promise<FilingChange & { domain: string }> {
  const { sourceId, key } = parseRouteKey(threadKey);
  const info = await withActor(actor, (db) => threadInfo(db, actor, sourceId, key));
  const domain = filingDomain(info.counterpart?.email ?? null, info.own);
  if (!domain) {
    const shared = info.counterpart?.email.split("@")[1];
    throw new CrmError(
      "invalid_input",
      shared && FREE_MAIL_DOMAINS.has(shared) ? `Many people share @${shared}, so it can't have a rule.` : "This email has no company domain to make a rule for.",
      400,
      { field: "domain" },
    );
  }
  await setDomainRule(actor, domain, workspaceIds);
  const change = await setThreadFiling(actor, threadKey, workspaceIds);
  return { ...change, domain };
}

export type AddedPerson = { contactId: string; companyId: string | null; companyName: string | null; title: string | null };

export async function addPersonHere(actor: UserActor, threadKey: string, emailValue: string): Promise<AddedPerson & { filing: ThreadFiling | null }> {
  assertScope(actor.scopes, "contacts:write");
  const { sourceId, key } = parseRouteKey(threadKey);
  const email = canonicalEmail(emailValue);
  if (!email) throw new CrmError("invalid_input", "That email address isn't valid.", 400, { field: "email" });
  const actors = await workspaceActors(actor);
  const allIds = actors.map((item) => item.workspaceId);
  const added = await withActor(actor, async (db) => {
    const info = await threadInfo(db, actor, sourceId, key);
    if (!info.people.includes(email)) throw new CrmError("not_found", "They aren't on this conversation.", 404, { field: "email" });
    const effective =
      actors.length > 1
        ? await effectiveFilingInDb(db, actor, actors, sourceId, key, { latestId: info.latestId, counterpart: info.counterpart?.email ?? null, own: info.own })
        : null;
    const copy = await contactElsewhere(db, email, allIds, actor.workspaceId);
    const saved = await ensureContactInDb(db, actor, { email, name: null }, copy, { operation: "add_from_workspace", source: "mail" });
    if (effective && !effective.filedIn.includes(actor.workspaceId)) {
      const filedIn = effective.basis === "capture" ? [actor.workspaceId] : [...effective.filedIn, actor.workspaceId];
      await upsertRoute(db, actor, sourceId, key, { filedIn: allIds.filter((id) => filedIn.includes(id)), ignored: false });
    }
    const row = await db.query<{ company_id: string | null; company_name: string | null; job_title: string | null }>(
      "select c.company_id, co.name as company_name, c.job_title from crm.contacts c left join crm.companies co on co.id = c.company_id where c.id = $1",
      [saved.contactId],
    );
    return { contactId: saved.contactId, companyId: row.rows[0]?.company_id ?? null, companyName: row.rows[0]?.company_name ?? null, title: row.rows[0]?.job_title ?? null };
  });
  await fileMailOnTimeline(actor, { filter: { thread: { sourceId, key } }, actors });
  return { ...added, filing: await filingFor(actor, actors, sourceId, key) };
}

export async function unknownMail(actor: UserActor, actors: UserActor[], now = Date.now()): Promise<UnknownEmail[]> {
  const workspaceIds = actors.map((item) => item.workspaceId);
  return withActor(actor, async (db) => {
    const homes = await addressHomesInDb(db, actor);
    const capture = captureWorkspaceSql("n", "n", "$6", "$3");
    const result = await db.query<{
      id: string;
      source_id: string;
      tk: string;
      subject: string | null;
      snippet: string | null;
      from_email: string;
      from_name: string | null;
      at: Date;
      received_by: string;
      capture_workspace_id: string;
    }>(
      `with own as (
         ${ownAddressesSql("$1", "$2")}
       ),
       own_domains as (
         select distinct split_part(x.e, '@', 2) as domain
         from (
           select email as e from own
           union select lower(p.email) from crm.workspace_members wm join crm.profiles p on p.id = wm.user_id where wm.workspace_id = any($3::uuid[])
         ) x
         where x.e like '%@%' and split_part(x.e, '@', 2) <> all($4::text[])
       ),
       inbound as (
         select m.id, m.source_id, coalesce(m.thread_key, 'm:' || m.id::text) as tk, coalesce(m.received_at, m.created_at) as at
         from crm.mail_messages m
         join crm.mail_folders f on f.id = m.folder_id
         where m.user_id = $1 and not m.is_draft and f.role in ('inbox', 'archive', 'snoozed')
           and (m.received_at >= $5 or (m.received_at is null and m.created_at >= $5))
           and nullif(m.from_email, '') is not null
           and lower(m.from_email) not in (select email from own)
       ),
       latest as materialized (
         select distinct on (i.source_id, i.tk) i.id, i.source_id, i.tk, i.at from inbound i order by i.source_id, i.tk, i.at desc
       ),
       candidates as materialized (
         select l.id, l.source_id, l.tk, l.at, m.subject, m.snippet, lower(m.from_email) as from_email, m.from_name, m.focused,
           m.to_recipients, m.cc_recipients, s.email as account, s.workspace_id as source_workspace, rt.capture_workspace_id
         from latest l
         join crm.mail_messages m on m.id = l.id
         join crm.mail_sources s on s.id = l.source_id
         left join crm.mail_thread_routes rt on rt.user_id = $1 and rt.source_id = l.source_id and rt.thread_key = l.tk
         where rt.ignored_at is null and rt.filed_in is null and rt.contact_id is null
           and ${NOT_AUTOMATED("lower(m.from_email)")}
           and split_part(lower(m.from_email), '@', 2) not in (select domain from own_domains)
           and not exists (
             select 1 from crm.contacts c
             where c.workspace_id = any($3::uuid[]) and c.archived_at is null and c.normalized_email = lower(m.from_email)
           )
           and not (
             split_part(lower(m.from_email), '@', 2) <> all($4::text[])
             and exists (
               select 1 from crm.companies co
               where co.workspace_id = any($3::uuid[]) and co.archived_at is null and co.domain = split_part(lower(m.from_email), '@', 2)
             )
           )
           and not exists (
             select 1 from crm.mail_subscriptions ms
             where ms.user_id = $1 and (ms.sender = lower(m.from_email) or ms.sender = '@' || split_part(lower(m.from_email), '@', 2))
               and (ms.status <> 'subscribed' or ms.cold_pitch_at is not null or ms.list_unsubscribe is not null)
           )
           and not exists (
             select 1 from crm.mail_prepared p
             where p.user_id = $1 and p.source_id = l.source_id and p.thread_key = l.tk and p.kind = 'pitch' and p.state = 'ready'
           )
           and not exists (
             select 1 from crm.mail_messages o join crm.mail_folders ofo on ofo.id = o.folder_id
             where o.source_id = l.source_id and o.thread_key = l.tk and ofo.role = 'sent' and coalesce(o.sent_at, o.created_at) > l.at
           )
       )
       select n.id, n.source_id, n.tk, n.subject, n.snippet, n.from_email, n.from_name, n.at,
         ${capture.received} as received_by, ${capture.workspace} as capture_workspace_id
       from (
         select n.* from candidates n
         ${splitJoin("n", "$1")}
         where ${splitCase("n")} = 'important'
         order by n.at desc
         offset 0
       ) n
       where not exists (
         select 1 from crm.mail_messages b where b.id = n.id and right(coalesce(b.body_text, ''), 4000) ~* '${UNSUBSCRIBE_TEXT}'
       )
       limit ${CAPTURE_SCAN}`,
      [actor.userId, actor.email, workspaceIds, [...FREE_MAIL_DOMAINS], captureCutoff(now), homesJson(homes)],
    );
    const rows = result.rows.sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime());
    return rows.map((row) => ({
      key: `${row.source_id}|${row.tk}`,
      messageId: row.id,
      name: row.from_name?.trim() || null,
      email: row.from_email,
      address: row.received_by,
      subject: row.subject,
      snippet: row.snippet,
      at: new Date(row.at).toISOString(),
      workspaceId: workspaceIds.includes(row.capture_workspace_id) ? row.capture_workspace_id : workspaceIds[0],
    }));
  });
}

const requestUnknown = cache(() => new Map<string, Promise<UnknownEmail[]>>());

export function unknownMailOnce(actor: UserActor, actors: UserActor[], now = Date.now()) {
  const store = requestUnknown();
  const key = `${actor.userId}|${actors.map((item) => item.workspaceId).join(",")}`;
  const found = store.get(key);
  if (found) return found;
  const pending = unknownMail(actor, actors, now);
  store.set(key, pending);
  pending.catch(() => store.delete(key));
  return pending;
}

export async function listUnknownMail(actor: UserActor, now = Date.now(), known?: { actors: UserActor[]; emails: UnknownEmail[] }) {
  const actors = known?.actors ?? (await workspaceActors(actor));
  const rows = known?.emails ?? (await unknownMailOnce(actor, actors, now));
  const here = rows.filter((row) => row.workspaceId === actor.workspaceId);
  return { emails: here.slice(0, CAPTURE_SHOWN), total: here.length, workspaces: refs(actors) };
}

export async function ignoreUnknownMail(actor: UserActor, threadKey: string) {
  const { sourceId, key } = parseRouteKey(threadKey);
  await withActor(actor, (db) => upsertRoute(db, actor, sourceId, key, { ignored: true }));
  return { key: threadKey };
}

export async function moveUnknownMail(actor: UserActor, threadKey: string, workspaceId: string) {
  const { sourceId, key } = parseRouteKey(threadKey);
  if (!isUuid(workspaceId)) throw new CrmError("invalid_input", "Choose one of your workspaces.", 400, { field: "workspaceId" });
  const actors = await workspaceActors(actor);
  const target = actorIn(actors, workspaceId);
  await withActor(actor, (db) => upsertRoute(db, actor, sourceId, key, { captureWorkspaceId: workspaceId }));
  return { key: threadKey, workspace: { id: target.workspaceId, name: target.workspaceName } };
}

export async function createAndFileUnknown(actor: UserActor, threadKey: string) {
  const { sourceId, key } = parseRouteKey(threadKey);
  const actors = await workspaceActors(actor);
  const saved = await withActor(actor, async (db) => {
    const info = await threadInfo(db, actor, sourceId, key);
    if (!info.counterpart) throw new CrmError("not_found", "There's nobody on this email to add.", 404);
    const result = await ensureContactInDb(db, actor, info.counterpart, null, { operation: "create_from_email", source: "mail" });
    const name = await db.query<{ name: string | null }>(
      "select coalesce(nullif(trim(concat_ws(' ', first_name, last_name)), ''), email) as name from crm.contacts where id = $1",
      [result.contactId],
    );
    return { contactId: result.contactId, contactName: name.rows[0]?.name ?? info.counterpart.email };
  });
  await fileMailOnTimeline(actor, { filter: { thread: { sourceId, key } }, actors });
  return saved;
}

export async function fileUnknownTo(actor: UserActor, threadKey: string, contactId: string) {
  const { sourceId, key } = parseRouteKey(threadKey);
  if (!isUuid(contactId)) throw new CrmError("not_found", "That contact has gone.", 404);
  const actors = await workspaceActors(actor);
  const saved = await withActor(actor, async (db) => {
    const contact = await db.query<{ name: string | null }>(
      `select coalesce(nullif(trim(concat_ws(' ', first_name, last_name)), ''), email) as name from crm.contacts
       where id = $1 and workspace_id = $2 and archived_at is null`,
      [contactId, actor.workspaceId],
    );
    if (!contact.rows[0]) throw new CrmError("not_found", "That contact has gone.", 404);
    await threadInfo(db, actor, sourceId, key);
    await upsertRoute(db, actor, sourceId, key, { filedIn: [actor.workspaceId], contactId, ignored: false });
    return { contactId, contactName: contact.rows[0].name };
  });
  await fileMailOnTimeline(actor, { filter: { thread: { sourceId, key } }, actors });
  return saved;
}
