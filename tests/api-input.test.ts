import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { GET as listActivities } from "@/app/api/v1/activities/route";
import { GET as listCompanies } from "@/app/api/v1/companies/route";
import { GET as listContacts } from "@/app/api/v1/contacts/route";
import { POST as bulkLeads } from "@/app/api/v1/leads/bulk/route";
import { POST as createLead } from "@/app/api/v1/leads/route";
import { POST as createOpportunity } from "@/app/api/v1/opportunities/route";
import { GET as staleRelationships } from "@/app/api/v1/relationships/stale/route";
import { createCompany } from "@/lib/crm/companies";
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

  it("treats a database data error in one item as that item's error", () => {
    assert.deepEqual(itemFailure(new CrmError("invalid_input", "Nope.", 400)), { code: "invalid_input", message: "Nope." });
    assert.equal(itemFailure(Object.assign(new Error("date/time field value out of range"), { code: "22008" }))?.code, "invalid_input");
    assert.equal(itemFailure(Object.assign(new Error("duplicate"), { code: "23505" }))?.code, "conflict");
    assert.equal(itemFailure(Object.assign(new Error("connection reset"), { code: "ECONNRESET" })), null);
    assert.equal(itemFailure(new Error("boom")), null);
  });
});
