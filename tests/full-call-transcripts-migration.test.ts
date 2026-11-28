import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createActivity } from "@/lib/crm/activities";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createUser, reapplyMigrationsFrom, resetDatabase } from "./helpers";

const MIGRATION = "20270315100000_full_call_transcripts.sql";

describe("full call transcripts migration", () => {
  let owner: UserActor;
  let contactId: string;
  let companyId: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("migration-transcript@example.com", "Mark Ridgeon");
    const company = await createCompany(owner, { name: "Acme", domain: "acme.test" });
    companyId = company.body.company.id;
    const contact = await createContact(owner, { companyId, firstName: "Jane", lastName: "Doe" });
    contactId = contact.body.contact.id;
  });

  after(async () => {
    await getPool().end();
  });

  async function call(title: string) {
    const logged = await createActivity(owner, {
      type: "call",
      title,
      body: "Call",
      contactId,
      companyId,
      occurredAt: "2026-10-15T13:00:00.000Z",
    });
    return logged.body.activity.id;
  }

  async function insight(activityId: string, transcript: string) {
    await getAdminPool().query(
      `insert into crm.call_insights (workspace_id, activity_id, contact_id, company_id, source, transcript, summary, status)
       values ($1, $2, $3, $4, 'granola', $5, 'Summary', 'ready')`,
      [owner.workspaceId, activityId, contactId, companyId, transcript],
    );
  }

  async function imported(activityId: string, externalId: string, transcript: string) {
    await getAdminPool().query(
      `insert into crm.conversation_imports (workspace_id, user_id, source, external_id, kind, status, activity_id, transcript)
       values ($1, $2, 'granola', $3, 'meeting', 'filed', $4, $5)`,
      [owner.workspaceId, owner.userId, externalId, activityId, transcript],
    );
  }

  async function stored(activityId: string) {
    const result = await getAdminPool().query<{ transcript: string }>(
      "select transcript from crm.call_insights where activity_id = $1",
      [activityId],
    );
    return result.rows[0].transcript;
  }

  it("drops the transcript caps and gives clipped calls their longer copy back, twice over", async () => {
    const admin = getAdminPool();
    await admin.query(
      `alter table crm.call_insights add constraint call_insights_transcript_length check (char_length(transcript) between 1 and 200000) not valid;
       alter table crm.conversation_imports add constraint conversation_imports_transcript_length check (transcript is null or char_length(transcript) <= 1000000) not valid`,
    );
    const lines = Array.from({ length: 2000 }, (_, index) => `Jane Doe: line ${index} ${"x".repeat(200)}`);
    const whole = lines.join("\n");
    const clipped = lines.slice(0, 900).join("\n");
    const clippedCall = await call("Clipped call");
    await insight(clippedCall, clipped);
    await imported(clippedCall, "clipped-note", whole);

    const sameCall = await call("Same call");
    await insight(sameCall, "Jane Doe: all of it");
    await imported(sameCall, "same-note", "Jane Doe: all of it");

    const editedCall = await call("Edited call");
    await insight(editedCall, "Jane Doe: what the summary read");
    await imported(editedCall, "edited-note", "Somebody else: a different and longer transcript than the summary read");

    await reapplyMigrationsFrom(MIGRATION);
    await reapplyMigrationsFrom(MIGRATION);

    assert.equal(await stored(clippedCall), whole);
    assert.equal(await stored(sameCall), "Jane Doe: all of it");
    assert.equal(await stored(editedCall), "Jane Doe: what the summary read");

    const huge = "y".repeat(1_100_000);
    const hugeCall = await call("Huge call");
    await insight(hugeCall, huge);
    await imported(hugeCall, "huge-note", huge);
    assert.equal((await stored(hugeCall)).length, huge.length);

    await assert.rejects(
      admin.query(
        `insert into crm.call_insights (workspace_id, activity_id, source, transcript) values ($1, $2, 'manual', '')`,
        [owner.workspaceId, await call("Empty call")],
      ),
      /call_insights_transcript_present/,
    );
  });
});
