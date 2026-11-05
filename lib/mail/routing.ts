import { upsertCompanyInDb } from "@/lib/crm/companies";
import { upsertContactInDb } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { FREE_MAIL_DOMAINS, isFreeMailDomain } from "@/lib/crm/communications";
import { companyNameFromDomain, internalAddresses } from "@/lib/crm/conversations";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import { canonicalDomain, canonicalEmail } from "@/lib/crm/normalize";
import { assertScope } from "@/lib/crm/scopes";
import type { Provenance, UserActor } from "@/lib/crm/types";
import { workspaceActors, type WorkspaceRef } from "@/lib/crm/workspaces";
import type { Db } from "@/lib/db/pool";
import { AUTOMATED_DOMAIN, AUTOMATED_SENDER } from "@/lib/mail/split";
import type { ThreadFiling } from "@/lib/mail/view";

export const SKIPPED_ROLES = ["drafts", "junk", "outbox"];

export type AddressHome = {
  address: string;
  kind: "mailbox" | "sending";
  defaultWorkspaceId: string;
  workspaceId: string;
};

export type DomainRule = { domain: string; workspaceIds: string[] };

type HomeRow = { address: string; kind: "mailbox" | "sending"; default_id: string; chosen_id: string | null };

export function refs(actors: UserActor[]): WorkspaceRef[] {
  return actors.map((item) => ({ id: item.workspaceId, name: item.workspaceName }));
}

export async function addressHomesInDb(db: Db, actor: UserActor): Promise<AddressHome[]> {
  const result = await db.query<HomeRow>(
    `select lower(s.email) as address, 'mailbox' as kind, s.workspace_id as default_id, h.workspace_id as chosen_id, 0 as rank, s.created_at
     from crm.mail_sources s
     left join crm.mail_address_homes h on h.user_id = s.user_id and h.address = lower(s.email)
     where s.user_id = $1
     union all
     select lower(i.email), 'sending', i.workspace_id, h.workspace_id, 1, i.created_at
     from crm.send_identities i
     left join crm.mail_address_homes h on h.user_id = i.user_id and h.address = lower(i.email)
     where i.user_id = $1
     order by rank, created_at`,
    [actor.userId],
  );
  const seen = new Map<string, AddressHome>();
  for (const row of result.rows) {
    if (seen.has(row.address)) continue;
    seen.set(row.address, { address: row.address, kind: row.kind, defaultWorkspaceId: row.default_id, workspaceId: row.chosen_id ?? row.default_id });
  }
  return [...seen.values()];
}

export async function listAddressHomes(actor: UserActor) {
  return withActor(actor, (db) => addressHomesInDb(db, actor));
}

export function homesJson(homes: AddressHome[]) {
  return JSON.stringify(homes.map((home) => ({ address: home.address, workspace_id: home.workspaceId })));
}

export async function setAddressHome(actor: UserActor, address: string, workspaceId: string) {
  const actors = await workspaceActors(actor);
  if (!actors.some((item) => item.workspaceId === workspaceId)) {
    throw new CrmError("forbidden", "Choose a workspace you're in.", 403, { field: "workspaceId" });
  }
  const wanted = canonicalEmail(address);
  return withActor(actor, async (db) => {
    const homes = await addressHomesInDb(db, actor);
    const home = homes.find((item) => item.address === wanted);
    if (!home) throw new CrmError("not_found", "That address isn't one of your mail accounts.", 404, { field: "address" });
    if (workspaceId === home.defaultWorkspaceId) {
      await db.query("delete from crm.mail_address_homes where user_id = $1 and address = $2", [actor.userId, home.address]);
    } else {
      await db.query(
        `insert into crm.mail_address_homes (workspace_id, user_id, address) values ($1, $2, $3)
         on conflict (user_id, address) do update set workspace_id = excluded.workspace_id, updated_at = now()`,
        [workspaceId, actor.userId, home.address],
      );
    }
    return { ...home, workspaceId };
  });
}

export function ruleDomain(value: string) {
  const domain = canonicalDomain(value.trim().replace(/^@/, ""));
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    throw new CrmError("invalid_input", "Choose a domain such as @company.com.", 400, { field: "domain" });
  }
  if (isFreeMailDomain(domain)) {
    throw new CrmError("invalid_input", `Many people share @${domain}, so it can't have a rule. File each email on its own.`, 400, { field: "domain" });
  }
  return domain;
}

