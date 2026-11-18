import { connectedContext, type ProviderOptions } from "@/lib/campaigns/context";
import type { CampaignProvider, ProviderContext } from "@/lib/campaigns/providers";
import { stopAtProvider, type StopRow } from "@/lib/campaigns/stops";
import type { CampaignProviderId } from "@/lib/campaigns/types";
import { scheduleWebhooks, withActor } from "@/lib/crm/context";
import { CrmError, notFound } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import { assertScope } from "@/lib/crm/scopes";
import { suppressedAddresses, suppressedLine, suppressedNames } from "@/lib/crm/suppressions";
import type { Actor, Provenance } from "@/lib/crm/types";
import { query, type Db } from "@/lib/db/pool";
import { doNotContactKeys, doNotContactStatusKeys, personKeys, present, type PersonKeys } from "@/lib/campaigns/people";
import { redactedError } from "@/lib/upstream";
import { signalCampaigns } from "@/lib/sync-signals";
import { ServiceBusy } from "@/lib/workflows/limits";

export const SUPPRESSION_AUDIT_EVENTS = {
  set: "campaign.do_not_contact_set",
  lifted: "campaign.do_not_contact_lifted",
  unsubscribed: "campaign.unsubscribed",
  bounced: "campaign.bounced",
} as const;

export const ONLY_A_PERSON_LIFTS = "Only a person can lift Do not contact, in Orbit.";

const STOP_BUDGET_MS = 10_000;
const BLOCK_PAGE = 100;
const BLOCK_ATTEMPTS = 3;

export type DoNotContactTarget = { contactId: string } | { prospectId: string };

export type DoNotContact = { reason: "manual" | "unsubscribed"; setAt: string; setBy: string | null; line: string };

type Person = { contactId: string | null; contactIds: string[]; prospectId: string | null; name: string; emails: string[]; linkedins: string[]; reached: { emails: string[]; linkedins: string[] } };

type SuppressOutcome = { changed: boolean; stopping: (StopRow & { provider: CampaignProviderId })[]; skipped: number };

function web(operation: string, provenance?: Provenance): Provenance {
  return provenance ?? { operation, source: "web" };
}

async function groupOf(db: Db, workspaceId: string, prospectId: string | null): Promise<PersonKeys[]> {
  return prospectId ? personKeys(db, workspaceId, prospectId) : [];
}

function withGroup(person: Pick<Person, "contactId" | "prospectId" | "name">, group: PersonKeys[]): Person {
  const keys = doNotContactKeys(group);
  const reached = doNotContactStatusKeys(group);
  return {
    ...person,
    contactIds: present([person.contactId, ...keys.contactIds]),
    emails: keys.emails,
    linkedins: keys.linkedins,
    reached: { emails: reached.emails, linkedins: reached.linkedins },
  };
}

async function personOf(db: Db, actor: Actor, target: DoNotContactTarget): Promise<Person> {
  if ("contactId" in target) {
    if (!isUuid(target.contactId)) throw notFound("contact");
    const found = await db.query<{ id: string; name: string; normalized_email: string | null; normalized_linkedin: string | null; prospect_id: string | null }>(
      `select c.id, coalesce(nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), c.email, 'This person') as name, c.normalized_email, c.normalized_linkedin,
              (select p.id from crm.campaign_prospects p where p.workspace_id = c.workspace_id and p.contact_id = c.id order by p.created_at, p.id limit 1) as prospect_id
       from crm.contacts c where c.id = $1 and c.workspace_id = $2`,
      [target.contactId, actor.workspaceId],
    );
    const row = found.rows[0];
    if (!row) throw notFound("contact");
    const own: PersonKeys = { id: `contact:${row.id}`, contact_id: row.id, email: null, linkedin: null, normalized_email: row.normalized_email, normalized_linkedin: row.normalized_linkedin };
    return withGroup({ contactId: row.id, prospectId: null, name: row.name }, [own, ...(await groupOf(db, actor.workspaceId, row.prospect_id))]);
  }
  if (!isUuid(target.prospectId)) throw notFound("prospect");
  const found = await db.query<{ id: string; contact_id: string | null; email: string | null; linkedin: string | null; normalized_email: string | null; normalized_linkedin: string | null; name: string }>(
    `select p.id, c.id as contact_id, p.email, p.linkedin, c.normalized_email, c.normalized_linkedin,
            coalesce(
              nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''),
              nullif(btrim(concat_ws(' ', p.lead->>'firstName', p.lead->>'lastName')), ''),
              c.email, p.email, p.linkedin, 'This person'
            ) as name
     from crm.campaign_prospects p
     left join crm.contacts c on c.id = p.contact_id and c.workspace_id = p.workspace_id
     where p.id = $1 and p.workspace_id = $2`,
    [target.prospectId, actor.workspaceId],
  );
  const row = found.rows[0];
  if (!row) throw notFound("prospect");
  return withGroup({ contactId: row.contact_id, prospectId: row.id, name: row.name }, await groupOf(db, actor.workspaceId, row.id));
}

