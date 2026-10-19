import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { runTool } from "@/lib/assistant/tools";
import { createCompany, getCompany, listCompanies, updateCompany } from "@/lib/crm/companies";
import { deleteLifecycle, listLifecycles, renameLifecycle } from "@/lib/crm/lifecycles";
import { createOpportunity, listPipeline, updateOpportunity } from "@/lib/crm/opportunities";
import { companyQueryFromSearchParams } from "@/lib/crm/validation";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createUser, resetDatabase } from "./helpers";

describe("lifecycles", () => {
  let owner: UserActor;

  before(async () => {
    await resetDatabase();
    owner = await createUser("lifecycles@orbit.test", "Mark Ridgeon");
  });

  after(async () => {
    await getPool().end();
  });

  it("takes any name, reuses an existing spelling and keeps the built-in ones", async () => {
    const adviser = (await createCompany(owner, { name: "Adviser Ltd", lifecycle: "Consultant" })).body.company;
    assert.equal(adviser.lifecycle, "Consultant");
    const second = (await createCompany(owner, { name: "Second Adviser", lifecycle: "  consultant " })).body.company;
    assert.equal(second.lifecycle, "Consultant");
    const client = (await createCompany(owner, { name: "Client Co", lifecycle: "Customer" })).body.company;
    assert.equal(client.lifecycle, "customer");
    const plain = (await createCompany(owner, { name: "Plain Co" })).body.company;
    assert.equal(plain.lifecycle, "lead");
    const personal = await updateCompany(owner, plain.id, { lifecycle: "Personal" });
    assert.equal(personal.body.company.lifecycle, "Personal");
    await assert.rejects(updateCompany(owner, plain.id, { lifecycle: "   " }), /Give the lifecycle a name/);

    const listed = await listLifecycles(owner);
    assert.deepEqual(
      listed.map((item) => [item.label, item.companies, item.builtIn]),
      [
        ["Lead", 0, true],
        ["Prospect", 0, true],
        ["Customer", 1, true],
        ["Churned", 0, true],
        ["Consultant", 2, false],
        ["Personal", 1, false],
      ],
    );

    const filter = companyQueryFromSearchParams(new URLSearchParams("lifecycle=consultant"));
    assert.deepEqual(
      (await listCompanies(owner, filter)).data.map((company) => company.name).sort(),
      ["Adviser Ltd", "Second Adviser"],
    );
    assert.equal((await listCompanies(owner, companyQueryFromSearchParams(new URLSearchParams("lifecycle=Customer")))).data[0].name, "Client Co");
  });

  it("renames, merges and deletes custom lifecycles, but not the built-in ones", async () => {
    assert.deepEqual(await renameLifecycle(owner, "Consultant", "Advisor"), { companies: 2 });
    assert.deepEqual(await renameLifecycle(owner, "Advisor", "advisor"), { companies: 2 });
    assert.equal((await listCompanies(owner, { lifecycle: "advisor" })).data.length, 2);
    await assert.rejects(renameLifecycle(owner, "Lead", "Cold"), /built in/);
    await assert.rejects(deleteLifecycle(owner, "customer"), /built in/);

    assert.deepEqual(await renameLifecycle(owner, "Personal", "advisor"), { companies: 1 });
    assert.equal((await listCompanies(owner, { lifecycle: "advisor" })).data.length, 3);

    const audit = await getAdminPool().query<{ operation: string }>(
      "select operation from crm.audit_events where event_type = 'company.updated' and operation = 'rename_lifecycle'",
    );
    assert.equal(audit.rows.length, 5);

    assert.deepEqual(await deleteLifecycle(owner, "advisor"), { companies: 3 });
    assert.equal((await listCompanies(owner, { lifecycle: "lead" })).data.length, 3);
    assert.ok(!(await listLifecycles(owner)).some((item) => !item.builtIn));
  });

  it("still makes a custom-lifecycle company a Customer when a deal is won, and lets the assistant set any lifecycle", async () => {
    const company = (await createCompany(owner, { name: "Partner Co", lifecycle: "Partner" })).body.company;
    const won = (await listPipeline(owner)).stages.find((stage) => stage.isWon)!;
    const deal = (await createOpportunity(owner, { companyId: company.id, name: "Partner deal" })).body.opportunity;
    await updateOpportunity(owner, deal.id, { stageId: won.id });
    assert.equal((await getCompany(owner, company.id)).lifecycle, "customer");

    const result = (await runTool(owner, "update_company", { companyId: company.id, lifecycle: "Personal life" })) as { company: { lifecycle: string } };
    assert.equal(result.company.lifecycle, "Personal life");
    const lifecycles = (await runTool(owner, "list_lifecycles", {})) as { lifecycles: { label: string }[] };
    assert.ok(lifecycles.lifecycles.some((item) => item.label === "Personal life"));
  });
});
