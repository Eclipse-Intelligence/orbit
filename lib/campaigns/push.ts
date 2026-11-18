import { randomUUID } from "node:crypto";
import { connectedContext, mightHaveSent } from "@/lib/campaigns/context";
import { fireCampaignEvents } from "@/lib/campaigns/events";
import { prospectEmail, prospectLinkedin } from "@/lib/campaigns/normalize";
import { fillVariables, type FillSource } from "@/lib/campaigns/fill";
import type { CampaignProvider, ProviderContext, PushLead } from "@/lib/campaigns/providers";
import { addRefusal, readCampaignTarget, readCampaignVariables, type CampaignTarget, type CampaignVariable } from "@/lib/campaigns/prospects";
import { syncActor } from "@/lib/campaigns/sync";
import type { ProspectState, SequenceStep } from "@/lib/campaigns/types";
import { senderFirstName } from "@/lib/assistant/cold-email";
import { userLinks } from "@/lib/assistant/links";
import { createActivityInDb } from "@/lib/crm/activities";
import { brandOrEmpty, type BrandProfile } from "@/lib/crm/brand";
import { getCompany } from "@/lib/crm/companies";
import { getContact } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { timeLeft } from "@/lib/crm/conversations";
import { CrmError } from "@/lib/crm/errors";
import { listProof, type ProofEntry } from "@/lib/crm/proof";
import type { Contact, Provenance, UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import { enrichContact } from "@/lib/enrichment/contacts";
import { enrichmentAvailability } from "@/lib/enrichment/settings";
import { verifyContactEmail } from "@/lib/enrichment/email-check";
import { ProviderFailure, type ProviderGate } from "@/lib/enrichment/providers";
import { LlmError } from "@/lib/llm";
import { redactedError } from "@/lib/upstream";
import { ownerActor } from "@/lib/workflows/engine";
import { ENRICHMENT_SERVICES, ServiceBusy, withService } from "@/lib/workflows/limits";

export const FILL_BATCH = 25;
const FILL_RESERVE_MS = 15_000;
const FILLS_AT_ONCE = 8;

export type ProspectOutcome = { prospectId: string; state: ProspectState; reason: string | null };

type ClaimRow = { prospect_id: string; state: ProspectState; claimed: boolean; filled: boolean; skip_reason: string | null };

type ProspectRow = {
  id: string;
  campaign_id: string;
  contact_id: string | null;
  state: ProspectState;
  values: Record<string, unknown>;
  filled_at: Date | null;
  external_lead_id: string | null;
  email: string | null;
  linkedin: string | null;
  sender_id: string | null;
  skip_reason: string | null;
  added_by_run_id: string | null;
};

type Job = {
  actor: UserActor;
  campaign: CampaignTarget;
  variables: CampaignVariable[];
  provider: CampaignProvider;
  context: ProviderContext;
  holder: string;
  fetchImpl?: typeof fetch;
  deadline: number;
  runSteps?: unknown;
  halted?: boolean;
  writing?: Promise<{ brand: BrandProfile; proof: ProofEntry[]; sender: { firstName: string; bookingUrl: string | null } }>;
};

type Ready = { prospect: ProspectRow; lead: PushLead };

type Begun = { ok: boolean; reason: string | null; email: string | null; linkedin: string | null };

class Ended extends Error {
  readonly state: "skipped" | "failed";

  constructor(state: "skipped" | "failed", reason: string) {
    super(reason);
    this.name = "Ended";
    this.state = state;
  }
}

export const serviceGate: ProviderGate = (provider, run) =>
  withService(ENRICHMENT_SERVICES[provider], run, {
    statusOf: (error) => (error instanceof ProviderFailure ? { status: error.status, retryAfter: error.retryAfter } : null),
  });

function tookIt(provider: CampaignProvider) {
  return `${provider.name} didn't take this lead`;
}

async function readProspect(workspaceId: string, id: string, actor: UserActor) {
  return withActor(actor, async (db) => {
    const result = await db.query<ProspectRow>(
      `select id, campaign_id, contact_id, state, "values", filled_at, external_lead_id, email, linkedin, sender_id, skip_reason, added_by_run_id
       from crm.campaign_prospects where id = $1 and workspace_id = $2`,
      [id, workspaceId],
    );
    return result.rows[0] ?? null;
  });
}

async function finish(workspaceId: string, holder: string, prospectId: string, state: "skipped" | "failed" | null, reason: string | null) {
  await query("select private.campaign_fill_end($1, $2, $3, $4, $5)", [workspaceId, prospectId, holder, state, reason]);
}

function end(job: Job, prospectId: string, state: "skipped" | "failed" | null, reason: string | null) {
  return finish(job.actor.workspaceId, job.holder, prospectId, state, reason);
}

async function unsend(job: Job, ids: string[]) {
  if (ids.length === 0) return;
  await query("select private.campaign_push_undo($1, $2::uuid[], $3)", [job.actor.workspaceId, ids, job.holder]);
}

function rejectedKey(job: Job, error: unknown) {
  return Boolean(job.provider.failure(error)?.rejectedKey);
}

export function transient(provider: CampaignProvider, error: unknown) {
  if (error instanceof Ended) return false;
  if (error instanceof ServiceBusy) return true;
  if (error instanceof LlmError) return error.retryable;
  if (error instanceof CrmError) return error.status >= 500 || error.status === 429 || error.details?.retry === true;
  const failure = provider.failure(error);
  if (failure) return failure.rejectedKey || failure.status === null || failure.status >= 500 || failure.status === 429;
  return true;
}

function failureText(error: unknown) {
  if (error instanceof CrmError || error instanceof LlmError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "Couldn't add this person. Try again.";
}

async function writingFor(actor: UserActor) {
  const [brand, proof, links] = await Promise.all([brandOrEmpty(actor), listProof(actor), userLinks(actor).catch(() => null)]);
  return {
    brand,
    proof,
    sender: { firstName: senderFirstName(actor.fullName, actor.email), bookingUrl: links?.booking?.enabled ? links.booking.url : null },
  };
}

async function readyEmail(job: Job, contact: Contact) {
  if (!contact.email) throw new Ended("skipped", "No email");
  let check;
  try {
    check = await verifyContactEmail(job.actor, contact.id, { fetchImpl: job.fetchImpl, deadline: job.deadline, workflowLimits: serviceGate });
  } catch (error) {
    if (error instanceof CrmError && error.status < 500 && error.status !== 429 && error.details?.retry !== true) throw new Ended("failed", error.message);
    throw error;
  }
  if (check.verdict === "invalid") throw new Ended("skipped", "Email invalid");
  if (check.verdict !== "valid") throw new Ended("skipped", "Email not confirmed");
  return contact;
}

async function readyLinkedin(job: Job, contact: Contact) {
  if (!contact.firstName?.trim() || !contact.lastName?.trim()) throw new Ended("skipped", "No first or last name");
  if (contact.linkedinUrl) return contact;
  if (!enrichmentAvailability().linkedin) throw new Ended("failed", "No LinkedIn finder is set up.");
  const found = await enrichContact(job.actor, contact.id, "linkedin", { fetchImpl: job.fetchImpl, workflowLimits: serviceGate });
  if (found.status === "found") return getContact(job.actor, contact.id);
  if (found.status === "failed" && !found.duplicate) throw new CrmError("upstream_error", found.message, 502, { retry: true });
  throw new Ended("skipped", found.clash ?? "No LinkedIn profile");
}

async function senderFor(job: Job, contact: Contact) {
  if (job.campaign.channel !== "linkedin" || !contact.ownerId || (job.campaign.sender_ids ?? []).length === 0) return null;
  return withActor(job.actor, async (db) => {
    const result = await db.query<{ external_id: string }>(
      `select external_id from crm.campaign_senders
       where workspace_id = $1 and provider = $2 and user_id = $3 and external_id = any($4::text[])
       order by external_id limit 1`,
      [job.actor.workspaceId, job.campaign.provider, contact.ownerId, job.campaign.sender_ids],
    );
    return result.rows[0]?.external_id ?? null;
  });
}

function storedSources(sources: Record<string, FillSource[]>) {
  return Object.fromEntries(
    Object.entries(sources).map(([name, items]) => [
      name,
      items.map((item) => (item.url ? { url: item.url, fact: item.fact } : { label: item.fact, ...(item.proofId ? { proofId: item.proofId } : {}) })),
    ]),
  );
}

function storedValues(values: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(values ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function prepare(job: Job, prospect: ProspectRow): Promise<Ready> {
  if (!prospect.contact_id) throw new Ended("failed", "Not in Orbit");
  let contact = await getContact(job.actor, prospect.contact_id).catch((error) => {
    if (error instanceof CrmError && error.status === 404) throw new Ended("failed", "Not in Orbit");
    throw error;
  });
  contact = job.campaign.channel === "email" ? await readyEmail(job, contact) : await readyLinkedin(job, contact);
  const company = contact.companyId ? await getCompany(job.actor, contact.companyId).catch(() => null) : null;
  let values = storedValues(prospect.values);
  if (!prospect.filled_at) {
    job.writing ??= writingFor(job.actor);
    const writing = await job.writing;
    const filled = await fillVariables(
      {
        workspaceName: job.actor.workspaceName,
        campaign: { name: job.campaign.name, channel: job.campaign.channel, provider: job.campaign.provider, sequence: (job.campaign.sequence ?? []) as SequenceStep[] },
        variables: job.variables,
        valueLimit: job.provider.valueLimit,
        token: job.provider.variableToken,
        contact,
        company,
        runSteps: job.runSteps,
        brand: writing.brand,
        proof: writing.proof,
        sender: writing.sender,
      },
      { fetchImpl: job.fetchImpl, deadline: job.deadline },
    );
    if (filled.problem) throw new Ended("skipped", filled.problem);
    values = filled.values;
    const saved = await query<{ ok: boolean }>("select private.campaign_fill_saved($1, $2, $3, $4::jsonb, $5::jsonb) as ok", [
      job.actor.workspaceId,
      prospect.id,
      job.holder,
      JSON.stringify(values),
      JSON.stringify(storedSources(filled.sources)),
    ]);
    if (!saved.rows[0]?.ok) throw new CrmError("conflict", "Someone else is adding this person.", 409, { retry: true });
  }
  return {
    prospect,
    lead: {
      key: prospect.id,
      email: prospectEmail(contact.email),
      linkedin: prospectLinkedin(contact.linkedinUrl),
      firstName: contact.firstName,
      lastName: contact.lastName,
      companyName: company?.name ?? contact.companyName,
      website: company?.website ?? (company?.domain ? `https://${company.domain}` : null),
      title: contact.jobTitle,
      senderId: await senderFor(job, contact),
      values,
    },
  };
}

async function fileAdded(job: Job, done: { prospect_id: string; event_id: string | null; contact_id: string | null; workflow_id: string | null; depth: number }[]) {
  const events = done.map((row) => row.event_id).filter((id): id is string => Boolean(id));
  await fireCampaignEvents(events).catch((error) => console.error("Couldn't fire campaign events", redactedError(error)));
  for (const row of done) {
    if (!row.contact_id || !row.event_id) continue;
    const provenance: Provenance = row.workflow_id
      ? { operation: "campaign_prospect_added", source: "workflow", workflowId: row.workflow_id, depth: row.depth, sourceUrl: `/workflows/${row.workflow_id}` }
      : { operation: "campaign_prospect_added", source: "campaign" };
    await withActor(job.actor, async (db) => {
      const existing = await db.query("select 1 from crm.activities where workspace_id = $1 and metadata->>'campaignAddedProspectId' = $2 limit 1", [
        job.actor.workspaceId,
        row.prospect_id,
      ]);
      if (existing.rows.length > 0) return;
      await createActivityInDb(
        db,
        job.actor,
        {
          type: "note",
          title: `Added to ${job.campaign.name || "a campaign"}`.slice(0, 200),
          contactId: row.contact_id,
          metadata: { campaignAddedProspectId: row.prospect_id, campaignId: job.campaign.id },
        },
        provenance,
      );
    }).catch((error) => console.error("Couldn't file a campaign add on the timeline", redactedError(error)));
  }
}

async function markPushed(job: Job, items: { id: string; externalLeadId: string | null; senderId: string | null }[]) {
  if (items.length === 0) return;
  const result = await query<{ prospect_id: string; event_id: string | null; contact_id: string | null; workflow_id: string | null; depth: number }>(
    "select * from private.campaign_push_done($1, $2::jsonb)",
    [job.actor.workspaceId, JSON.stringify(items.map((item) => ({ id: item.id, external_lead_id: item.externalLeadId, sender_id: item.senderId })))],
  );
  await fileAdded(job, result.rows);
}

async function lookUp(job: Job, lead: { email: string | null; linkedin: string | null }) {
  return job.provider.findLead(job.context, job.campaign.external_id, lead);
}

function lastingFailure(job: Job, error: unknown) {
  if (transient(job.provider, error) || mightHaveSent(job.provider, error)) return null;
  return failureText(error);
}

function stillFilling(items: Ready[]): ProspectOutcome[] {
  return items.map((item) => ({ prospectId: item.prospect.id, state: "filling", reason: null }));
}

async function sendOneByOne(job: Job, items: Ready[]) {
  const outcomes: ProspectOutcome[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const rest = items.slice(index + 1);
    try {
      outcomes.push(...(await send(job, [items[index]])));
    } catch (error) {
      await unsend(job, rest.map((item) => item.prospect.id));
      throw error;
    }
    if (job.halted) {
      await unsend(job, rest.map((item) => item.prospect.id));
      outcomes.push(...stillFilling(rest));
      break;
    }
  }
  return outcomes;
}

async function send(job: Job, items: Ready[]): Promise<ProspectOutcome[]> {
  if (items.length === 0) return [];
  const outcomes: ProspectOutcome[] = [];
  let pushed;
  try {
    pushed = await job.provider.pushLeads(job.context, job.campaign.external_id, items.map((item) => item.lead));
  } catch (error) {
    if (error instanceof ServiceBusy || rejectedKey(job, error)) {
      await unsend(job, items.map((item) => item.prospect.id));
      if (error instanceof ServiceBusy) throw error;
      job.halted = true;
      return stillFilling(items);
    }
    const lasting = lastingFailure(job, error);
    if (lasting && items.length > 1) return sendOneByOne(job, items);
    for (const item of items) {
      await end(job, item.prospect.id, lasting ? "failed" : null, lasting);
      outcomes.push({ prospectId: item.prospect.id, state: lasting ? "failed" : "pushing", reason: lasting });
    }
    if (!lasting) console.error(`Couldn't add prospects to ${job.provider.name}`, redactedError(error));
    return outcomes;
  }
  const done: { id: string; externalLeadId: string | null; senderId: string | null }[] = [];
  for (const item of items) {
    if (pushed.taken.has(item.lead.key)) {
      done.push({ id: item.prospect.id, externalLeadId: null, senderId: item.lead.senderId });
      continue;
    }
    if (pushed.unsure.has(item.lead.key)) {
      try {
        const found = await lookUp(job, item.lead);
        if (found) {
          done.push({ id: item.prospect.id, externalLeadId: found.externalLeadId, senderId: item.lead.senderId });
          continue;
        }
      } catch (error) {
        await end(job, item.prospect.id, null, null);
        outcomes.push({ prospectId: item.prospect.id, state: "pushing", reason: null });
        if (error instanceof ServiceBusy) throw error;
        continue;
      }
    }
    await end(job, item.prospect.id, "failed", tookIt(job.provider));
    outcomes.push({ prospectId: item.prospect.id, state: "failed", reason: tookIt(job.provider) });
  }
  await markPushed(job, done);
  for (const item of done) outcomes.push({ prospectId: item.id, state: "pushed", reason: null });
  return outcomes;
}

async function push(job: Job, ready: Ready[]): Promise<ProspectOutcome[]> {
  const outcomes: ProspectOutcome[] = [];
  const begun: Ready[] = [];
  for (const item of ready) {
    const result = await query<Begun>("select * from private.campaign_push_begin($1, $2, $3)", [job.actor.workspaceId, item.prospect.id, job.holder]);
    const row = result.rows[0];
    if (!row?.ok) {
      outcomes.push({ prospectId: item.prospect.id, state: row?.reason ? "skipped" : item.prospect.state, reason: row?.reason ?? null });
      continue;
    }
    begun.push({ ...item, lead: { ...item.lead, email: row.email, linkedin: row.linkedin } });
  }
  outcomes.push(...(await send(job, begun)));
  return outcomes;
}

async function resumePushing(job: Job, prospect: ProspectRow): Promise<"pushed" | "again"> {
  const found = await lookUp(job, { email: prospect.email, linkedin: prospect.linkedin });
  if (!found) return "again";
  await markPushed(job, [{ id: prospect.id, externalLeadId: found.externalLeadId, senderId: prospect.sender_id }]);
  return "pushed";
}

async function prepareOne(job: Job, prospect: ProspectRow): Promise<Ready | ProspectOutcome> {
  if (prospect.state !== "filling" && prospect.state !== "pushing") return { prospectId: prospect.id, state: prospect.state, reason: prospect.skip_reason };
  try {
    if (prospect.state === "pushing" && (await resumePushing(job, prospect)) === "pushed") {
      return { prospectId: prospect.id, state: "pushed", reason: null };
    }
    return await prepare(job, prospect);
  } catch (error) {
    if (error instanceof Ended) {
      await end(job, prospect.id, error.state, error.message);
      return { prospectId: prospect.id, state: error.state, reason: error.message };
    }
    if (transient(job.provider, error)) {
      await end(job, prospect.id, null, null);
      if (!(error instanceof ServiceBusy) && !(error instanceof CrmError) && !(error instanceof LlmError) && !job.provider.failure(error)) {
        console.error("Couldn't fill a campaign prospect", redactedError(error));
      }
      throw error;
    }
    const reason = failureText(error);
    await end(job, prospect.id, "failed", reason);
    return { prospectId: prospect.id, state: "failed", reason };
  }
}

async function jobFor(actor: UserActor, campaignId: string, holder: string, options: { fetchImpl?: typeof fetch; deadline: number; runSteps?: unknown }): Promise<Job> {
  const { campaign, variables } = await withActor(actor, async (db) => {
    const campaign = await readCampaignTarget(db, actor.workspaceId, campaignId);
    return { campaign, variables: await readCampaignVariables(db, campaign) };
  });
  const refusal = addRefusal(campaign);
  if (refusal) throw new CrmError("conflict", refusal, 409);
  const { provider, context } = await connectedContext(actor.workspaceId, campaign.provider, { fetchImpl: options.fetchImpl });
  return { actor, campaign, variables, provider, context, holder, fetchImpl: options.fetchImpl, deadline: options.deadline, runSteps: options.runSteps };
}

function lastingSetup(error: unknown) {
  return error instanceof CrmError && error.status < 500 && error.status !== 429 && error.details?.retry !== true ? error.message : null;
}

export async function addOneNow(
  actor: UserActor,
  prospectId: string,
  holder: string,
  options: { fetchImpl?: typeof fetch; deadline: number; runSteps?: unknown },
): Promise<ProspectOutcome> {
  const claimed = await query<ClaimRow>("select * from private.campaign_claim_fill($1, $2, $3)", [actor.workspaceId, prospectId, holder]);
  const claim = claimed.rows[0];
  if (!claim) throw new CrmError("not_found", "Prospect not found.", 404);
  if (!claim.claimed) {
    if (claim.state === "queued" || claim.state === "filling" || claim.state === "pushing") throw new CrmError("conflict", "Someone else is adding this person. Try again.", 409, { retry: true });
    return { prospectId, state: claim.state, reason: claim.skip_reason };
  }
  const prospect = await readProspect(actor.workspaceId, prospectId, actor);
  if (!prospect) throw new CrmError("not_found", "Prospect not found.", 404);
  let job: Job;
  try {
    job = await jobFor(actor, prospect.campaign_id, holder, options);
  } catch (error) {
    const lasting = lastingSetup(error);
    await finish(actor.workspaceId, holder, prospectId, lasting ? "failed" : null, lasting);
    if (lasting) return { prospectId, state: "failed", reason: lasting };
    throw error;
  }
  try {
    const prepared = await prepareOne(job, prospect);
    if (!("lead" in prepared)) return prepared;
    const [outcome] = await push(job, [prepared]);
    return outcome;
  } catch (error) {
    if (error instanceof ServiceBusy || (error instanceof CrmError && error.details?.retry === true) || (error instanceof LlmError && error.retryable)) throw error;
    throw new CrmError("upstream_error", failureText(error), 502, { retry: true });
  }
}

export async function fillActor(workspaceId: string, provider: string, addedBy: string | null) {
  const added = addedBy ? await ownerActor(addedBy, workspaceId) : null;
  if (added) return added;
  const result = await query<{ provider: string; connected_by: string | null }>("select provider, connected_by from private.campaign_connection_targets($1)", [workspaceId]);
  return syncActor(workspaceId, result.rows.find((row) => row.provider === provider)?.connected_by ?? null);
}

type BatchRow = { prospect_id: string; campaign_id: string; workspace_id: string; added_by_user_id: string | null; provider: string };

export async function claimFillBatch(holder = `fill:${randomUUID()}`, limit = FILL_BATCH) {
  const claimed = await query<BatchRow>("select * from private.claim_campaign_fills($1, $2)", [limit, holder]);
  return claimed.rows.length > 0 ? { holder, rows: claimed.rows } : null;
}

async function releaseAll(workspaceId: string, holder: string, ids: string[]) {
  for (const id of ids) await query("select private.campaign_fill_end($1, $2, $3, null, null)", [workspaceId, id, holder]).catch(() => undefined);
}

async function runGroup(rows: BatchRow[], holder: string, options: { fetchImpl?: typeof fetch; deadline: number }) {
  const first = rows[0];
  const ids = rows.map((row) => row.prospect_id);
  const actor = await fillActor(first.workspace_id, first.provider, first.added_by_user_id);
  if (!actor) {
    await releaseAll(first.workspace_id, holder, ids);
    return [];
  }
  let job: Job;
  try {
    job = await jobFor(actor, first.campaign_id, holder, options);
  } catch (error) {
    const lasting = lastingSetup(error);
    for (const id of ids) await finish(first.workspace_id, holder, id, lasting ? "failed" : null, lasting);
    if (!lasting) throw error;
    return ids.map((id): ProspectOutcome => ({ prospectId: id, state: "failed", reason: lasting }));
  }
  const outcomes: ProspectOutcome[] = [];
  const ready: Ready[] = [];
  let next = 0;
  let stopped = false;
  const work = async () => {
    while (next < rows.length) {
      const row = rows[next++];
      if (stopped || job.halted || !timeLeft(options.deadline, FILL_RESERVE_MS)) {
        await end(job, row.prospect_id, null, null);
        continue;
      }
      try {
        const prospect = await readProspect(row.workspace_id, row.prospect_id, actor);
        if (!prospect) continue;
        const prepared = await prepareOne(job, prospect);
        if ("lead" in prepared) ready.push(prepared);
        else outcomes.push(prepared);
      } catch {
        stopped = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FILLS_AT_ONCE, rows.length) }, work));
  for (let start = 0; start < ready.length; start += job.provider.pushBatch) {
    const batch = ready.slice(start, start + job.provider.pushBatch);
    const untried = ready.slice(start + job.provider.pushBatch).map((item) => item.prospect.id);
    try {
      outcomes.push(...(await push(job, batch)));
    } catch (error) {
      await releaseAll(first.workspace_id, holder, untried);
      if (!(error instanceof ServiceBusy)) throw error;
      break;
    }
    if (job.halted) {
      await releaseAll(first.workspace_id, holder, untried);
      break;
    }
  }
  return outcomes;
}

export async function runFillBatch(batch: { holder: string; rows: BatchRow[] }, options: { fetchImpl?: typeof fetch; deadline: number }) {
  const groups = new Map<string, BatchRow[]>();
  for (const row of batch.rows) {
    const key = row.added_by_user_id ?? "";
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const outcomes: ProspectOutcome[] = [];
  for (const rows of groups.values()) {
    try {
      outcomes.push(...(await runGroup(rows, batch.holder, options)));
    } catch (error) {
      await releaseAll(rows[0].workspace_id, batch.holder, rows.map((row) => row.prospect_id));
      if (!(error instanceof ServiceBusy)) console.error("Campaign fill batch failed", redactedError(error));
    }
  }
  return outcomes;
}