function dayMonth(at: Date) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" }).format(at);
}

export function doNotContactLine(reason: DoNotContact["reason"], setAt: Date, setBy: string | null) {
  if (reason === "unsubscribed") return `Unsubscribed ${dayMonth(setAt)}.`;
  return setBy ? `Set by ${setBy}, ${dayMonth(setAt)}.` : `Set ${dayMonth(setAt)}.`;
}

async function statusOf(db: Db, workspaceId: string, person: Pick<Person, "contactIds" | "reached">): Promise<DoNotContact | null> {
  const found = await db.query<{ reason: DoNotContact["reason"]; created_at: Date; set_by: string | null }>(
    `select s.reason, s.created_at, coalesce(nullif(btrim(pr.full_name), ''), pr.email, a.name) as set_by
     from crm.suppressions s
     left join crm.profiles pr on pr.id = s.created_by_user_id
     left join crm.agents a on a.id = s.created_by_agent_id
     where s.workspace_id = $1 and s.reason <> 'bounced'
       and (s.contact_id = any($2::uuid[]) or (s.kind = 'email' and s.value = any($3::text[])) or (s.kind = 'linkedin' and s.value = any($4::text[])))
     order by s.created_at, s.id
     limit 1`,
    [workspaceId, person.contactIds, person.reached.emails, person.reached.linkedins],
  );
  const row = found.rows[0];
  if (!row) return null;
  return { reason: row.reason, setAt: row.created_at.toISOString(), setBy: row.set_by, line: doNotContactLine(row.reason, row.created_at, row.set_by) };
}

async function holdingValue(db: Db, workspaceId: string, person: Pick<Person, "contactIds" | "reached">) {
  const found = await db.query<{ value: string }>(
    `select s.value from crm.suppressions s
     where s.workspace_id = $1 and s.reason <> 'bounced'
       and (s.contact_id = any($2::uuid[]) or (s.kind = 'email' and s.value = any($3::text[])) or (s.kind = 'linkedin' and s.value = any($4::text[])))
     order by s.created_at, s.id
     limit 1`,
    [workspaceId, person.contactIds, person.reached.emails, person.reached.linkedins],
  );
  return found.rows[0]?.value ?? null;
}

export async function doNotContactFor(actor: Actor, target: DoNotContactTarget) {
  return withActor(actor, async (db) => statusOf(db, actor.workspaceId, await personOf(db, actor, target)));
}

export async function contactSuppression(actor: Actor, contactId: string) {
  return withActor(actor, async (db) => {
    const person = await personOf(db, actor, { contactId });
    const doNotContact = await statusOf(db, actor.workspaceId, person);
    const recipients = person.emails.map((address) => ({ address, name: person.name }));
    const caution = suppressedLine(suppressedNames(recipients, await suppressedAddresses(db, actor.workspaceId, person.emails)));
    return { doNotContact, caution, blockLine: await blockLineOf(db, actor.workspaceId, person.emails) };
  });
}

export const STILL_BLOCKED = "Still on Smartlead's block list, so campaigns skip them.";

async function blockLineOf(db: Db, workspaceId: string, emails: string[]) {
  if (emails.length === 0) return null;
  const found = await db.query("select 1 from crm.campaign_block_lifts where workspace_id = $1 and value = any($2::text[]) limit 1", [workspaceId, emails]);
  return found.rows.length > 0 ? STILL_BLOCKED : null;
}

export async function doNotContactIn(db: Db, actor: Actor, target: DoNotContactTarget) {
  return statusOf(db, actor.workspaceId, await personOf(db, actor, target));
}

