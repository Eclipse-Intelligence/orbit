import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createActivity, listActivitiesByContact } from "@/lib/crm/activities";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { getPool } from "@/lib/db/pool";
import { createUser, resetDatabase } from "./helpers";

before(async () => {
  await resetDatabase();
});

after(async () => {
  await getPool().end();
});

describe("contact activities", () => {
  it("lists notes and emails on the contact, newest first", async () => {
    const owner = await createUser("activities@example.com", "Activities");
    const company = await createCompany(owner, {
      name: "Activity Co",
      domain: "activity.example",
    });
    const contact = await createContact(owner, {
      companyId: company.body.company.id,
      firstName: "Nia",
      email: "nia@activity.example",
      notes: "Kept on the record",
    });
    await createActivity(owner, {
      type: "note",
      body: "Met at the event",
      contactId: contact.body.contact.id,
      occurredAt: "2026-01-01T00:00:00.000Z",
    });
    await createActivity(owner, {
      type: "email",
      title: "Hello Nia",
      body: "The full message.",
      contactId: contact.body.contact.id,
      occurredAt: "2026-02-01T00:00:00.000Z",
      metadata: { source: "microsoft", direction: "outbound" },
    });
    await createActivity(owner, {
      type: "call",
      title: "Intro call",
      body: "Talked through the proposal.",
      contactId: contact.body.contact.id,
      occurredAt: "2026-01-15T00:00:00.000Z",
    });

    const grouped = await listActivitiesByContact(owner, [
      contact.body.contact.id,
      "not-a-uuid",
    ]);
    const activities = grouped[contact.body.contact.id];
    assert.equal(activities?.length, 3);
    assert.equal(activities?.[0]?.title, "Hello Nia");
    assert.equal(activities?.[0]?.body, "The full message.");
    assert.equal(activities?.[0]?.metadata.source, "microsoft");
    assert.equal(activities?.[0]?.companyId, company.body.company.id);
    assert.equal(activities?.[1]?.type, "call");
    assert.equal(activities?.[2]?.body, "Met at the event");
    assert.equal(grouped["not-a-uuid"], undefined);
  });
});