export async function listDomainRules(actor: UserActor): Promise<DomainRule[]> {
  return withActor(actor, async (db) => {
    const result = await db.query<{ domain: string; workspace_ids: string[] }>(
      "select domain, workspace_ids from crm.mail_domain_rules where user_id = $1 order by domain",
      [actor.userId],
    );
    return result.rows.map((row) => ({ domain: row.domain, workspaceIds: row.workspace_ids }));
  });
}

export function chosenWorkspaces(actors: UserActor[], ids: unknown) {
  const wanted = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  const chosen = actors.filter((item) => wanted.includes(item.workspaceId)).map((item) => item.workspaceId);
  if (chosen.length === 0 || chosen.length !== new Set(wanted).size) {
    throw new CrmError("invalid_input", "Choose one or more of your workspaces.", 400, { field: "workspaceIds" });
  }
  return chosen;
}

export async function setDomainRule(actor: UserActor, domainValue: string, workspaceIds: unknown): Promise<DomainRule> {
  const domain = ruleDomain(domainValue);
  const actors = await workspaceActors(actor);
  const chosen = chosenWorkspaces(actors, workspaceIds);
  await withActor(actor, (db) =>
    db.query(
      `insert into crm.mail_domain_rules (workspace_id, user_id, domain, workspace_ids) values ($1, $2, $3, $4::uuid[])
       on conflict (user_id, domain) do update set workspace_ids = excluded.workspace_ids, updated_at = now()`,
      [actor.workspaceId, actor.userId, domain, chosen],
    ),
  );
  return { domain, workspaceIds: chosen };
}

export async function removeDomainRule(actor: UserActor, domainValue: string) {
  const domain = canonicalDomain(domainValue.trim().replace(/^@/, "")) ?? "";
  await withActor(actor, (db) => db.query("delete from crm.mail_domain_rules where user_id = $1 and domain = $2", [actor.userId, domain]));
  return { domain };
}

const OWN = `own as (
  select lower(email) as email from crm.mail_sources where user_id = $1
  union select lower(email) from crm.send_identities where user_id = $1
  union select lower($2::text)
)`;

export function routedSql(filter: string) {
  return `with ${OWN},
  recent as (
    select m.id, m.source_id, coalesce(m.thread_key, 'm:' || m.id::text) as tk, m.internet_message_id, m.subject, m.snippet, m.body_text,
      m.from_email, m.to_recipients, m.cc_recipients, m.has_attachments, s.email as account, f.role as folder_role,
      coalesce(m.sent_at, m.received_at, m.created_at) as at,
      lower(coalesce(m.from_email, '')) in (select email from own) as mine
    from crm.mail_messages m
    join crm.mail_folders f on f.id = m.folder_id
    join crm.mail_sources s on s.id = m.source_id
    where m.user_id = $1 and not m.is_draft and f.role <> all($5::text[]) and (${filter})
  ),
  pairs as (
    select r.*, 'inbound'::text as direction, lower(r.from_email) as address
    from recent r where not r.mine and r.from_email is not null
    union all
    select r.*, 'outbound'::text, lower(p->>'address')
    from recent r, jsonb_array_elements(coalesce(r.to_recipients, '[]'::jsonb) || coalesce(r.cc_recipients, '[]'::jsonb)) p
    where r.mine and jsonb_typeof(p) = 'object'
  ),
  targeted as (
    select p.*, rt.filed_in as chosen, rt.contact_id as route_contact, rl.workspace_ids as ruled, rl.updated_at as ruled_at,
      coalesce(rt.filed_in, rl.workspace_ids, $3::uuid[]) as allowed
    from pairs p
    left join crm.mail_thread_routes rt on rt.user_id = $1 and rt.source_id = p.source_id and rt.thread_key = p.tk
    left join crm.mail_domain_rules rl on rl.user_id = $1 and rl.domain = split_part(p.address, '@', 2)
    where p.address like '_%@_%' and p.address not in (select email from own)
  ),
  matched as (
    select t.*, c.workspace_id, c.id as contact_id, c.normalized_email as contact_email, c.company_id
    from targeted t
    join crm.contacts c on c.workspace_id = any($3::uuid[]) and c.archived_at is null and c.normalized_email = t.address
    where c.workspace_id = any(t.allowed)
    union all
    select t.*, c.workspace_id, c.id, c.normalized_email, c.company_id
    from targeted t
    join crm.contacts c on c.id = t.route_contact and c.archived_at is null and c.workspace_id = any($3::uuid[])
    where t.direction = 'inbound'
      and not exists (
        select 1 from crm.contacts c2 where c2.workspace_id = c.workspace_id and c2.archived_at is null and c2.normalized_email = t.address
      )
    union all
    select t.*, co.workspace_id, null::uuid, null::text, co.id
    from targeted t
    join crm.companies co on co.workspace_id = any($3::uuid[]) and co.archived_at is null and co.domain = split_part(t.address, '@', 2)
    where t.direction = 'inbound' and split_part(t.address, '@', 2) <> all($4::text[]) and co.workspace_id = any(t.allowed)
      and not exists (
        select 1 from crm.contacts c2 where c2.workspace_id = co.workspace_id and c2.archived_at is null and c2.normalized_email = t.address
      )
      and not exists (select 1 from crm.contacts rc where rc.id = t.route_contact and rc.workspace_id = co.workspace_id)
  )`;
}

