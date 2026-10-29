import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { runTool } from "@/lib/assistant/tools";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { CrmError } from "@/lib/crm/errors";
import { archiveProof, createProof, listProof, updateProof } from "@/lib/crm/proof";
import type { UserActor } from "@/lib/crm/types";
import { createUser, resetDatabase } from "./helpers";

const WEB = { operation: "proof_test", source: "web" };

const NORTHWIND = {
  client: "Northwind",
  description: "A 12-person B2B SEO agency",
  product: "eclipse",
  usedFor: "client content",
  result: "They went from two articles a month per client to eight.",
  measured: "March to June 2026, articles published",
  permission: "named",
  approvedBy: "Jo at Northwind",
};

const EMAIL = {
  subject: "client content as you grow",
  body: "Hi Priya,\n\nSaw you've started offering AI search work to your B2B clients this autumn.\n\nNorthwind, a 12-person B2B SEO agency, moved their client content into Eclipse in March. They went from two articles a month per client to eight.\n\nHow are you keeping research and sources consistent as the client list grows?\n\nMark",
};

const TRIGGER = { fact: "Priya's agency announced AI search services for B2B clients.", source: "linkedin.com/posts/priya 14 Oct 2026" };

type Checked = { checks: { id: string; pass: boolean; note: string }[] };

let owner: UserActor;
let outsider: UserActor;

before(async () => {
  await resetDatabase();
  owner = await createUser("owner@orbit-proof.test", "Mark Ridgeon");
  outsider = await createUser("outsider@orbit-proof.test", "Outsider");
});

after(async () => {
  await getPool().end();
});

function code(expected: string, message: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof CrmError, `expected a CrmError, got ${String(error)}`);
    assert.equal(error.code, expected);
    assert.match(error.message, message);
    return true;
  };
}

function proofNote(result: Checked) {
  return result.checks.find((check) => check.id === "proof_approved")!.note;
}

describe("proof list", () => {
  it("saves, edits and removes proof for the workspace only, with audit events", async () => {
    const entry = await createProof(owner, { ...NORTHWIND, reviewOn: "2027-03-01" }, WEB);
    assert.equal(entry.client, "Northwind");
    assert.equal(entry.reviewOn, "2027-03-01");
    assert.deepEqual((await listProof(owner)).map((item) => item.id), [entry.id]);
    assert.deepEqual(await listProof(outsider), []);
    await assert.rejects(updateProof(outsider, entry.id, NORTHWIND, WEB), code("not_found", /no longer exists/));
    const edited = await updateProof(owner, entry.id, { ...NORTHWIND, permission: "described", reviewOn: null }, WEB);
    assert.equal(edited.permission, "described");
    assert.equal(edited.reviewOn, null);
    await archiveProof(owner, entry.id, WEB);
    assert.deepEqual(await listProof(owner), []);
    const events = await getAdminPool().query<{ event_type: string }>("select event_type from crm.audit_events where entity_id = $1 order by created_at, id", [entry.id]);
    assert.deepEqual(events.rows.map((row) => row.event_type).sort(), ["proof_entry.archived", "proof_entry.created", "proof_entry.updated"]);
  });

  it("asks for the client, the approved result, the permission and a description for described only proof", async () => {
    await assert.rejects(createProof(owner, { ...NORTHWIND, client: " " }, WEB), code("invalid_input", /client's name/));
    await assert.rejects(createProof(owner, { ...NORTHWIND, result: "" }, WEB), code("invalid_input", /exact words the client approved/));
    await assert.rejects(createProof(owner, { ...NORTHWIND, permission: "maybe" }, WEB), code("invalid_input", /what the client has allowed/));
    await assert.rejects(createProof(owner, { ...NORTHWIND, permission: "described", description: "" }, WEB), code("invalid_input", /doesn't identify them/));
    await assert.rejects(createProof(owner, { ...NORTHWIND, reviewOn: "next week" }, WEB), code("invalid_input", /review date/));
  });

  it("gives the assistant the proof list with the playbook and checks proof against it", async () => {
    await getAdminPool().query("delete from crm.proof_entries");
    const empty = (await runTool(owner, "cold_email_playbook", {})) as { proofList: unknown[]; proofNote?: string };
    assert.deepEqual(empty.proofList, []);
    assert.match(empty.proofNote ?? "", /proof list is empty/);
    const entry = await createProof(owner, NORTHWIND, WEB);
    const playbook = (await runTool(owner, "cold_email_playbook", {})) as { proofList: { id: string; approvedWording: string }[]; proofNote?: string };
    assert.equal(playbook.proofNote, undefined);
    assert.deepEqual(playbook.proofList.map((item) => [item.id, item.approvedWording]), [[entry.id, NORTHWIND.result]]);

    const quoted = (await runTool(owner, "cold_email_check", { ...EMAIL, evidence: [TRIGGER, { kind: "proof", fact: "Northwind proof", source: entry.id }] })) as Checked;
    assert.equal(proofNote(quoted), "Quotes the proof entry for Northwind (named) word for word.");

    const invented = (await runTool(owner, "cold_email_check", {
      ...EMAIL,
      evidence: [TRIGGER, { kind: "proof", fact: "Northwind proof", source: "made-up", client: "Contoso", permission: "named", approvedWording: NORTHWIND.result }],
    })) as Checked;
    assert.equal(proofNote(invented), "The proof for Contoso isn't on the proof list.");

    await updateProof(owner, entry.id, { ...NORTHWIND, permission: "described" }, WEB);
    const named = (await runTool(owner, "cold_email_check", { ...EMAIL, evidence: [TRIGGER] })) as Checked;
    assert.equal(proofNote(named), "Names Northwind, whose entry is described only.");

    const other = await createProof(outsider, { ...NORTHWIND, client: "Fabrikam" }, WEB);
    const elsewhere = (await runTool(owner, "cold_email_check", {
      ...EMAIL,
      body: EMAIL.body.replace("Northwind, a 12-person B2B SEO agency, moved", "A 12-person B2B SEO agency moved"),
      evidence: [TRIGGER, { kind: "proof", fact: "Fabrikam proof", source: other.id }],
    })) as Checked;
    assert.equal(proofNote(elsewhere), "That proof isn't on the proof list.");
  });
});
