import {
  confidentFor,
  contactsByName,
  exactFor,
  excludedNameKeys,
  inQueryOrder,
  nameQueries,
  titleNames,
  type NameCandidate,
} from "@/lib/crm/call-names";
import { isFreeMailDomain } from "@/lib/crm/communications";
import { internalAddresses, type Participant } from "@/lib/crm/conversations";
import { CrmError, isPgError, notFound } from "@/lib/crm/errors";
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
export type CallRoute = { targets: CallTarget[]; ruled: RuledPerson[]; suggested: NameCandidate[] };

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

export async function routeCallInDb(
  db: Db,
  owner: UserActor,
  actors: UserActor[],
  people: Participant[],
  options: {
    own?: Set<string>;
    occurredAt?: string | null;
    names?: boolean;
    ownNames?: (string | null | undefined)[];
    nameWorkspaceIds?: string[];
  } = {},
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
  const nameless = people.filter((person) => !person.email).map((person) => person.name);
  const names = options.names && nameless.length > 0
    ? nameQueries(nameless, await excludedNameKeys(db, owner.userId, [owner.fullName, ...(options.ownNames ?? [])]))
    : [];
  const matched = new Map<string, CallTarget>();
  const unmatched: UserActor[] = [];
  const ruled: RuledPerson[] = [];
  for (const actor of actors) {
    const internal = await internalAddresses(db, actor.workspaceId, [...own]);
    const outside = emails.filter((item) => !internal.isInternal(item.email));
    const allowed = outside.filter((item) => {
      const rule = rules.get(domainOf(item.email));
      return !rule || rule.workspaceIds.includes(actor.workspaceId);
    });
    const match = await matchParties(db, actor.workspaceId, allowed.map((item) => item.email));
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
    if (match.contactId || match.companyId) matched.set(actor.workspaceId, { actor, match });
    else unmatched.push(actor);
  }
  let suggested: NameCandidate[] = [];
  if (names.length > 0 && unmatched.length > 0) {
    const lookup = await contactsByName(db, [...new Set([...workspaceIds, ...(options.nameWorkspaceIds ?? [])])], names);
    const confident = names.filter((query) => confidentFor(query, lookup));
    const hits = confident.flatMap((query) => exactFor(query, lookup.candidates));
    for (const actor of unmatched) {
      const hit = hits.find((candidate) => candidate.workspaceId === actor.workspaceId);
      if (hit) matched.set(actor.workspaceId, { actor, match: hit });
    }
    if (matched.size === 0) suggested = inQueryOrder(lookup.candidates, names).filter((candidate) => workspaceIds.includes(candidate.workspaceId));
  }
  const targets = actors.map((actor) => matched.get(actor.workspaceId)).filter((target): target is CallTarget => Boolean(target));
  return { targets, ruled, suggested };
}

export async function suggestByTitleInDb(
  db: Db,
  owner: UserActor,
  workspaceIds: string[],
  titles: (string | null | undefined)[],
  ownNames: (string | null | undefined)[] = [],
) {
  const names = [...new Set(titles.flatMap((title) => titleNames(title)))];
  if (names.length === 0) return [];
  const queries = nameQueries(names, await excludedNameKeys(db, owner.userId, [owner.fullName, ...ownNames]));
  return inQueryOrder((await contactsByName(db, workspaceIds, queries)).candidates, queries);
}

export function suggestedWorkspace(suggested: { workspaceId: string }[], fallback: string) {
  if (suggested.length === 0 || suggested.some((candidate) => candidate.workspaceId === fallback)) return fallback;
  return suggested[0].workspaceId;
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
      if (error.code === "P0002") throw notFound("conversation");
      if (error.code === "55000") throw new CrmError("conflict", "This conversation is already filed or ignored.", 409);
      if (error.code === "23505") throw new CrmError("conflict", "A colleague already has this conversation in that workspace.", 409, { field: "workspaceId" });
      if (error.code === "OR409") {
        throw new CrmError("conflict", "Couldn't move it. A colleague dismissed this call in that workspace, so only they can bring it back there.", 409, { field: "workspaceId" });
      }
      if (error.code === "42501") throw new CrmError("forbidden", "Choose a workspace you're in.", 403, { field: "workspaceId" });
    }
    throw error;
  }
}

export async function moveImport(actor: UserActor, importId: string, workspaceId: string) {
  assertScope(actor.scopes, "activities:write");
  if (!isUuid(importId)) throw notFound("conversation");
  actorIn(await workspaceActors(actor), workspaceId);
  const owned = await withActor(actor, (db) =>
    db.query(
      "select 1 from crm.conversation_imports where id = $1 and workspace_id = $2 and user_id = $3 and status in ('pending', 'unfiled')",
      [importId, actor.workspaceId, actor.userId],
    ),
  );
  if (!owned.rowCount) throw notFound("conversation");
  return moveImportToWorkspace(actor, importId, workspaceId);
}