export function routedParams(actor: UserActor, workspaceIds: string[], extra: unknown[]) {
  return [actor.userId, actor.email, workspaceIds, [...FREE_MAIL_DOMAINS], SKIPPED_ROLES, ...extra];
}

export const NOT_AUTOMATED = (column: string) => `(${column} !~* '${AUTOMATED_SENDER}' and ${column} !~* '${AUTOMATED_DOMAIN}')`;

export function captureWorkspaceSql(alias: string, routeAlias: string, homesParam: string, mineParam: string) {
  const received = `coalesce(
    (select lower(r->>'address') from jsonb_array_elements(coalesce(${alias}.to_recipients, '[]'::jsonb) || coalesce(${alias}.cc_recipients, '[]'::jsonb)) r
     where jsonb_typeof(r) = 'object' and lower(r->>'address') in (select h.address from jsonb_to_recordset(${homesParam}::jsonb) as h(address text, workspace_id uuid))
     limit 1),
    lower(${alias}.account)
  )`;
  return {
    received,
    workspace: `coalesce(
      case when ${routeAlias}.capture_workspace_id = any(${mineParam}::uuid[]) then ${routeAlias}.capture_workspace_id end,
      (select dr.workspace_ids[1] from crm.mail_domain_rules dr where dr.user_id = $1 and dr.domain = split_part(lower(${alias}.from_email), '@', 2)),
      (select h.workspace_id from jsonb_to_recordset(${homesParam}::jsonb) as h(address text, workspace_id uuid) where h.address = ${received}),
      ${alias}.source_workspace
    )`,
  };
}

type PersonSource = {
  first_name: string | null;
  last_name: string | null;
  job_title: string | null;
  linkedin_url: string | null;
  company_domain: string | null;
  company_name: string | null;
};

function splitName(name: string | null) {
  const text = name?.trim() ?? "";
  if (!text || canonicalEmail(text)) return { firstName: null, lastName: null };
  const parts = text.split(/\s+/).filter(Boolean);
  return { firstName: parts[0]?.slice(0, 80) ?? null, lastName: parts.slice(1).join(" ").slice(0, 80) || null };
}

export async function contactElsewhere(db: Db, email: string, workspaceIds: string[], exclude: string) {
  const result = await db.query<PersonSource>(
    `select c.first_name, c.last_name, c.job_title, c.linkedin_url, co.domain as company_domain, co.name as company_name
     from crm.contacts c
     left join crm.companies co on co.id = c.company_id and co.archived_at is null
     where c.normalized_email = $1 and c.workspace_id = any($2::uuid[]) and c.workspace_id <> $3 and c.archived_at is null
     order by c.updated_at desc
     limit 1`,
    [email, workspaceIds, exclude],
  );
  return result.rows[0] ?? null;
}

