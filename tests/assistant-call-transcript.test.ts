import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { outsideRead } from "@/lib/assistant/web-gate";
import { runTool, toolDefinitions } from "@/lib/assistant/tools";
import { createActivity } from "@/lib/crm/activities";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createUser, resetDatabase } from "./helpers";

const TRANSCRIPT = Array.from(
  { length: 3000 },
  (_, index) => `${index % 2 ? "Jane Doe" : "Mark Ridgeon"}: marker-${index}-end ${"word ".repeat(30).trim()}`,
).join("\n");

type Page = { transcript: string; totalLength: number; offset: number; nextOffset: number | null };

describe("assistant call transcripts", () => {
  let owner: UserActor;
  let companyId: string;
  let contactId: string;
  let insightId: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("assistant-transcript@example.com", "Mark Ridgeon");
    const company = await createCompany(owner, { name: "Acme", domain: "acme.test" });
    companyId = company.body.company.id;
    const contact = await createContact(owner, { companyId, firstName: "Jane", lastName: "Doe" });
    contactId = contact.body.contact.id;
    const logged = await createActivity(owner, {
      type: "call",
      title: "Call with Jane Doe",
      body: "Outgoing call",
      contactId,
      companyId,
      occurredAt: "2026-10-15T13:00:00.000Z",
    });
    const inserted = await getAdminPool().query<{ id: string }>(
      `insert into crm.call_insights (workspace_id, activity_id, contact_id, company_id, source, transcript, summary, status)
       values ($1, $2, $3, $4, 'manual', $5, 'Mark and Jane reviewed the quote.', 'ready') returning id`,
      [owner.workspaceId, logged.body.activity.id, contactId, companyId, TRANSCRIPT],
    );
    insightId = inserted.rows[0].id;
  });

  after(async () => {
    await getPool().end();
  });

  it("pages the whole transcript with no gaps or overlaps", async () => {
    let offset = 0;
    let joined = "";
    for (;;) {
      const page = (await runTool(owner, "get_call_transcript", offset === 0 ? { insightId } : { insightId, offset })) as Page;
      assert.equal(page.totalLength, TRANSCRIPT.length);
      assert.equal(page.offset, offset);
      assert.ok(page.transcript.length <= 100_000);
      joined += page.transcript;
      if (page.nextOffset === null) break;
      assert.equal(page.nextOffset, offset + page.transcript.length);
      offset = page.nextOffset;
    }
    assert.equal(joined, TRANSCRIPT);
  });

  it("fences the transcript as outside text and counts it as an outside read", async () => {
    const fenced = (await runTool(owner, "get_call_transcript", { insightId }, { fence: "tok" })) as { transcript: string; notice?: string };
    assert.notEqual(fenced.transcript, TRANSCRIPT.slice(0, fenced.transcript.length));
    assert.ok(fenced.transcript.includes("marker-0-end"));
    assert.ok(outsideRead("get_call_transcript", JSON.stringify(fenced)));
  });

  it("marks each call summary with how to pull its transcript", async () => {
    const contact = (await runTool(owner, "get_contact", { contactId })) as { callSummaries: Record<string, { id: string; transcript: { length: number; tool: string } }> };
    const summary = Object.values(contact.callSummaries)[0];
    assert.equal(summary.id, insightId);
    assert.deepEqual(summary.transcript, { length: TRANSCRIPT.length, tool: "get_call_transcript" });
    const company = (await runTool(owner, "get_company", { companyId })) as { insights: Record<string, { transcript: { tool: string } }> };
    assert.equal(Object.values(company.insights)[0].transcript.tool, "get_call_transcript");
    const activities = (await runTool(owner, "list_activities", { companyId })) as { callSummaries: Record<string, { transcript: { tool: string } }> };
    assert.equal(Object.values(activities.callSummaries)[0].transcript.tool, "get_call_transcript");
    const definitions = toolDefinitions();
    for (const name of ["get_contact", "get_company", "list_activities"]) {
      const definition = definitions.find((item) => item.function.name === name)?.function;
      assert.match(definition?.description ?? "", /get_call_transcript/);
    }
    assert.match(definitions.find((item) => item.function.name === "get_call_transcript")?.function.description ?? "", /nextOffset/);
  });

  it("refuses a transcript from another workspace", async () => {
    const other = await createUser("assistant-transcript-other@example.com", "Other Person");
    const refused = (await runTool(other, "get_call_transcript", { insightId })) as { error?: string };
    assert.ok(refused.error);
    assert.ok(!JSON.stringify(refused).includes("marker-"));
  });
});