async function stopNow(workspaceId: string, rows: SuppressOutcome["stopping"], options: ProviderOptions) {
  const deadline = Date.now() + STOP_BUDGET_MS;
  const contexts = new Map<string, { provider: CampaignProvider; context: ProviderContext } | null>();
  let stopped = 0;
  for (const row of rows) {
    if (Date.now() >= deadline) break;
    try {
      if (!contexts.has(row.provider)) contexts.set(row.provider, await connectedContext(workspaceId, row.provider, options).catch(() => null));
      const connected = contexts.get(row.provider);
      if (!connected) continue;
      if (await stopAtProvider(workspaceId, connected.provider, connected.context, row)) stopped += 1;
    } catch (error) {
      if (error instanceof ServiceBusy) continue;
      console.error("Couldn't stop a prospect after Do not contact", redactedError(error));
    }
  }
  return stopped;
}

async function blockFailed(workspaceId: string, provider: CampaignProvider, ids: string[]) {
  const failed = await query<{ id: string; attempts: number }>("select * from private.suppression_block_failed($1, $2::uuid[])", [workspaceId, ids]).catch(() => null);
  for (const row of failed?.rows ?? []) {
    if (row.attempts >= BLOCK_ATTEMPTS) console.error(`Gave up adding suppression ${row.id} to the ${provider.name} block list after ${row.attempts} tries`);
  }
}

async function blockBatch(workspaceId: string, provider: CampaignProvider, context: ProviderContext, rows: { id: string; value: string }[]) {
  await provider.blockAddresses!(context, rows.map((row) => row.value));
  await query("select private.suppression_blocked($1, $2::uuid[])", [workspaceId, rows.map((row) => row.id)]);
}

function rejected(provider: CampaignProvider, error: unknown) {
  if (error instanceof ServiceBusy) return false;
  const status = provider.failure(error)?.status ?? null;
  return status !== null && status >= 400 && status < 500 && status !== 429;
}

export async function pushBlockList(workspaceId: string, provider: CampaignProvider, context: ProviderContext) {
  if (!provider.blockAddresses) return 0;
  let pending: { id: string; value: string }[];
  try {
    pending = (await query<{ id: string; value: string }>("select * from private.suppression_block_pending($1, $2)", [workspaceId, BLOCK_PAGE])).rows;
  } catch (error) {
    console.error(`Couldn't read the ${provider.name} block list queue`, redactedError(error));
    return 0;
  }
  if (pending.length === 0) return 0;
  try {
    await blockBatch(workspaceId, provider, context, pending);
    return pending.length;
  } catch (error) {
    if (!(error instanceof ServiceBusy)) console.error(`Couldn't add addresses to the ${provider.name} block list`, redactedError(error));
    if (!rejected(provider, error)) return 0;
  }
  let blocked = 0;
  for (const row of pending) {
    try {
      await blockBatch(workspaceId, provider, context, [row]);
      blocked += 1;
    } catch (error) {
      if (!rejected(provider, error)) break;
      await blockFailed(workspaceId, provider, [row.id]);
    }
  }
  return blocked;
}

const LIFT_PAGE = 25;

export async function liftBlocks(workspaceId: string, provider: CampaignProvider, context: ProviderContext) {
  if (!provider.unblockAddress) return 0;
  let pending: { id: string; value: string }[];
  try {
    pending = (await query<{ id: string; value: string }>("select * from private.campaign_block_lifts_pending($1, $2)", [workspaceId, LIFT_PAGE])).rows;
  } catch (error) {
    console.error(`Couldn't read the ${provider.name} block list removals`, redactedError(error));
    return 0;
  }
  let lifted = 0;
  for (const row of pending) {
    try {
      await provider.unblockAddress(context, row.value);
      await query("select private.campaign_block_lift_done($1, $2, true)", [workspaceId, row.id]);
      lifted += 1;
    } catch (error) {
      if (error instanceof ServiceBusy) break;
      if (!rejected(provider, error)) {
        if (!provider.failure(error)) console.error(`Couldn't take an address off the ${provider.name} block list`, redactedError(error));
        break;
      }
      await query("select private.campaign_block_lift_done($1, $2, false)", [workspaceId, row.id]).catch(() => undefined);
    }
  }
  return lifted;
}

