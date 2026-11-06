import { isFreeMailDomain } from "@/lib/crm/communications";
import { internalAddresses, type Participant } from "@/lib/crm/conversations";
import { CrmError, isPgError } from "@/lib/crm/errors";
import { matchParties, type PartyMatch } from "@/lib/crm/inbox";
import { withActor } from "@/lib/crm/context";
import { isUuid } from "@/lib/crm/mutate";
import { canonicalEmail } from "@/lib/crm/normalize";
import { assertScope } from "@/lib/crm/scopes";
import { actorIn, workspaceActors } from "@/lib/crm/workspaces";
import type { UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { query } from "@/lib/db/pool";
import { AUTOMATED_DOMAIN, AUTOMATED_SENDER } from "@/lib/mail/split";
import { addressHomesInDb } from "@/lib/mail/routing";

const RULE_GRACE_MS = 5 * 60 * 1000;

export type CallTarget = { actor: UserActor; match: PartyMatch };
export type RuledPerson = { workspaceId: string; email: string; name: string | null };
export type CallRoute = { targets: CallTarget[]; ruled: RuledPerson[] };

type Rule = { domain: string; workspaceIds: string[]; updatedAt: number };

const automated = [new RegExp(AUTOMATED_SENDER, "i"), new RegExp(AUTOMATED_DOMAIN, "i")];

function isAutomated(email: string) {
  return automated.some((pattern) => pattern.test(email));
}

export async function ownCallAddresses(db: Db, owner: UserActor, extra: (string | null | undefined)[] = []) {
  const result = await db.query<{ email: string }>(
    `select lower(email) as email from crm.mail_sources where user_id = $1
     union select lower(email) from crm.send_identities where user_id = $1
     union select lower(email) from crm.mailbox_connections where user_id = $1 and email is not null
     union select lower(email) from crm.calendar_accounts where user_id = $1 and email is not null`,
    [owner.userId],
  );
  const own = new Set(result.rows.map((row) => row.email));
  for (const value of [owner.email, ...extra]) {
    const email = value ? canonicalEmail(value) : null;
    if (email) own.add(email);
  }
  return own;
}

async function rulesFor(db: Db, owner: UserActor, workspaceIds: string[]) {
  const result = await db.query<{ domain: string; workspace_ids: string[]; updated_at: Date }>(
    "select domain, workspace_ids, updated_at from crm.mail_domain_rules where user_id = $1",
    [owner.userId],
  );
  return new Map<string, Rule>(
    result.rows.map((row) => [
      row.domain,
      { domain: row.domain, workspaceIds: row.workspace_ids.filter((id) => workspaceIds.includes(id)), updatedAt: new Date(row.updated_at).getTime() },
    ]),
  );
}

function domainOf(email: string) {
  return email.split("@")[1]?.toLowerCase() ?? "";
}

function personName(person: Participant) {
  const name = person.name?.replace(/\s+/g, " ").trim() ?? "";
  if (!name || canonicalEmail(name) || name.split(" ").length < 2 || name.length > 160) return null;
  return name.toLowerCase();
}

async function memberNames(db: Db, workspaceId: string) {
  const result = await db.query<{ name: string | null }>(
    `select lower(regexp_replace(btrim(p.full_name), '\\s+', ' ', 'g')) as name
     from crm.workspace_members m join crm.profiles p on p.id = m.user_id
     where m.workspace_id = $1 and p.full_name is not null`,
    [workspaceId],
  );
  return new Set(result.rows.map((row) => row.name).filter((name): name is string => Boolean(name)));
}

async function matchByName(db: Db, workspaceId: string, names: string[]): Promise<PartyMatch | null> {
  for (const name of names) {
    const result = await db.query<{ id: string; company_id: string | null; name: string }>(
      `select c.id, c.company_id, coalesce(nullif(trim(concat_ws(' ', c.first_name, c.last_name)), ''), c.email) as name
       from crm.contacts c
       where c.workspace_id = $1 and c.archived_at is null
         and lower(regexp_replace(btrim(concat_ws(' ', c.first_name, c.last_name)), '\\s+', ' ', 'g')) = $2
       limit 2`,
      [workspaceId, name],
    );
    if (result.rows.length !== 1) continue;
    const contact = result.rows[0];
    const company = contact.company_id
      ? (await db.query<{ name: string }>("select name from crm.companies where id = $1", [contact.company_id])).rows[0]?.name ?? null
      : null;
    return { contactId: contact.id, contactName: contact.name, companyId: contact.company_id, companyName: company };
  }
  return null;
}

export async function routeCallInDb(
  db: Db,
  owner: UserActor,
  actors: UserActor[],
  people: Participant[],
  options: { own?: Set<string>; occurredAt?: string | null; names?: boolean } = {},
): Promise<CallRoute> {
  const workspaceIds = actors.map((item) => item.workspaceId);
  const own = options.own ?? (await ownCallAddresses(db, owner));
  const rules = await rulesFor(db, owner, workspaceIds);
  const occurred = options.occurredAt ? new Date(options.occurredAt).getTime() : Date.now();
  const emails: { email: string; name: string | null }[] = [];
  const seen = new Set<string>();
  for (const person of people) {
    const email = person.email ? canonicalEmail(person.email) : null;
    if (!email || own.has(email) || seen.has(email)) continue;
    seen.add(email);
    emails.push({ email, name: person.name?.trim() || null });
  }
  const names = options.names
    ? [...new Set(people.filter((person) => !person.email).map(personName).filter((name): name is string => Boolean(name)))]
    : [];
  const targets: CallTarget[] = [];
  const ruled: RuledPerson[] = [];
  for (const actor of actors) {
    const internal = await internalAddresses(db, actor.workspaceId, [...own]);
    const outside = emails.filter((item) => !internal.isInternal(item.email));
    const allowed = outside.filter((item) => {
      const rule = rules.get(domainOf(item.email));
      return !rule || rule.workspaceIds.includes(actor.workspaceId);
    });
    let match = await matchParties(db, actor.workspaceId, allowed.map((item) => item.email));
    if (!match.contactId && !match.companyId && names.length > 0) {
      const members = await memberNames(db, actor.workspaceId);
      match = (await matchByName(db, actor.workspaceId, names.filter((name) => !members.has(name)))) ?? match;
    }
    for (const item of allowed) {
      const domain = domainOf(item.email);
      const rule = rules.get(domain);
      if (!rule || isFreeMailDomain(domain) || isAutomated(item.email)) continue;
      if (occurred < rule.updatedAt - RULE_GRACE_MS) continue;
      const known = await db.query(
        "select 1 from crm.contacts where workspace_id = $1 and archived_at is null and normalized_email = $2 limit 1",
        [actor.workspaceId, item.email],
      );
      if (!known.rowCount) ruled.push({ workspaceId: actor.workspaceId, email: item.email, name: item.name });
    }
    if (match.contactId || match.companyId) targets.push({ actor, match });
  }
  return { targets, ruled };
}

export async function captureWorkspaceInDb(
  db: Db,
  owner: UserActor,
  actors: UserActor[],
  people: Participant[],
  accounts: (string | null | undefined)[],
) {
  const workspaceIds = actors.map((item) => item.workspaceId);
  const rules = await rulesFor(db, owner, workspaceIds);
  for (const person of people) {
    const email = person.email ? canonicalEmail(person.email) : null;
    const rule = email ? rules.get(domainOf(email)) : undefined;
    if (rule?.workspaceIds[0]) return rule.workspaceIds[0];
  }
  const homes = await addressHomesInDb(db, owner);
  const addresses = accounts.map((value) => (value ? canonicalEmail(value) : null)).filter((value): value is string => Boolean(value));
  for (const address of addresses) {
    const home = homes.find((item) => item.address === address);
    if (home && workspaceIds.includes(home.workspaceId)) return home.workspaceId;
  }
  if (addresses.length > 0) {
    const account = await db.query<{ workspace_id: string }>(
      `select workspace_id from (
         select workspace_id, lower(email) as email, 0 as rank from crm.mailbox_connections where user_id = $1
         union all
         select workspace_id, lower(email), 1 from crm.calendar_accounts where user_id = $1
       ) a
       where a.email = any($2::text[]) and a.workspace_id = any($3::uuid[])
       order by rank
       limit 1`,
      [owner.userId, addresses, workspaceIds],
    );
    if (account.rows[0]) return account.rows[0].workspace_id;
  }
  return workspaceIds.includes(owner.workspaceId) ? owner.workspaceId : (workspaceIds[0] ?? owner.workspaceId);
}

export async function moveImportToWorkspace(owner: UserActor, importId: string, workspaceId: string) {
  try {
    const result = await query<{ id: string }>("select private.move_conversation_import($1, $2, $3) as id", [owner.userId, importId, workspaceId]);
    return result.rows[0]?.id ?? importId;
  } catch (error) {
    if (isPgError(error)) {
      if (error.code === "P0002") throw new CrmError("not_found", "Conversation not found.", 404);
      if (error.code === "55000") throw new CrmError("conflict", "This conversation is already filed or ignored.", 409);
      if (error.code === "23505") throw new CrmError("conflict", "A colleague already has this conversation in that workspace.", 409, { field: "workspaceId" });
      if (error.code === "42501") throw new CrmError("forbidden", "Choose a workspace you're in.", 403, { field: "workspaceId" });
    }
    throw error;
  }
}

export async function moveImport(actor: UserActor, importId: string, workspaceId: string) {
  assertScope(actor.scopes, "activities:write");
  if (!isUuid(importId)) throw new CrmError("not_found", "Conversation not found.", 404);
  actorIn(await workspaceActors(actor), workspaceId);
  const owned = await withActor(actor, (db) =>
    db.query(
      "select 1 from crm.conversation_imports where id = $1 and workspace_id = $2 and user_id = $3 and status in ('pending', 'unfiled')",
      [importId, actor.workspaceId, actor.userId],
    ),
  );
  if (!owned.rowCount) throw new CrmError("not_found", "Conversation not found.", 404);
  return moveImportToWorkspace(actor, importId, workspaceId);
}
