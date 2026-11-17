import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { mergeCompanies, mergeContacts } from "@/lib/crm/merge";
import { moveRecordsToWorkspace, previewMoveToWorkspace } from "@/lib/crm/move-workspace";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import { createWorkspace } from "@/lib/crm/workspaces";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createUser, resetDatabase, useServerlessPool } from "./helpers";

const PROVENANCE = { operation: "campaign_records_test", source: "test" };

let eclipse: UserActor;
let ridgeon: UserActor;

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

async function contact(input: Record<string, unknown>) {
  return (await createContact(eclipse, input, { provenance: PROVENANCE })).body.contact;
}

async function company(name: string, domain: string) {
  return (await createCompany(eclipse, { name, domain }, { provenance: PROVENANCE })).body.company;
}

let campaignCount = 0;

async function campaign(name: string, status = "active") {
  campaignCount += 1;
  const rows = await sql<{ id: string }>(
    "insert into crm.campaigns (workspace_id, provider, channel, external_id, name, status) values ($1, 'smartlead', 'email', $2, $3, $4) returning id",
    [eclipse.workspaceId, String(9000 + campaignCount), name, status],
  );
  return rows[0].id;
}

async function prospect(campaignId: string, values: { contactId?: string | null; companyId?: string | null; email?: string; lead?: string; state?: string; leadStatus?: string; stoppedAt?: string | null; repliedAt?: string | null }) {
  const rows = await sql<{ id: string }>(
    `insert into crm.campaign_prospects (workspace_id, campaign_id, contact_id, company_id, email, external_lead_id, state, lead_status, stopped_at, replied_at, last_event_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) returning id`,
    [
      eclipse.workspaceId,
      campaignId,
      values.contactId ?? null,
      values.companyId ?? null,
      values.email ?? null,
      values.lead ?? null,
      values.state ?? "pushed",
      values.leadStatus ?? "in_progress",
      values.stoppedAt ?? null,
      values.repliedAt ?? null,
    ],
  );
  return rows[0].id;
}

async function event(campaignId: string, prospectId: string, kind: string, key: string) {
  await sql(
    "insert into crm.campaign_events (workspace_id, campaign_id, prospect_id, kind, step, occurred_at, dedupe_key) values ($1, $2, $3, $4, 1, now(), $5)",
    [eclipse.workspaceId, campaignId, prospectId, kind, key],
  );
}

function refused(pattern: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof CrmError, String(error));
    assert.match(error.message, pattern);
    return true;
  };
}

