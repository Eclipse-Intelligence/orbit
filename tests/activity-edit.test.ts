import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { describeAction, recordNames, runTool } from "@/lib/assistant/tools";
import { archiveActivity, createActivity, getActivity, updateActivity } from "@/lib/crm/activities";
import { activityOrigin, mayEditActivity } from "@/lib/crm/activity-edit";
import { createCompany, getCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { createOpportunity } from "@/lib/crm/opportunities";
import { scopesForRole } from "@/lib/crm/scopes";
import type { AgentActor, UserActor } from "@/lib/crm/types";
import { listRecentChanges, undoAuditEvent } from "@/lib/crm/undo";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createAgent, createUser, queryAsUser, resetDatabase } from "./helpers";

const WEB = { operation: "update_activity", source: "web" };

function code(expected: string, pattern?: RegExp) {
  return (error: unknown) => error instanceof CrmError && error.code === expected && (!pattern || pattern.test(error.message));
}

async function auditFor(activityId: string) {
  const result = await getAdminPool().query<{
    actor_user_id: string | null;
    actor_agent_id: string | null;
    source: string | null;
    operation: string;
    changes: { fields: string[]; before: Record<string, unknown>; after: Record<string, unknown>; clearedHealth?: unknown[] };
  }>(
    "select actor_user_id, actor_agent_id, source, operation, changes from crm.audit_events where entity_id = $1 and event_type = 'activity.updated' order by created_at",
    [activityId],
  );
  return result.rows;
}