async function liftBlocksNow(workspaceId: string, options: ProviderOptions) {
  const connected = await connectedContext(workspaceId, "smartlead", options).catch(() => null);
  if (!connected) return 0;
  return liftBlocks(workspaceId, connected.provider, connected.context);
}

async function pushBlockListNow(workspaceId: string, options: ProviderOptions) {
  const connected = await connectedContext(workspaceId, "smartlead", options).catch(() => null);
  if (!connected) return 0;
  return pushBlockList(workspaceId, connected.provider, connected.context);
}

function auditOf(actor: Actor, eventType: string, person: Person, provenance: Provenance, changes: Record<string, unknown>) {
  return {
    eventType,
    entityType: person.contactId ? "contact" : "campaign_prospect",
    entityId: person.contactId ?? person.prospectId,
    actorType: actor.type,
    userId: actor.type === "user" ? actor.userId : null,
    agentId: actor.type === "agent" ? actor.agentId : null,
    credentialId: actor.type === "agent" ? actor.credentialId : null,
    source: provenance.source ?? null,
    sourceUrl: provenance.sourceUrl ?? null,
    operation: provenance.operation,
    workflowStep: provenance.workflowStep ?? null,
    changes: { contactId: person.contactId, prospectId: person.prospectId, name: person.name, ...changes },
  };
}

export async function setDoNotContact(actor: Actor, target: DoNotContactTarget, options: ProviderOptions & { provenance?: Provenance } = {}) {
  assertScope(actor.scopes, "campaigns:write");
  const person = await withActor(actor, (db) => personOf(db, actor, target));
  if (person.emails.length === 0 && person.linkedins.length === 0) {
    throw new CrmError("invalid_input", "Add an email address or LinkedIn profile first.", 400);
  }
  const provenance = web("set_do_not_contact", options.provenance);
  const saved = await query<{ result: SuppressOutcome }>("select private.suppress_person_group($1, $2::uuid[], $3::text[], $4::text[], 'manual', $5, $6, $7, $8::jsonb) as result", [
    actor.workspaceId,
    person.contactIds,
    person.emails,
    person.linkedins,
    (provenance.source ?? (actor.type === "agent" ? "agent" : "web")).slice(0, 40),
    actor.type === "user" ? actor.userId : null,
    actor.type === "agent" ? actor.agentId : null,
    JSON.stringify(auditOf(actor, SUPPRESSION_AUDIT_EVENTS.set, person, provenance, { emails: person.emails, linkedins: person.linkedins })),
  ]);
  const outcome = saved.rows[0].result;
  if (outcome.changed) {
    scheduleWebhooks();
    await signalCampaigns(actor.workspaceId);
  }
  const stopped = await stopNow(actor.workspaceId, outcome.stopping, options);
  await pushBlockListNow(actor.workspaceId, options).catch(() => 0);
  return { changed: outcome.changed, stopping: outcome.stopping.length, stopped, skipped: outcome.skipped };
}

export async function liftDoNotContact(actor: Actor, target: DoNotContactTarget, options: ProviderOptions & { provenance?: Provenance } = {}) {
  if (actor.type === "agent") throw new CrmError("forbidden", ONLY_A_PERSON_LIFTS, 403);
  assertScope(actor.scopes, "campaigns:write");
  const person = await withActor(actor, (db) => personOf(db, actor, target));
  const gone = await query<{ lifted: { id: string; kind: string; value: string; reason: string }[] }>("select private.suppression_lift_person($1, $2::uuid[], $3::text[], $4::text[], $5::jsonb) as lifted", [
    actor.workspaceId,
    person.contactIds,
    person.emails,
    person.linkedins,
    JSON.stringify(auditOf(actor, SUPPRESSION_AUDIT_EVENTS.lifted, person, web("lift_do_not_contact", options.provenance), {})),
  ]);
  const lifted = gone.rows[0]?.lifted ?? [];
  if (lifted.length === 0) {
    const holding = await withActor(actor, (db) => holdingValue(db, actor.workspaceId, person));
    if (holding) throw new CrmError("conflict", `${holding} is on the list for someone else.`, 409);
    return { lifted: 0 };
  }
  scheduleWebhooks();
  await signalCampaigns(actor.workspaceId);
  if (lifted.some((item) => item.kind === "email")) await liftBlocksNow(actor.workspaceId, options).catch(() => 0);
  return { lifted: lifted.length };
}