export async function ensureContactInDb(
  db: Db,
  actor: UserActor,
  person: { email: string; name: string | null },
  copyFrom: PersonSource | null,
  provenance: Provenance,
) {
  assertScope(actor.scopes, "contacts:write");
  const email = canonicalEmail(person.email);
  if (!email) throw new CrmError("invalid_input", "That email address isn't valid.", 400, { field: "email" });
  const existing = await db.query<{ id: string }>(
    "select id from crm.contacts where workspace_id = $1 and archived_at is null and normalized_email = $2 limit 1",
    [actor.workspaceId, email],
  );
  if (existing.rows[0]) return { contactId: existing.rows[0].id, created: false };
  const internal = await internalAddresses(db, actor.workspaceId, [actor.email]);
  if (internal.isInternal(email)) {
    throw new CrmError("invalid_input", "That address belongs to you or your workspace, so it can't become a contact.", 400, { field: "email" });
  }
  const emailDomain = email.split("@")[1] ?? "";
  const domain = copyFrom?.company_domain || (emailDomain && !isFreeMailDomain(emailDomain) ? emailDomain : null);
  let companyId: string | null = null;
  if (domain) {
    const found = await db.query<{ id: string }>(
      "select id from crm.companies where workspace_id = $1 and archived_at is null and domain = $2 order by updated_at desc limit 1",
      [actor.workspaceId, domain],
    );
    companyId = found.rows[0]?.id ?? null;
    if (!companyId) {
      assertScope(actor.scopes, "companies:write");
      companyId = (
        await upsertCompanyInDb(db, actor, { name: copyFrom?.company_name || companyNameFromDomain(domain), domain, source: "email" }, provenance)
      ).company.id;
    }
  }
  const names = copyFrom && (copyFrom.first_name || copyFrom.last_name) ? { firstName: copyFrom.first_name, lastName: copyFrom.last_name } : splitName(person.name);
  const saved = await upsertContactInDb(
    db,
    actor,
    {
      ...names,
      email,
      companyId,
      jobTitle: copyFrom?.job_title ?? null,
      linkedinUrl: copyFrom?.linkedin_url ?? null,
      ownerId: actor.userId,
      source: "email",
    },
    provenance,
  );
  return { contactId: saved.contact.id, created: saved.created };
}

export function parseRouteKey(value: string) {
  const split = value.indexOf("|");
  const sourceId = split > 0 ? value.slice(0, split) : "";
  const key = split > 0 ? value.slice(split + 1) : "";
  if (!isUuid(sourceId) || !key || key.length > 450) throw new CrmError("not_found", "Conversation not found.", 404);
  return { sourceId, key };
}

export async function upsertRoute(
  db: Db,
  actor: UserActor,
  sourceId: string,
  key: string,
  values: { filedIn?: string[] | null; captureWorkspaceId?: string | null; ignored?: boolean; contactId?: string | null },
) {
  const source = await db.query("select 1 from crm.mail_sources where id = $1 and user_id = $2", [sourceId, actor.userId]);
  if (!source.rowCount) throw new CrmError("not_found", "Conversation not found.", 404);
  await db.query(
    `insert into crm.mail_thread_routes (workspace_id, user_id, source_id, thread_key, filed_in, capture_workspace_id, ignored_at, contact_id)
     values ($1, $2, $3, $4, $5::uuid[], $6, case when $7 then now() end, $8)
     on conflict (user_id, source_id, thread_key) do update set
       filed_in = case when $9 then excluded.filed_in else crm.mail_thread_routes.filed_in end,
       capture_workspace_id = case when $10 then excluded.capture_workspace_id else crm.mail_thread_routes.capture_workspace_id end,
       ignored_at = case when $11 then excluded.ignored_at else crm.mail_thread_routes.ignored_at end,
       contact_id = case when $12 then excluded.contact_id else crm.mail_thread_routes.contact_id end,
       updated_at = now()`,
    [
      actor.workspaceId,
      actor.userId,
      sourceId,
      key,
      values.filedIn ?? null,
      values.captureWorkspaceId ?? null,
      Boolean(values.ignored),
      values.contactId ?? null,
      values.filedIn !== undefined,
      values.captureWorkspaceId !== undefined,
      values.ignored !== undefined,
      values.contactId !== undefined,
    ],
  );
}

export async function threadRoute(db: Db, actor: UserActor, sourceId: string, key: string) {
  const result = await db.query<{ filed_in: string[] | null; capture_workspace_id: string | null; ignored_at: Date | null; contact_id: string | null }>(
    "select filed_in, capture_workspace_id, ignored_at, contact_id from crm.mail_thread_routes where user_id = $1 and source_id = $2 and thread_key = $3",
    [actor.userId, sourceId, key],
  );
  return result.rows[0] ?? null;
}


