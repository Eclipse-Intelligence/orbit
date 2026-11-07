import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { GET as listActivities, POST as createActivity } from "@/app/api/v1/activities/route";
import { GET as listCompanies } from "@/app/api/v1/companies/route";
import { GET as listContacts } from "@/app/api/v1/contacts/route";
import { POST as bulkLeads } from "@/app/api/v1/leads/bulk/route";
import { POST as createLead } from "@/app/api/v1/leads/route";
import { POST as createOpportunity } from "@/app/api/v1/opportunities/route";
import { GET as staleRelationships } from "@/app/api/v1/relationships/stale/route";
import { bulkUpsertCompanies, createCompany } from "@/lib/crm/companies";
import { bulkIngestLeads } from "@/lib/crm/leads";
import { CrmError, itemFailure } from "@/lib/crm/errors";
import { SCOPES } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import { hasImpossibleDate } from "@/lib/crm/validation";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createAgent, createUser, resetDatabase } from "./helpers";

let owner: UserActor;
let token = "";
let companyId = "";

function request(path: string, method = "GET", body?: unknown) {
  return new Request(`http://crm.test/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

type ErrorBody = { error: { code: string; message: string; details: { field?: string } | null } };

before(async () => {
  await resetDatabase();
  owner = await createUser("api-input@example.com", "Mark Ridgeon");
  token = (await createAgent(owner.workspaceId, [...SCOPES].filter((scope) => scope !== "admin"), "Input agent")).token;
  companyId = (await createCompany(owner, { name: "Input Co", domain: "input.example" })).body.company.id;
});

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("API input checks", () => {
  it("refuses limits and offsets that aren't whole numbers with a 400 naming the field", async () => {
    for (const [route, path, field] of [
      [listCompanies, "/companies?limit=1.5", "limit"],
      [listCompanies, "/companies?offset=abc", "offset"],
      [listContacts, "/contacts?limit=2e1", "limit"],
      [staleRelationships, "/relationships/stale?days=1.5", "days"],
    ] as const) {
      const response = await route(request(path));
      assert.equal(response.status, 400, path);
      const body = (await response.json()) as ErrorBody;
      assert.equal(body.error.code, "invalid_input");
      assert.equal(body.error.details?.field, field);
      assert.match(body.error.message, new RegExp(`${field} must be a whole number`));
    }
    const fine = await listCompanies(request("/companies?limit=5&offset=0"));
    assert.equal(fine.status, 200);
    assert.equal(((await fine.json()) as { limit: number }).limit, 5);
    assert.equal((await listCompanies(request("/companies?limit=500"))).status, 200);
    const paging = async (path: string) => {
      const response = await listCompanies(request(path));
      assert.equal(response.status, 200, path);
      const body = (await response.json()) as { limit: number; offset: number };
      return [body.limit, body.offset];
    };
    assert.deepEqual(await paging("/companies?limit="), [50, 0]);
    assert.deepEqual(await paging("/companies?limit=-5"), [1, 0]);
    assert.deepEqual(await paging("/companies?offset=20000"), [50, 10000]);
  });

  it("refuses dates that aren't on the calendar", async () => {
    assert.equal(hasImpossibleDate("2026-02-30"), true);
    assert.equal(hasImpossibleDate("2026-02-30T10:00:00Z"), true);
    assert.equal(hasImpossibleDate("2028-02-29"), false);
    assert.equal(hasImpossibleDate("2026-11-03T09:00"), false);

    const range = await listActivities(request("/activities?from=2026-02-30T10:00:00Z"));
    assert.equal(range.status, 400);
    assert.equal(((await range.json()) as ErrorBody).error.details?.field, "from");

    const opportunity = await createOpportunity(request("/opportunities", "POST", { companyId, name: "Pilot", expectedCloseDate: "2026-02-30" }));
    assert.equal(opportunity.status, 400);
    const body = (await opportunity.json()) as ErrorBody;
    assert.equal(body.error.details?.field, "expectedCloseDate");
    assert.match(body.error.message, /expectedCloseDate/);

    const lead = await createLead(request("/leads", "POST", { company: { name: "Lead Co" }, task: { title: "Call", dueAt: "2026-04-31T09:00:00Z" } }));
    assert.equal(lead.status, 400);
    assert.equal(((await lead.json()) as ErrorBody).error.details?.field, "task.dueAt");

    const real = await createOpportunity(request("/opportunities", "POST", { companyId, name: "Leap year", expectedCloseDate: "2028-02-29" }));
    assert.equal(real.status, 201);
  });

  it("saves each bulk lead on its own and reports the bad one", async () => {
    const response = await bulkLeads(
      request("/leads/bulk", "POST", {
        leads: [
          { company: { name: "Bulk One", domain: "bulk-one.example" } },
          { company: { name: "Bulk Two", domain: "bulk-two.example" }, opportunity: { name: "Deal", expectedCloseDate: "2026-02-30" } },
          { company: { name: "Bulk Three", domain: "bulk-three.example" }, task: { title: "Call", dueAt: "2026-02-31" } },
          { company: { name: "Bulk Four", domain: "bulk-four.example" }, opportunity: { name: "Deal", expectedCloseDate: "2026-03-01" } },
        ],
      }),
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { results: { index: number; status: string; error?: { code: string; message: string } }[] };
    assert.deepEqual(body.results.map((result) => result.status), ["created", "error", "error", "created"]);
    assert.match(body.results[1].error?.message ?? "", /opportunity\.expectedCloseDate/);
    assert.match(body.results[2].error?.message ?? "", /task\.dueAt/);
    const saved = await getAdminPool().query<{ domain: string }>(
      "select domain from crm.companies where workspace_id = $1 and domain like 'bulk-%' order by domain",
      [owner.workspaceId],
    );
    assert.deepEqual(saved.rows.map((row) => row.domain), ["bulk-four.example", "bulk-one.example"]);
  });

  it("answers a value the database refuses with a 400, not a 500", async () => {
    const hour = await createActivity(request("/activities", "POST", { type: "note", body: "Late", companyId, occurredAt: "2026-11-03T25:00:00Z" }));
    assert.equal(hour.status, 400);
    assert.equal(((await hour.json()) as ErrorBody).error.code, "invalid_input");
    const refused = await createActivity(request("/activities", "POST", { type: "note", title: "Null\u0000byte", body: "Note", companyId }));
    assert.equal(refused.status, 400);
    const body = (await refused.json()) as ErrorBody;
    assert.equal(body.error.code, "invalid_input");
    assert.match(body.error.message, /A value in the request is invalid/);
  });

  it("commits the good items when one item hits a database error", async () => {
    const companies = await bulkUpsertCompanies(owner, [
      { name: "Good One", domain: "good-one.example" },
      { name: "Bad\u0000Co", domain: "bad-null.example" },
      { name: "Good Two", domain: "good-two.example" },
    ]);
    assert.deepEqual(companies.body.results.map((result) => result.status), ["created", "error", "created"]);
    assert.match(companies.body.results[1].error?.message ?? "", /A value in this item is invalid/);
    const leads = await bulkIngestLeads(owner, [
      { company: { name: "Lead Good", domain: "lead-good.example" } },
      { company: { name: "Lead\u0000Bad", domain: "lead-bad.example" } },
      { company: { name: "Lead Fine", domain: "lead-fine.example" }, task: { title: "Call", dueAt: "2026-11-30T09:00" } },
    ]);
    assert.deepEqual(leads.body.results.map((result) => result.status), ["created", "error", "created"]);
    assert.match(leads.body.results[1].error?.message ?? "", /A value in this item is invalid/);
    const saved = await getAdminPool().query<{ domain: string }>(
      "select domain from crm.companies where workspace_id = $1 and domain = any($2::text[]) order by domain",
      [owner.workspaceId, ["good-one.example", "bad-null.example", "good-two.example", "lead-good.example", "lead-bad.example", "lead-fine.example"]],
    );
    assert.deepEqual(saved.rows.map((row) => row.domain), ["good-one.example", "good-two.example", "lead-fine.example", "lead-good.example"]);
    const task = await getAdminPool().query("select 1 from crm.tasks where workspace_id = $1 and title = 'Call'", [owner.workspaceId]);
    assert.equal(task.rowCount, 1);
  });

  it("treats a database data error in one item as that item's error", () => {
    assert.deepEqual(itemFailure(new CrmError("invalid_input", "Nope.", 400)), { code: "invalid_input", message: "Nope." });
    assert.equal(itemFailure(Object.assign(new Error("date/time field value out of range"), { code: "22008" }))?.code, "invalid_input");
    assert.equal(itemFailure(Object.assign(new Error("duplicate"), { code: "23505" }))?.code, "conflict");
    assert.equal(itemFailure(Object.assign(new Error("connection reset"), { code: "ECONNRESET" })), null);
    assert.equal(itemFailure(new Error("boom")), null);
  });
});
