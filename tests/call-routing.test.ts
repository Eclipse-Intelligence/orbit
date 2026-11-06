import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { listToFile } from "@/lib/crm/capture";
import { readCaptureAction, runCaptureAction } from "@/lib/crm/capture-actions";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { summariseImport } from "@/lib/crm/conversations";
import { fileGranolaNote } from "@/lib/crm/granola";
import { scopesForRole } from "@/lib/crm/scopes";
import { settleTeamsTranscripts } from "@/lib/crm/teams-transcripts";
import type { UserActor } from "@/lib/crm/types";
import { createWorkspace } from "@/lib/crm/workspaces";
import { getAdminPool, getPool } from "@/lib/db/pool";
import type { GranolaNote } from "@/lib/granola";
import { setAddressHome, setDomainRule } from "@/lib/mail/routing";
import { createUser, resetDatabase } from "./helpers";

const LLM_REPLY = {
  summary: "They went through the plan and agreed a pilot.",
  keyPoints: ["Pilot agreed"],
  actionItems: [{ title: "Send the pilot terms", owner: "me", dueDate: null }],
  health: "healthy",
  healthReason: "Keen to start.",
};

function hoursAgo(hours: number) {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function note(id: string, owner: UserActor, attendees: { name: string | null; email: string }[], createdAt = hoursAgo(3)): GranolaNote {
  return {
    id,
    title: "Pilot call",
    owner: { name: owner.fullName, email: owner.email },
    created_at: createdAt,
    updated_at: hoursAgo(2),
    deleted_at: null,
    web_url: `https://notes.granola.ai/d/${id}`,
    calendar_event: null,
    attendees,
    summary_text: "Summary",
    summary_markdown: "Summary",
    transcript: [
      { speaker: { source: "microphone", attribution: "me" }, text: "Shall we start a pilot?", start_time: hoursAgo(3), end_time: hoursAgo(3) },
      { speaker: { source: "speaker", attribution: "them", name: "Guest" }, text: "Yes please.", start_time: hoursAgo(3), end_time: hoursAgo(2.9) },
    ],
  };
}

describe("calls across workspaces", () => {
  let eclipse: UserActor;
  let ridgeon: UserActor;
  let connectionId: string;
  let llmCalls = 0;
  const llm: typeof fetch = async () => {
    llmCalls += 1;
    return Response.json({
      model: "claude-haiku-5-5",
      choices: [{ message: { role: "assistant", content: JSON.stringify(LLM_REPLY) }, finish_reason: "stop" }],
    });
  };

  async function imports(id: string) {
    const result = await getAdminPool().query<{ id: string; workspace_id: string; status: string; activity_id: string | null; contact_id: string | null; company_id: string | null }>(
      "select id, workspace_id, status, activity_id, contact_id, company_id from crm.conversation_imports where external_id = $1 order by created_at",
      [id],
    );
    return result.rows;
  }

  async function activities(workspaceId: string, externalId: string) {
    const result = await getAdminPool().query<{ id: string; contact_id: string | null; company_id: string | null }>(
      "select id, contact_id, company_id from crm.activities where workspace_id = $1 and metadata->>'externalId' = $2",
      [workspaceId, externalId],
    );
    return result.rows;
  }

  before(async () => {
    await resetDatabase();
    process.env.LLM_API_KEY = "test-llm-key";
    const admin = getAdminPool();
    eclipse = await createUser("mark@geteclipse.co", "Mark Ridgeon");
    await admin.query("update crm.workspaces set name = 'Eclipse' where id = $1", [eclipse.workspaceId]);
    eclipse = { ...eclipse, workspaceName: "Eclipse" };
    const created = await createWorkspace(eclipse, { name: "Mark Ridgeon", brandStart: "blank" });
    ridgeon = { ...eclipse, workspaceId: created.id, workspaceName: "Mark Ridgeon", role: "owner", scopes: scopesForRole("owner") };
    const connection = await admin.query<{ id: string }>(
      `insert into crm.mailbox_connections (workspace_id, user_id, provider, email, status, refresh_token)
       values ($1, $2, 'microsoft', 'mark@geteclipse.co', 'connected', 'cipher') returning id`,
      [eclipse.workspaceId, eclipse.userId],
    );
    connectionId = connection.rows[0].id;
    await admin.query("insert into crm.mail_sources (workspace_id, user_id, connection_id, email) values ($1, $2, $3, 'mark@geteclipse.co')", [
      eclipse.workspaceId,
      eclipse.userId,
      connectionId,
    ]);
  });

  beforeEach(() => {
    llmCalls = 0;
  });

  after(async () => {
    await getPool().end();
    await getAdminPool().end();
  });

  it("files a call once in each workspace that knows the people on it", async () => {
    const jane = await createContact(eclipse, { firstName: "Jane", lastName: "Doe", email: "jane@acme-labs.com" });
    const company = await createCompany(ridgeon, { name: "Acme Labs", domain: "acme-labs.com" });
    const call = note("not_route_both01", eclipse, [{ name: "Jane Doe", email: "jane@acme-labs.com" }]);

    assert.equal(await fileGranolaNote(eclipse, call), "filed");
    assert.equal(await fileGranolaNote(eclipse, call), "skipped");
    assert.equal(await fileGranolaNote(ridgeon, call), "skipped");

    const rows = await imports(call.id);
    assert.equal(rows.length, 2);
    const here = rows.find((row) => row.workspace_id === eclipse.workspaceId)!;
    const there = rows.find((row) => row.workspace_id === ridgeon.workspaceId)!;
    assert.equal(here.status, "filed");
    assert.equal(here.contact_id, jane.body.contact.id);
    assert.equal(there.status, "filed");
    assert.equal(there.contact_id, null);
    assert.equal(there.company_id, company.body.company.id);
    assert.equal((await activities(eclipse.workspaceId, call.id)).length, 1);
    assert.equal((await activities(ridgeon.workspaceId, call.id)).length, 1);

    const first = await summariseImport(eclipse, here.id, { fetchImpl: llm });
    assert.equal(first?.status, "ready");
    const second = await summariseImport(ridgeon, there.id, { fetchImpl: llm });
    assert.equal(second?.status, "ready");
    assert.equal(second?.summary, LLM_REPLY.summary);
    assert.equal(llmCalls, 1);
    const insights = await getAdminPool().query<{ workspace_id: string }>(
      "select ci.workspace_id from crm.call_insights ci join crm.conversation_imports i on i.activity_id = ci.activity_id where i.external_id = $1",
      [call.id],
    );
    assert.deepEqual(insights.rows.map((row) => row.workspace_id).sort(), [eclipse.workspaceId, ridgeon.workspaceId].sort());
    const tasks = await getAdminPool().query<{ workspace_id: string }>(
      "select workspace_id from crm.tasks where title = 'Send the pilot terms'",
    );
    assert.deepEqual(tasks.rows.map((row) => row.workspace_id).sort(), [eclipse.workspaceId, ridgeon.workspaceId].sort());
  });

  it("never matches a company on a free-mail domain", async () => {
    await createCompany(ridgeon, { name: "Gmail", domain: "gmail.com" });
    const call = note("not_route_free01", eclipse, [{ name: "Sam Stranger", email: "sam.stranger@gmail.com" }]);
    assert.equal(await fileGranolaNote(eclipse, call), "unfiled");
    const rows = await imports(call.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "unfiled");
    assert.equal(rows[0].company_id, null);
  });

  it("puts a call nobody knows in the To file of the account's home workspace, and Move to moves it", async () => {
    await setAddressHome(eclipse, "mark@geteclipse.co", ridgeon.workspaceId);
    const call = note("not_route_none01", eclipse, [{ name: "Nora New", email: "nora@unknown-co.com" }]);
    assert.equal(await fileGranolaNote(eclipse, call), "unfiled");
    const rows = await imports(call.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].workspace_id, ridgeon.workspaceId);

    const inRidgeon = await listToFile(ridgeon);
    assert.ok(inRidgeon.unfiled.some((item) => item.id === rows[0].id));
    assert.ok(!(await listToFile(eclipse)).unfiled.some((item) => item.id === rows[0].id));

    const action = readCaptureAction({ kind: "import-move", id: rows[0].id, workspaceId: eclipse.workspaceId });
    assert.deepEqual(action, { kind: "import-move", id: rows[0].id, workspaceId: eclipse.workspaceId });
    await assert.rejects(runCaptureAction(eclipse, action), /not found/i);
    await runCaptureAction(ridgeon, action);
    assert.equal((await imports(call.id))[0].workspace_id, eclipse.workspaceId);
    assert.ok((await listToFile(eclipse)).unfiled.some((item) => item.id === rows[0].id));
    assert.ok(!(await listToFile(ridgeon)).unfiled.some((item) => item.id === rows[0].id));
    await setAddressHome(eclipse, "mark@geteclipse.co", eclipse.workspaceId);
  });

  it("refuses to move a call into a workspace the person isn't in", async () => {
    const outsider = await createUser("olive@elsewhere.test", "Olive Outside");
    const call = note("not_route_move02", eclipse, [{ name: "Nick New", email: "nick@another-co.com" }]);
    await fileGranolaNote(eclipse, call);
    const row = (await imports(call.id))[0];
    const actor = row.workspace_id === eclipse.workspaceId ? eclipse : ridgeon;
    await assert.rejects(runCaptureAction(actor, { kind: "import-move", id: row.id, workspaceId: outsider.workspaceId }), /not in that workspace/);
  });

  it("follows the person's domain rules for calls", async () => {
    await createContact(eclipse, { firstName: "Rita", lastName: "Rule", email: "rita@ruled-co.com" });
    await setDomainRule(eclipse, "@ruled-co.com", [ridgeon.workspaceId]);
    const call = note("not_route_rule01", eclipse, [{ name: "Rita Rule", email: "rita@ruled-co.com" }], new Date().toISOString());
    assert.equal(await fileGranolaNote(eclipse, call), "filed");
    const rows = await imports(call.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].workspace_id, ridgeon.workspaceId);
    assert.equal(rows[0].status, "filed");
    const added = await getAdminPool().query<{ id: string; first_name: string | null }>(
      "select id, first_name from crm.contacts where workspace_id = $1 and normalized_email = 'rita@ruled-co.com'",
      [ridgeon.workspaceId],
    );
    assert.equal(added.rows.length, 1);
    assert.equal(added.rows[0].first_name, "Rita");
    assert.equal(rows[0].contact_id, added.rows[0].id);
    assert.equal((await activities(eclipse.workspaceId, call.id)).length, 0);
  });

  it("files a Teams transcript in every workspace whose call it belongs to", async () => {
    const admin = getAdminPool();
    const paul = await createContact(eclipse, { firstName: "Paul", lastName: "Phone", phone: "+447700900555" });
    const pauline = await createContact(ridgeon, { firstName: "Paul", lastName: "Phone", phone: "+447700900555" });
    const activity = async (actor: UserActor, contactId: string) =>
      (
        await admin.query<{ id: string }>(
          "insert into crm.activities (workspace_id, type, title, occurred_at, contact_id, actor_user_id) values ($1, 'call', 'Call with Paul', now(), $2, $3) returning id",
          [actor.workspaceId, contactId, actor.userId],
        )
      ).rows[0].id;
    for (const [actor, contactId] of [
      [eclipse, paul.body.contact.id],
      [ridgeon, pauline.body.contact.id],
    ] as const) {
      await admin.query(
        `insert into crm.call_records (workspace_id, connection_id, provider_call_id, direction, counterpart_number, started_at, contact_id, activity_id, teams_call_id)
         values ($1, $2, 'pstn-route-1', 'outbound', '+447700900555', now(), $3, $4, 'call-route-1')`,
        [actor.workspaceId, connectionId, contactId, await activity(actor, contactId)],
      );
    }
    const third = await createWorkspace(eclipse, { name: "Side", brandStart: "blank" });
    await admin.query(
      `insert into crm.conversation_imports (workspace_id, user_id, source, external_id, kind, call_id, title, occurred_at, participants, transcript, status)
       values ($1, $2, 'teams', 'tr-route-1', 'call', 'call-route-1', 'Teams call', now(), '[]', 'Mark: Hello.\nPaul: Hi.', 'pending')`,
      [third.id, eclipse.userId],
    );
    await settleTeamsTranscripts(eclipse);
    const rows = await imports("tr-route-1");
    assert.deepEqual(rows.map((row) => row.workspace_id).sort(), [eclipse.workspaceId, ridgeon.workspaceId].sort());
    assert.ok(rows.every((row) => row.status === "filed" && row.activity_id));
    await settleTeamsTranscripts(eclipse);
    assert.equal((await imports("tr-route-1")).length, 2);
  });
});