export async function captureWorkspaces(db: Db, actor: UserActor, homes: AddressHome[], workspaceIds: string[], messageIds: string[]) {
  if (messageIds.length === 0) return new Map<string, string>();
  const capture = captureWorkspaceSql("n", "rt", "$3", "$4");
  const result = await db.query<{ id: string; workspace_id: string }>(
    `select n.id, ${capture.workspace} as workspace_id
     from (
       select m.id, m.source_id, coalesce(m.thread_key, 'm:' || m.id::text) as tk, m.from_email, m.to_recipients, m.cc_recipients,
         s.email as account, s.workspace_id as source_workspace
       from crm.mail_messages m join crm.mail_sources s on s.id = m.source_id
       where m.user_id = $1 and m.id = any($2::uuid[])
     ) n
     left join crm.mail_thread_routes rt on rt.user_id = $1 and rt.source_id = n.source_id and rt.thread_key = n.tk`,
    [actor.userId, messageIds, homesJson(homes), workspaceIds],
  );
  return new Map(result.rows.map((row) => [row.id, row.workspace_id]));
}

export function filingDomain(address: string | null, own: Set<string>) {
  const domain = address?.split("@")[1]?.toLowerCase() ?? "";
  if (!domain || isFreeMailDomain(domain)) return null;
  if ([...own].some((email) => email.endsWith(`@${domain}`))) return null;
  return domain;
}

export async function threadFilingInDb(
  db: Db,
  actor: UserActor,
  actors: UserActor[],
  sourceId: string,
  key: string,
  input: { latestId: string; counterpart: string | null; own: Set<string> },
): Promise<ThreadFiling | null> {
  if (actors.length < 2) return null;
  const workspaceIds = actors.map((item) => item.workspaceId);
  const domain = filingDomain(input.counterpart, input.own);
  const route = await threadRoute(db, actor, sourceId, key);
  const ruleRow = domain
    ? (await db.query<{ workspace_ids: string[] }>("select workspace_ids from crm.mail_domain_rules where user_id = $1 and domain = $2", [actor.userId, domain])).rows[0]
    : undefined;
  const rule = ruleRow ? ruleRow.workspace_ids.filter((id) => workspaceIds.includes(id)) : null;
  const chosen = route?.filed_in?.filter((id) => workspaceIds.includes(id)) ?? [];
  let filedIn = chosen.length ? chosen : rule?.length ? rule : [];
  if (filedIn.length === 0) {
    const matched = await db.query<{ workspace_id: string }>(
      `${routedSql("m.source_id = $6 and coalesce(m.thread_key, 'm:' || m.id::text) = $7")}
       select distinct x.workspace_id from matched x`,
      routedParams(actor, workspaceIds, [sourceId, key]),
    );
    filedIn = matched.rows.map((row) => row.workspace_id);
  }
  if (filedIn.length === 0) {
    const homes = await addressHomesInDb(db, actor);
    const capture = await captureWorkspaces(db, actor, homes, workspaceIds, [input.latestId]);
    filedIn = [capture.get(input.latestId) ?? actor.workspaceId];
  }
  return {
    active: { id: actor.workspaceId, name: actor.workspaceName },
    workspaces: refs(actors),
    filedIn: workspaceIds.filter((id) => filedIn.includes(id)),
    chosen: chosen.length > 0,
    domain,
    rule: rule?.length ? rule : null,
  };
}

export async function routedAway(db: Db, userId: string, workspaceId: string, conversationId: string | null | undefined, fromEmail: string | null | undefined) {
  const result = await db.query<{ away: boolean | null }>(
    `select coalesce(
       (select not ($2::uuid = any(rt.filed_in)) from crm.mail_thread_routes rt
        where rt.user_id = $1 and rt.thread_key = $3 and rt.filed_in is not null
        order by rt.updated_at desc limit 1),
       (select not ($2::uuid = any(rl.workspace_ids)) from crm.mail_domain_rules rl
        where rl.user_id = $1 and rl.domain = split_part(lower($4::text), '@', 2)),
       false
     ) as away`,
    [userId, workspaceId, conversationId ?? "", fromEmail ?? ""],
  );
  return Boolean(result.rows[0]?.away);
}