describe("campaign prospects when records merge or move", () => {
  before(async () => {
    await resetDatabase();
    const mark = await createUser("mark@campaign-records.test", "Mark Ridgeon");
    await sql("update crm.workspaces set name = 'Eclipse' where id = $1", [mark.workspaceId]);
    eclipse = { ...mark, workspaceName: "Eclipse" };
    const created = await createWorkspace(eclipse, { name: "Mark Ridgeon" });
    ridgeon = { ...eclipse, workspaceId: created.id, workspaceName: "Mark Ridgeon", role: "owner", scopes: scopesForRole("owner") };
  });

  after(async () => {
    await getPool().end();
    await getAdminPool().end();
  });

  useServerlessPool();

  it("keeps one row per campaign when contacts merge, with the other row's events", async () => {
    const keep = await contact({ firstName: "Sarah", lastName: "Kent", email: "sarah@northfold.test" });
    const merge = await contact({ firstName: "Sarah", lastName: "Kent", email: "s.kent@northfold.test" });
    const shared = await campaign("Agency outreach");
    const only = await campaign("Founders");
    const kept = await prospect(shared, { contactId: keep.id, email: "sarah@northfold.test", lead: "lead-1" });
    const merged = await prospect(shared, { contactId: merge.id, email: "s.kent@northfold.test", lead: "lead-2", repliedAt: "2026-11-10T09:00:00Z" });
    const elsewhere = await prospect(only, { contactId: merge.id, email: "s.kent@northfold.test", lead: "lead-3" });
    await event(shared, kept, "sent", "k1");
    await event(shared, merged, "sent", "m1");
    await event(shared, merged, "replied", "m2");

    const result = await mergeContacts(eclipse, keep.id, merge.id, PROVENANCE);
    assert.equal(result.moved.campaign_prospects, 1);
    assert.equal(result.moved.campaign_prospects_combined, 1);

    const rows = await sql<{ id: string; contact_id: string; replied_at: Date | null }>(
      "select id, contact_id, replied_at from crm.campaign_prospects where workspace_id = $1 order by created_at",
      [eclipse.workspaceId],
    );
    assert.deepEqual(rows.map((row) => row.id), [kept, elsewhere]);
    assert.ok(rows.every((row) => row.contact_id === keep.id));
    assert.equal(rows[0].replied_at?.toISOString(), "2026-11-10T09:00:00.000Z");
    const events = await sql<{ prospect_id: string }>("select distinct prospect_id from crm.campaign_events where campaign_id = $1", [shared]);
    assert.deepEqual(events.map((row) => row.prospect_id), [kept]);
  });

  it("points prospects at the kept company when companies merge", async () => {
    const keep = await company("Brightlane", "brightlane.test");
    const merge = await company("Brightlane Ltd", "brightlane-ltd.test");
    const id = await campaign("Company merge");
    const row = await prospect(id, { companyId: merge.id, email: "tom@brightlane.test" });
    const result = await mergeCompanies(eclipse, keep.id, merge.id, PROVENANCE);
    assert.equal(result.moved.campaign_prospects, 1);
    const after = await sql<{ company_id: string }>("select company_id from crm.campaign_prospects where id = $1", [row]);
    assert.equal(after[0].company_id, keep.id);
  });

  it("refuses to move someone who is active in a campaign, in the preview and the move", async () => {
    const priya = await contact({ firstName: "Priya", lastName: "Shah", email: "priya@halcyon.test" });
    const id = await campaign("Halcyon outreach");
    const row = await prospect(id, { contactId: priya.id, email: "priya@halcyon.test" });

    const preview = await previewMoveToWorkspace(eclipse, { contactIds: [priya.id], workspaceId: ridgeon.workspaceId });
    assert.equal(preview.campaignConflict, "Priya Shah is in Halcyon outreach. Remove them from campaigns first.");
    await assert.rejects(
      moveRecordsToWorkspace(eclipse, { contactIds: [priya.id], workspaceId: ridgeon.workspaceId }, PROVENANCE),
      refused(/^Priya Shah is in Halcyon outreach\. Remove them from campaigns first\.$/),
    );

    const copied = await moveRecordsToWorkspace(eclipse, { contactIds: [priya.id], workspaceId: ridgeon.workspaceId, copy: true }, PROVENANCE);
    assert.match(copied.message, /^Copied/);

    for (const state of ["queued", "filling", "pushing"]) {
      await sql("update crm.campaign_prospects set state = $2 where id = $1", [row, state]);
      const blocked = await previewMoveToWorkspace(eclipse, { contactIds: [priya.id], workspaceId: ridgeon.workspaceId });
      assert.ok(blocked.campaignConflict, state);
    }
    await sql("update crm.campaign_prospects set state = 'pushed', stop_requested_at = now() where id = $1", [row]);
    assert.ok((await previewMoveToWorkspace(eclipse, { contactIds: [priya.id], workspaceId: ridgeon.workspaceId })).campaignConflict);
  });

  it("refuses to move a company whose people are active in a campaign", async () => {
    const lumen = await company("Lumen", "lumen.test");
    const ben = await contact({ firstName: "Ben", lastName: "Hart", email: "ben@lumen.test", companyId: lumen.id });
    const id = await campaign("Lumen outreach");
    await prospect(id, { contactId: ben.id, companyId: lumen.id, email: "ben@lumen.test" });
    const preview = await previewMoveToWorkspace(eclipse, { companyIds: [lumen.id], workspaceId: ridgeon.workspaceId });
    assert.equal(preview.campaignConflict, "Ben Hart is in Lumen outreach. Remove them from campaigns first.");
    await assert.rejects(moveRecordsToWorkspace(eclipse, { companyIds: [lumen.id], workspaceId: ridgeon.workspaceId }, PROVENANCE), refused(/Remove them from campaigns first\./));
  });

  it("moves people whose campaigns are over and clears the rows left behind", async () => {
    const fernway = await company("Fernway", "fernway.test");
    const joe = await contact({ firstName: "Joe", lastName: "Mills", email: "joe@fernway.test", companyId: fernway.id });
    const stopped = await campaign("Stopped outreach");
    const finished = await campaign("Finished outreach", "completed");
    const skipped = await campaign("Skipped outreach");
    const done = await campaign("Done outreach");
    const rows = [
      await prospect(stopped, { contactId: joe.id, companyId: fernway.id, email: "joe@fernway.test", stoppedAt: new Date().toISOString() }),
      await prospect(finished, { contactId: joe.id, companyId: fernway.id, email: "joe@fernway.test" }),
      await prospect(skipped, { contactId: joe.id, companyId: fernway.id, email: "joe@fernway.test", state: "skipped" }),
      await prospect(done, { contactId: joe.id, companyId: fernway.id, email: "joe@fernway.test", leadStatus: "completed" }),
    ];
    const preview = await previewMoveToWorkspace(eclipse, { companyIds: [fernway.id], workspaceId: ridgeon.workspaceId });
    assert.equal(preview.campaignConflict, null);
    await moveRecordsToWorkspace(eclipse, { companyIds: [fernway.id], workspaceId: ridgeon.workspaceId }, PROVENANCE);
    const left = await sql<{ workspace_id: string; contact_id: string | null; company_id: string | null; email: string }>(
      "select workspace_id, contact_id, company_id, email from crm.campaign_prospects where id = any($1::uuid[])",
      [rows],
    );
    assert.equal(left.length, 4);
    assert.ok(left.every((row) => row.workspace_id === eclipse.workspaceId && row.contact_id === null && row.company_id === null && row.email === "joe@fernway.test"));
    const crossed = await sql(
      `select p.id from crm.campaign_prospects p join crm.contacts c on c.id = p.contact_id where c.workspace_id <> p.workspace_id
       union all select p.id from crm.campaign_prospects p join crm.companies c on c.id = p.company_id where c.workspace_id <> p.workspace_id`,
    );
    assert.deepEqual(crossed, []);
  });
});