describe("editing activities", () => {
  let owner: UserActor;
  let colleague: UserActor;
  let agent: AgentActor;
  let acme: string;
  let globex: string;
  let jane: string;
  let john: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("edit@orbit.test", "Mark Ridgeon");
    const admin = getAdminPool();
    const sam = (await admin.query<{ id: string }>("select private.create_local_user('sam@edit.test', 'password-123', 'Sam Taylor') as id")).rows[0].id;
    await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, sam]);
    colleague = { ...owner, userId: sam, email: "sam@edit.test", fullName: "Sam Taylor", role: "member", scopes: scopesForRole("member") };
    agent = (await createAgent(owner.workspaceId, ["crm:read", "activities:write"])).actor;
    acme = (await createCompany(owner, { name: "Acme Edit", domain: "acme-edit.test" })).body.company.id;
    globex = (await createCompany(owner, { name: "Globex Edit", domain: "globex-edit.test" })).body.company.id;
    jane = (await createContact(owner, { firstName: "Jane", lastName: "Doe", email: "jane@acme-edit.test", companyId: acme })).body.contact.id;
    john = (await createContact(owner, { firstName: "John", lastName: "Smith", email: "john@globex-edit.test", companyId: globex })).body.contact.id;
  });

  after(async () => {
    await getPool().end();
  });

  it("changes the title, text, type and time of a logged activity, and records the before and after", async () => {
    const note = (await createActivity(owner, { type: "note", title: "Kick-off", body: "Agreed scope.", companyId: acme, occurredAt: "2026-10-20T09:00:00.000Z" })).body.activity;
    const result = await updateActivity(owner, note.id, { title: "Kick-off call", body: "Agreed scope and dates.", type: "call", occurredAt: "2026-10-20T11:30" }, WEB);
    assert.equal(result.changed, true);
    assert.deepEqual(result.fields, ["type", "title", "body", "occurredAt"]);
    assert.equal(result.activity.title, "Kick-off call");
    assert.equal(result.activity.body, "Agreed scope and dates.");
    assert.equal(result.activity.type, "call");
    assert.equal(result.activity.occurredAt, "2026-10-20T10:30:00.000Z");

    const stored = await getActivity(owner, note.id);
    assert.equal(stored.title, "Kick-off call");

    const audit = await auditFor(note.id);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_user_id, owner.userId);
    assert.equal(audit[0].source, "web");
    assert.equal(audit[0].operation, "update_activity");
    assert.deepEqual(audit[0].changes.fields, ["type", "title", "body", "occurredAt"]);
    assert.deepEqual(audit[0].changes.before, { type: "note", title: "Kick-off", body: "Agreed scope.", occurredAt: "2026-10-20T09:00:00.000Z" });
    assert.deepEqual(audit[0].changes.after, { type: "call", title: "Kick-off call", body: "Agreed scope and dates.", occurredAt: "2026-10-20T10:30:00.000Z" });

    const same = await updateActivity(owner, note.id, { title: " Kick-off call ", body: "Agreed scope and dates." }, WEB);
    assert.equal(same.changed, false);
    assert.equal((await auditFor(note.id)).length, 1);
  });

  it("refuses edits that would leave nothing to show or an unreadable time", async () => {
    const note = (await createActivity(owner, { type: "note", body: "Only text", companyId: acme })).body.activity;
    await assert.rejects(updateActivity(owner, note.id, { body: "  " }, WEB), code("invalid_input", /Enter a title or a note/));
    await assert.rejects(updateActivity(owner, note.id, { occurredAt: "next week sometime" }, WEB), code("invalid_input", /valid date and time/));
    await assert.rejects(updateActivity(owner, note.id, { occurredAt: null }, WEB), code("invalid_input", /valid date and time/));
    await assert.rejects(updateActivity(owner, note.id, { type: "fax" as never }, WEB), code("invalid_input", /type is not recognised/));
    await assert.rejects(updateActivity(owner, "not-an-id", { body: "x" }, WEB), code("not_found"));
  });

  it("lets only the creator, an owner or an admin edit, and agents only what they logged", async () => {
    const mine = (await createActivity(owner, { type: "note", body: "Owner note", companyId: acme })).body.activity;
    const theirs = (await createActivity(colleague, { type: "note", body: "Sam's note", companyId: acme })).body.activity;

    await assert.rejects(updateActivity(colleague, mine.id, { body: "Changed by Sam" }, WEB), (error: unknown) => {
      return error instanceof CrmError && error.status === 403 && /Only the person who logged this activity, or an owner or admin, can edit it/.test(error.message);
    });
    assert.equal((await getActivity(owner, mine.id)).body, "Owner note");
    assert.equal((await updateActivity(colleague, theirs.id, { body: "Sam's note, edited" }, WEB)).changed, true);
    assert.equal((await updateActivity(owner, theirs.id, { body: "Sam's note, tidied by Mark" }, WEB)).changed, true);

    const stranger = await createUser("edit-stranger@orbit.test", "Stranger");
    await assert.rejects(updateActivity(stranger, mine.id, { body: "x" }, WEB), code("not_found"));

    const logged = (await createActivity(agent, { type: "research", title: "Agent research", companyId: acme })).body.activity;
    await assert.rejects(updateActivity(agent, mine.id, { body: "Agent edit" }, { operation: "update_activity", source: "api" }), code("forbidden"));
    const byAgent = await updateActivity(agent, logged.id, { title: "Agent research, revised" }, { operation: "update_activity", source: "api" });
    assert.equal(byAgent.changed, true);
    assert.equal((await auditFor(logged.id))[0].actor_agent_id, agent.agentId);
    const reader = (await createAgent(owner.workspaceId, ["crm:read"], "Reader")).actor;
    await assert.rejects(updateActivity(reader, logged.id, { title: "No" }, { operation: "update_activity" }));

    assert.equal(mayEditActivity({ userId: colleague.userId, role: "member" }, { actorUserId: owner.userId }), false);
    assert.equal(mayEditActivity({ userId: colleague.userId, role: "member" }, { actorUserId: colleague.userId }), true);
    assert.equal(mayEditActivity({ userId: colleague.userId, role: "admin" }, { actorUserId: owner.userId }), true);
  });

  it("enforces the same rule in the database, and keeps metadata and the actor read-only", async () => {
    const note = (await createActivity(owner, { type: "note", body: "Database check", companyId: acme })).body.activity;
    assert.equal((await queryAsUser(colleague.userId, "update crm.activities set title = 'Sam was here' where id = $1 returning id", [note.id])).length, 0);
    assert.equal((await queryAsUser(owner.userId, "update crm.activities set title = 'Changed', body = 'New' where id = $1 returning id", [note.id])).length, 1);
    await assert.rejects(queryAsUser(owner.userId, "update crm.activities set metadata = '{}'::jsonb where id = $1", [note.id]), /permission denied/);
    await assert.rejects(queryAsUser(owner.userId, "update crm.activities set actor_user_id = $2 where id = $1", [note.id, colleague.userId]), /permission denied/);
    await assert.rejects(queryAsUser(owner.userId, "update crm.activities set workspace_id = workspace_id where id = $1", [note.id]), /permission denied/);
    const forced = await getAdminPool().query<{ relforcerowsecurity: boolean }>("select relforcerowsecurity from pg_class where oid = 'crm.activities'::regclass");
    assert.equal(forced.rows[0].relforcerowsecurity, true);
  });

  it("keeps links inside the workspace and consistent with each other", async () => {
    const note = (await createActivity(owner, { type: "note", body: "Links", contactId: jane, companyId: acme })).body.activity;
    const elsewhere = await createUser("edit-elsewhere@orbit.test", "Elsewhere");
    const foreign = (await createCompany(elsewhere, { name: "Foreign", domain: "foreign-edit.test" })).body.company.id;
    const foreignContact = (await createContact(elsewhere, { firstName: "Far", email: "far@foreign-edit.test", companyId: foreign })).body.contact.id;

    await assert.rejects(updateActivity(owner, note.id, { companyId: foreign, contactId: null }, WEB), code("not_found", /Company not found/));
    await assert.rejects(updateActivity(owner, note.id, { contactId: foreignContact }, WEB), code("not_found", /Contact not found/));
    await assert.rejects(updateActivity(owner, note.id, { contactId: john }, WEB), code("invalid_input", /different company/));
    await assert.rejects(updateActivity(owner, note.id, { companyId: null, contactId: null }, WEB), code("invalid_input", /Keep the activity on a company, person or opportunity/));
    await assert.rejects(
      queryAsUser(owner.userId, "update crm.activities set company_id = $2 where id = $1", [note.id, foreign]),
      /another workspace/,
    );

    const deal = (await createOpportunity(owner, { companyId: globex, name: "Globex renewal" })).body.opportunity;
    const moved = await updateActivity(owner, note.id, { companyId: globex, contactId: john, opportunityId: deal.id }, WEB);
    assert.deepEqual([moved.activity.companyId, moved.activity.contactId, moved.activity.opportunityId], [globex, john, deal.id]);
    assert.equal(moved.activity.opportunityName, "Globex renewal");
    const audit = await auditFor(note.id);
    assert.deepEqual(audit[0].changes.before, { companyId: acme, contactId: jane, opportunityId: null });
    assert.deepEqual(audit[0].changes.after, { companyId: globex, contactId: john, opportunityId: deal.id });
  });

  it("refuses a deleted activity", async () => {
    const note = (await createActivity(owner, { type: "note", body: "Gone soon", companyId: acme })).body.activity;
    await archiveActivity(owner, note.id, { operation: "archive_activity", source: "web" });
    await assert.rejects(updateActivity(owner, note.id, { body: "Too late" }, WEB), (error: unknown) => {
      return error instanceof CrmError && error.status === 409 && /Undo the delete before editing it/.test(error.message);
    });
  });

  it("lets an email filed from Mail change only its company and opportunity", async () => {
    const reply = (
      await createActivity(owner, {
        type: "email",
        title: "Re: pricing",
        body: "Looks good.",
        contactId: jane,
        companyId: acme,
        metadata: { source: "microsoft", direction: "inbound", from: "jane@acme-edit.test", mailMessageId: "8c6f4d1e-0000-4000-8000-000000000001" },
      })
    ).body.activity;
    assert.equal(activityOrigin(reply), "mail");
    const limit = /can't be changed\. This email was filed from Mail, so only its company and opportunity can change\./;
    await assert.rejects(updateActivity(owner, reply.id, { body: "Rewritten" }, WEB), code("invalid_input", limit));
    await assert.rejects(updateActivity(owner, reply.id, { title: "New subject" }, WEB), code("invalid_input", limit));
    await assert.rejects(updateActivity(owner, reply.id, { occurredAt: "2026-01-01T09:00" }, WEB), code("invalid_input", limit));
    await assert.rejects(updateActivity(owner, reply.id, { type: "note" }, WEB), code("invalid_input", limit));
    await assert.rejects(updateActivity(owner, reply.id, { contactId: john, companyId: globex }, WEB), code("invalid_input", /Person can't be changed/));

    const unchanged = await updateActivity(owner, reply.id, { title: "Re: pricing", body: "Looks good." }, WEB);
    assert.equal(unchanged.changed, false);

    const deal = (await createOpportunity(owner, { companyId: acme, name: "Acme pricing" })).body.opportunity;
    const linked = await updateActivity(owner, reply.id, { opportunityId: deal.id }, WEB);
    assert.deepEqual(linked.fields, ["opportunityId"]);
    assert.equal(linked.activity.metadata.mailMessageId, "8c6f4d1e-0000-4000-8000-000000000001");
    assert.equal(linked.activity.body, "Looks good.");

    const sent = (
      await createActivity(owner, {
        type: "email",
        title: "Proposal",
        body: "Attached.",
        contactId: jane,
        metadata: { source: "microsoft", direction: "outbound", to: "jane@acme-edit.test", from: "edit@orbit.test" },
      })
    ).body.activity;
    await assert.rejects(updateActivity(owner, sent.id, { title: "Proposal v2" }, WEB), code("invalid_input", limit));

    const manual = (await createActivity(owner, { type: "email", title: "Outside email", body: "Sent from my phone.", contactId: jane, metadata: { source: "manual" } })).body.activity;
    assert.equal(activityOrigin(manual), "logged");
    assert.equal((await updateActivity(owner, manual.id, { body: "Sent from my phone, about pricing." }, WEB)).changed, true);
  });

  it("lets a call with a transcript change only its title and links, keeping its summary and health in step", async () => {
    const call = (
      await createActivity(owner, {
        type: "call",
        title: "Teams call with Jane Doe",
        body: "Teams call with a transcript",
        contactId: jane,
        companyId: acme,
        occurredAt: "2026-10-21T10:00:00.000Z",
        metadata: { source: "microsoft_teams", transcriptId: "transcript-1", callId: "call-1" },
      })
    ).body.activity;
    const admin = getAdminPool();
    await admin.query(
      `insert into crm.call_insights (workspace_id, activity_id, contact_id, company_id, source, transcript, status, summary)
       values ($1, $2, $3, $4, 'teams', 'Jane: we are reviewing other vendors.', 'ready', 'Reviewing vendors.')`,
      [owner.workspaceId, call.id, jane, acme],
    );
    await admin.query(
      "update crm.companies set health = 'at_risk', health_reason = 'Reviewing other vendors.', health_at = $2, health_activity_id = $3 where id = $1",
      [acme, call.occurredAt, call.id],
    );
    assert.equal(activityOrigin(call, true), "conversation");

    const limit = /This call or meeting came from Teams, Granola or a transcript, so only its title, company, person and opportunity can change\./;
    await assert.rejects(updateActivity(owner, call.id, { body: "My own words" }, WEB), code("invalid_input", limit));
    await assert.rejects(updateActivity(owner, call.id, { occurredAt: "2026-10-22T10:00" }, WEB), code("invalid_input", limit));
    await assert.rejects(updateActivity(owner, call.id, { type: "meeting" }, WEB), code("invalid_input", limit));

    const moved = await updateActivity(owner, call.id, { title: "Renewal call with John", companyId: globex, contactId: john }, WEB);
    assert.deepEqual(moved.fields, ["title", "companyId", "contactId"]);
    const insight = await admin.query<{ contact_id: string; company_id: string }>("select contact_id, company_id from crm.call_insights where activity_id = $1", [call.id]);
    assert.deepEqual([insight.rows[0].contact_id, insight.rows[0].company_id], [john, globex]);
    const cleared = await getCompany(owner, acme);
    assert.deepEqual([cleared.health, cleared.healthActivityId], [null, null]);
    const audit = await auditFor(call.id);
    assert.equal(audit[0].changes.clearedHealth?.length, 1);

    const change = (await listRecentChanges(owner, { entityType: "activity" })).find((item) => item.entityId === call.id && item.type === "activity.updated");
    assert.ok(change?.canUndo, change?.reason);
    await undoAuditEvent(owner, change.id, { operation: "undo_change", source: "web" });
    const back = await getActivity(owner, call.id);
    assert.deepEqual([back.title, back.companyId, back.contactId], ["Teams call with Jane Doe", acme, jane]);
    const healthBack = await getCompany(owner, acme);
    assert.deepEqual([healthBack.health, healthBack.healthActivityId], ["at_risk", call.id]);
    const insightBack = await admin.query<{ contact_id: string; company_id: string }>("select contact_id, company_id from crm.call_insights where activity_id = $1", [call.id]);
    assert.deepEqual([insightBack.rows[0].contact_id, insightBack.rows[0].company_id], [jane, acme]);
  });

  it("edits from the assistant, with the activity and each change on the card", async () => {
    const call = (await createActivity(owner, { type: "call", title: "Intro call", body: "Talked pricing.", contactId: jane, companyId: acme, occurredAt: "2026-10-20T13:30:00.000Z" })).body.activity;
    const args = { activityId: call.id, title: "Intro call with Jane", body: "Talked pricing.", occurredAt: "2026-10-20T15:00", contactId: null };
    const card = describeAction("update_activity", args, await recordNames(owner, [args], ["update_activity"]));
    assert.equal(card.title, "Edit activity");
    assert.match(card.lines[0], /^Activity: Call "Intro call" on .*14:30$/);
    assert.equal(card.lines[1], "Title: from Intro call to Intro call with Jane");
    assert.match(card.lines[2], /^When: from .*14:30 to .*15:00$/);
    assert.equal(card.lines[3], "Person: from Jane Doe to none");
    assert.equal(card.lines.length, 4);

    const result = (await runTool(owner, "update_activity", args)) as { activity: { title: string; contactId: string | null; companyId: string }; changed: boolean };
    assert.equal(result.changed, true);
    assert.equal(result.activity.title, "Intro call with Jane");
    assert.equal(result.activity.contactId, null);
    assert.equal(result.activity.companyId, acme);
    const audit = await auditFor(call.id);
    assert.equal(audit[0].source, "assistant");
    assert.equal(audit[0].operation, "assistant_update_activity");

    const refused = (await runTool(colleague, "update_activity", { activityId: call.id, title: "Sam's title" })) as { error: string };
    assert.match(refused.error, /Only the person who logged this activity/);
  });
});
