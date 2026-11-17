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
import { redactedError } from "@/lib/upstream";
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

type Person = { contactId: string | null; prospectId: string | null; name: string; emails: string[]; linkedins: string[] };

type SuppressOutcome = { changed: boolean; stopping: (StopRow & { provider: CampaignProviderId })[]; skipped: number };

function web(operation: string, provenance?: Provenance): Provenance {
  return provenance ?? { operation, source: "web" };
}

function present(values: (string | null | undefined)[]) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

async function personOf(db: Db, actor: Actor, target: DoNotContactTarget): Promise<Person> {
  if ("contactId" in target) {
    if (!isUuid(target.contactId)) throw notFound("contact");
    const found = await db.query<{ id: string; name: string; normalized_email: string | null; normalized_linkedin: string | null }>(
      `select id, coalesce(nullif(btrim(concat_ws(' ', first_name, last_name)), ''), email, 'This person') as name, normalized_email, normalized_linkedin
       from crm.contacts where id = $1 and workspace_id = $2`,
      [target.contactId, actor.workspaceId],
    );
    const row = found.rows[0];
    if (!row) throw notFound("contact");
    return { contactId: row.id, prospectId: null, name: row.name, emails: present([row.normalized_email]), linkedins: present([row.normalized_linkedin]) };
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
  return {
    contactId: row.contact_id,
    prospectId: row.id,
    name: row.name,
    emails: present([row.email, row.normalized_email]),
    linkedins: present([row.linkedin, row.normalized_linkedin]),
  };
}

function dayMonth(at: Date) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" }).format(at);
}

export function doNotContactLine(reason: DoNotContact["reason"], setAt: Date, setBy: string | null) {
  if (reason === "unsubscribed") return `Unsubscribed ${dayMonth(setAt)}.`;
  return setBy ? `Set by ${setBy}, ${dayMonth(setAt)}.` : `Set ${dayMonth(setAt)}.`;
}

async function statusOf(db: Db, workspaceId: string, person: Pick<Person, "contactId" | "emails" | "linkedins">): Promise<DoNotContact | null> {
  const found = await db.query<{ reason: DoNotContact["reason"]; created_at: Date; set_by: string | null }>(
    `select s.reason, s.created_at, coalesce(nullif(btrim(pr.full_name), ''), pr.email, a.name) as set_by
     from crm.suppressions s
     left join crm.profiles pr on pr.id = s.created_by_user_id
     left join crm.agents a on a.id = s.created_by_agent_id
     where s.workspace_id = $1 and s.reason <> 'bounced'
       and (($2::uuid is not null and s.contact_id = $2) or (s.kind = 'email' and s.value = any($3::text[])) or (s.kind = 'linkedin' and s.value = any($4::text[])))
     order by s.created_at, s.id
     limit 1`,
    [workspaceId, person.contactId, person.emails, person.linkedins],
  );
  const row = found.rows[0];
  if (!row) return null;
  return { reason: row.reason, setAt: row.created_at.toISOString(), setBy: row.set_by, line: doNotContactLine(row.reason, row.created_at, row.set_by) };
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
    return { doNotContact, caution };
  });
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

export async function pushBlockList(workspaceId: string, provider: CampaignProvider, context: ProviderContext) {
  if (!provider.blockAddresses) return 0;
  let pending: { id: string; value: string }[] = [];
  try {
    pending = (await query<{ id: string; value: string }>("select * from private.suppression_block_pending($1, $2)", [workspaceId, BLOCK_PAGE])).rows;
    if (pending.length === 0) return 0;
    await provider.blockAddresses(context, pending.map((row) => row.value));
    await query("select private.suppression_blocked($1, $2::uuid[])", [workspaceId, pending.map((row) => row.id)]);
    return pending.length;
  } catch (error) {
    if (error instanceof ServiceBusy) return 0;
    console.error(`Couldn't add addresses to the ${provider.name} block list`, redactedError(error));
    if (pending.length === 0) return 0;
    const failed = await query<{ id: string; attempts: number }>("select * from private.suppression_block_failed($1, $2::uuid[])", [workspaceId, pending.map((row) => row.id)]).catch(() => null);
    for (const row of failed?.rows ?? []) {
      if (row.attempts >= BLOCK_ATTEMPTS) console.error(`Gave up adding suppression ${row.id} to the ${provider.name} block list after ${row.attempts} tries`);
    }
    return 0;
  }
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
  const saved = await query<{ result: SuppressOutcome }>("select private.suppress_person($1, $2, $3::text[], $4::text[], 'manual', $5, $6, $7, null, null, $8::jsonb) as result", [
    actor.workspaceId,
    person.contactId,
    person.emails,
    person.linkedins,
    (provenance.source ?? (actor.type === "agent" ? "agent" : "web")).slice(0, 40),
    actor.type === "user" ? actor.userId : null,
    actor.type === "agent" ? actor.agentId : null,
    JSON.stringify(auditOf(actor, SUPPRESSION_AUDIT_EVENTS.set, person, provenance, { emails: person.emails, linkedins: person.linkedins })),
  ]);
  const outcome = saved.rows[0].result;
  if (outcome.changed) scheduleWebhooks();
  const stopped = await stopNow(actor.workspaceId, outcome.stopping, options);
  await pushBlockListNow(actor.workspaceId, options).catch(() => 0);
  return { changed: outcome.changed, stopping: outcome.stopping.length, stopped, skipped: outcome.skipped };
}

export async function liftDoNotContact(actor: Actor, target: DoNotContactTarget, options: { provenance?: Provenance } = {}) {
  if (actor.type === "agent") throw new CrmError("forbidden", ONLY_A_PERSON_LIFTS, 403);
  assertScope(actor.scopes, "campaigns:write");
  const person = await withActor(actor, (db) => personOf(db, actor, target));
  const gone = await query<{ lifted: { id: string; kind: string; value: string; reason: string }[] }>("select private.suppression_lift($1, $2, $3::text[], $4::text[], $5::jsonb) as lifted", [
    actor.workspaceId,
    person.contactId,
    person.emails,
    person.linkedins,
    JSON.stringify(auditOf(actor, SUPPRESSION_AUDIT_EVENTS.lifted, person, web("lift_do_not_contact", options.provenance), {})),
  ]);
  const lifted = gone.rows[0]?.lifted ?? [];
  if (lifted.length === 0) return { lifted: 0 };
  scheduleWebhooks();
  return { lifted: lifted.length };
}
