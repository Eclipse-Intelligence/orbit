import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { describeAction, recordNames, runTool } from "@/lib/assistant/tools";
import { createActivity } from "@/lib/crm/activities";
import { createCompany, listCompanies } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { setRelationshipOverride } from "@/lib/crm/relationship-override";
import type { RelationshipLabel } from "@/lib/crm/relationship-score";
import { relationshipsFor } from "@/lib/crm/relationship-signals";
import { getCompanyContext } from "@/lib/crm/relationships";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createUser, resetDatabase } from "./helpers";

describe("relationship overrides", () => {
  let owner: UserActor;
  let acme: string;
  let jane: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("override@orbit.test", "Mark Ridgeon");
    acme = (await createCompany(owner, { name: "Acme Override", domain: "acme-override.test" })).body.company.id;
    jane = (await createContact(owner, { firstName: "Jane", lastName: "Doe", email: "jane@acme-override.test", companyId: acme })).body.contact.id;
    await createActivity(owner, {
      type: "email",
      title: "Re: renewal",
      contactId: jane,
      companyId: acme,
      occurredAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      metadata: { direction: "inbound", source: "microsoft" },
    });
  });

  after(async () => {
    await getPool().end();
  });

  it("replaces the computed label with the override and its reason, until it is cleared", async () => {
    const computed = (await relationshipsFor(owner, "company", [acme]))[acme];
    assert.equal(computed.label, "warm");
    assert.equal(computed.override, undefined);

    const set = await setRelationshipOverride(owner, "company", acme, { label: "cold", reason: "They told us they've signed with a competitor." }, { operation: "set_relationship", source: "web" });
    assert.equal(set.changed, true);
    const overridden = (await relationshipsFor(owner, "company", [acme]))[acme];
    assert.equal(overridden.label, "cold");
    assert.equal(overridden.reason, "They told us they've signed with a competitor.");
    assert.equal(overridden.override?.byUserId, owner.userId);
    assert.equal(overridden.override?.byName, "Mark Ridgeon");
    assert.ok(overridden.override?.at);
    assert.equal(overridden.automatic?.label, "warm");

    const listed = await listCompanies(owner, { relationships: true });
    assert.equal(listed.data.find((company) => company.id === acme)?.relationship?.label, "cold");
    assert.equal((await getCompanyContext(owner, acme)).relationship.label, "cold");

    const audit = await getAdminPool().query<{ changes: { fields: string[]; before: Record<string, unknown>; after: Record<string, unknown> } }>(
      "select changes from crm.audit_events where entity_id = $1 and event_type = 'company.updated' order by created_at desc limit 1",
      [acme],
    );
    assert.deepEqual(audit.rows[0].changes.fields, ["relationshipOverride", "relationshipOverrideReason"]);
    assert.deepEqual(audit.rows[0].changes.before, { relationshipOverride: null, relationshipOverrideReason: null });
    assert.equal(audit.rows[0].changes.after.relationshipOverride, "cold");

    const again = await setRelationshipOverride(owner, "company", acme, { label: "cold", reason: "They told us they've signed with a competitor." }, { operation: "set_relationship" });
    assert.equal(again.changed, false);

    await setRelationshipOverride(owner, "company", acme, { label: null }, { operation: "set_relationship", source: "web" });
    const cleared = (await relationshipsFor(owner, "company", [acme]))[acme];
    assert.equal(cleared.label, "warm");
    assert.equal(cleared.override, undefined);
    const row = await getAdminPool().query("select relationship_override, relationship_override_reason, relationship_override_at, relationship_override_by from crm.companies where id = $1", [acme]);
    assert.deepEqual(row.rows[0], { relationship_override: null, relationship_override_reason: null, relationship_override_at: null, relationship_override_by: null });
  });

  it("overrides a contact without touching the company, and works with no reason", async () => {
    await setRelationshipOverride(owner, "contact", jane, { label: "strong" }, { operation: "set_relationship", source: "web" });
    const contact = (await relationshipsFor(owner, "contact", [jane]))[jane];
    assert.equal(contact.label, "strong");
    assert.equal(contact.override?.reason, null);
    assert.equal(contact.reason, "Set by hand.");
    assert.equal((await relationshipsFor(owner, "company", [acme]))[acme].label, "warm");
    await setRelationshipOverride(owner, "contact", jane, { label: null }, { operation: "set_relationship" });
  });

  it("refuses labels it doesn't know and records in another workspace", async () => {
    await assert.rejects(
      setRelationshipOverride(owner, "company", acme, { label: "lukewarm" as RelationshipLabel }, { operation: "set_relationship" }),
      (error: unknown) => error instanceof CrmError && error.code === "invalid_input",
    );
    const stranger = await createUser("override-other@orbit.test", "Other");
    await assert.rejects(
      setRelationshipOverride(stranger, "company", acme, { label: "cold" }, { operation: "set_relationship" }),
      (error: unknown) => error instanceof CrmError && error.code === "not_found",
    );
  });

  it("sets and clears it from the assistant, with the old and new label on the card", async () => {
    const args = { companyId: acme, relationship: "one_sided", reason: "Three follow-ups with no reply." };
    const card = describeAction("set_relationship", args, await recordNames(owner, [args], ["set_relationship"]));
    assert.equal(card.title, "Set relationship: Acme Override");
    assert.deepEqual(card.lines, ["From: Warm (automatic)", "To: One-sided", "Why: Three follow-ups with no reply."]);

    const result = (await runTool(owner, "set_relationship", args)) as { relationship: { label: string; reason: string } };
    assert.equal(result.relationship.label, "one_sided");
    assert.equal(result.relationship.reason, "Three follow-ups with no reply.");

    const clear = { companyId: acme, relationship: "auto" };
    const clearing = describeAction("set_relationship", clear, await recordNames(owner, [clear], ["set_relationship"]));
    assert.deepEqual(clearing.lines, ["From: One-sided (set by hand)", "To: Automatic (Warm)"]);
    const cleared = (await runTool(owner, "set_relationship", clear)) as { relationship: { label: string; override?: unknown } };
    assert.equal(cleared.relationship.label, "warm");
    assert.equal(cleared.relationship.override, undefined);

    const missing = (await runTool(owner, "set_relationship", { relationship: "cold" })) as { error: string };
    assert.match(missing.error, /companyId or a contactId/);
  });
});
