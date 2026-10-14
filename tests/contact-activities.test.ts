import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  createActivity,
  getActivity,
  listActivities,
  listActivitiesByContact,
  listCompanyTimeline,
} from "@/lib/crm/activities";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { getCompanyContext } from "@/lib/crm/relationships";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createAgent, createUser, queryAsUser, resetDatabase } from "./helpers";

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

  it("names who logged each activity, for users and agents", async () => {
    const owner = await createUser("authors@example.com", "Mark Ridgeon");
    const outsider = await createUser("outsider@example.com", "Outsider");
    const { actor: agent } = await createAgent(
      owner.workspaceId,
      ["crm:read", "activities:write"],
      "Inbox agent",
    );
    const company = await createCompany(owner, {
      name: "Author Co",
      domain: "author.example",
    });
    const contact = await createContact(owner, {
      companyId: company.body.company.id,
      firstName: "Jane",
      lastName: "Doe",
    });
    const contactId = contact.body.contact.id;
    const byUser = await createActivity(owner, {
      type: "call",
      title: "Intro call",
      contactId,
      occurredAt: "2026-03-01T10:00:00.000Z",
    });
    const byAgent = await createActivity(agent, {
      type: "note",
      body: "Filed by the agent",
      contactId,
      occurredAt: "2026-03-02T10:00:00.000Z",
    });
    assert.equal(byUser.body.activity.actorName, "Mark Ridgeon");
    assert.equal(byAgent.body.activity.actorName, "Inbox agent");

    const names = (activities: { id: string; actorName: string | null }[]) =>
      Object.fromEntries(
        activities.map((activity) => [activity.id, activity.actorName]),
      );
    const expected = {
      [byUser.body.activity.id]: "Mark Ridgeon",
      [byAgent.body.activity.id]: "Inbox agent",
    };

    assert.deepEqual(
      names((await listActivitiesByContact(owner, [contactId]))[contactId]),
      expected,
    );
    assert.deepEqual(
      names((await listActivities(owner, { contactId })).data),
      expected,
    );
    assert.deepEqual(
      names(await listCompanyTimeline(owner, company.body.company.id)),
      expected,
    );
    assert.deepEqual(
      names(
        (await getCompanyContext(owner, company.body.company.id)).timeline,
      ),
      expected,
    );
    assert.deepEqual(
      names((await listActivities(agent, { contactId })).data),
      expected,
    );
    assert.equal(
      (await getActivity(agent, byUser.body.activity.id)).actorName,
      "Mark Ridgeon",
    );

    await getAdminPool().query(
      "update crm.profiles set full_name = null where id = $1",
      [owner.userId],
    );
    assert.equal(
      (await getActivity(owner, byUser.body.activity.id)).actorName,
      "authors@example.com",
    );

    const theirs = await createCompany(outsider, { name: "Elsewhere" });
    const { actor: stranger } = await createAgent(
      outsider.workspaceId,
      ["crm:read", "activities:write"],
      "Stranger agent",
    );
    await createActivity(stranger, {
      type: "note",
      body: "Other workspace",
      companyId: theirs.body.company.id,
    });
    const agents = await queryAsUser<{ name: string }>(
      owner.userId,
      "select name from crm.agents order by name",
    );
    assert.deepEqual(
      agents.map((row) => row.name),
      ["Inbox agent"],
    );
    await assert.rejects(
      queryAsUser(owner.userId, "select scopes from crm.agents"),
      /permission denied/,
    );
  });
});
