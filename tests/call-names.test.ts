import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { nameKey, titleNames } from "@/lib/crm/call-names";
import { listToFile } from "@/lib/crm/capture";
import { readCaptureAction, runCaptureAction } from "@/lib/crm/capture-actions";
import { createContact } from "@/lib/crm/contacts";
import { listDismissedImports } from "@/lib/crm/conversations";
import { processGranolaWebhook, syncGranola } from "@/lib/crm/granola";
import { scopesForRole } from "@/lib/crm/scopes";
import { settleTeamsTranscripts } from "@/lib/crm/teams-transcripts";
import type { UserActor } from "@/lib/crm/types";
import { createWorkspace } from "@/lib/crm/workspaces";
import { getAdminPool, getPool } from "@/lib/db/pool";
import type { GranolaNote } from "@/lib/granola";
import { createUser, resetDatabase } from "./helpers";

function hoursAgo(hours: number) {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function noteId(label: string) {
  return `not_${label.padEnd(14, "0").slice(0, 14)}`;
}

function makeNote(id: string, owner: UserActor, overrides: Partial<GranolaNote> = {}): GranolaNote {
  return {
    id,
    title: "Catch up",
    owner: { name: owner.fullName, email: owner.email },
    created_at: hoursAgo(20),
    updated_at: hoursAgo(19),
    deleted_at: null,
    web_url: `https://notes.granola.ai/d/${id}`,
    calendar_event: null,
    attendees: [],
    summary_text: "Summary",
    summary_markdown: "Summary",
    transcript: [
      { speaker: { source: "microphone", attribution: "me" }, text: "Thanks for the time.", start_time: hoursAgo(20), end_time: hoursAgo(20) },
      { speaker: { source: "speaker", attribution: "them" }, text: "Good to talk.", start_time: hoursAgo(20), end_time: hoursAgo(19.5) },
    ],
    ...overrides,
  };
}

function granola(notes: Map<string, GranolaNote>): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/chat/completions")) {
      return Response.json({ model: "test", choices: [{ message: { role: "assistant", content: "{}" }, finish_reason: "stop" }] });
    }
    if (url.pathname === "/v1/notes") {
      return Response.json({
        notes: [...notes.values()].map(({ id, title, owner, created_at, updated_at, deleted_at }) => ({ id, title, owner, created_at, updated_at, deleted_at })),
        hasMore: false,
        cursor: null,
      });
    }
    const match = /^\/v1\/notes\/([^/]+)$/.exec(url.pathname);
    const note = match ? notes.get(match[1]) : undefined;
    if (!note) return Response.json({ message: "Not found" }, { status: 404 });
    return Response.json(note);
  };
}

describe("calls matched by name", () => {
  let home: UserActor;
  let eclipse: UserActor;
  let jamesId: string;
  const notes = new Map<string, GranolaNote>();

  async function rows(externalId: string) {
    const result = await getAdminPool().query<{
      id: string;
      workspace_id: string;
      status: string;
      contact_id: string | null;
      transcript: string | null;
      participants: { name: string | null; email: string | null }[];
    }>(
      "select id, workspace_id, status, contact_id, transcript, participants from crm.conversation_imports where external_id = $1 order by created_at",
      [externalId],
    );
    return result.rows;
  }

  async function sync() {
    return syncGranola({
      fetchImpl: granola(notes),
      force: true,
      sleep: async () => {},
      targets: [{ actor: home, mailbox: false, members: [home] }],
    });
  }

  before(async () => {
    await resetDatabase();
    home = await createUser("mark@ridgeon.test", "Mark Ridgeon");
    await getAdminPool().query("update crm.workspaces set name = 'Mark Ridgeon' where id = $1", [home.workspaceId]);
    home = { ...home, workspaceName: "Mark Ridgeon" };
    const created = await createWorkspace(home, { name: "Eclipse" });
    eclipse = { ...home, workspaceId: created.id, workspaceName: "Eclipse", role: "owner", scopes: scopesForRole("owner") };
    jamesId = (await createContact(eclipse, { firstName: "James", lastName: "O'Toole", email: "james@otoole.test" })).body.contact.id;
    await createContact(eclipse, { firstName: "Mark", lastName: "Ridgeon", email: "mark@elsewhere.test" });
  });

  beforeEach(() => {
    process.env.GRANOLA_API_KEY = "grn_test_key";
    notes.clear();
  });

  after(async () => {
    await getPool().end();
    await getAdminPool().end();
  });

  it("compares names without case or punctuation and reads people from a call title", () => {
    assert.equal(nameKey("James O'Toole"), nameKey("james  otoole"));
    assert.equal(nameKey("James O’Toole"), nameKey("JAMES O-TOOLE"));
    assert.equal(nameKey("James"), null);
    assert.equal(nameKey("james@otoole.test"), null);
    assert.deepEqual(titleNames("Mark Ridgeon and James O'Toole"), ["Mark Ridgeon", "James O'Toole"]);
    assert.deepEqual(titleNames("Mark Ridgeon x James O'Toole"), ["Mark Ridgeon", "James O'Toole"]);
    assert.deepEqual(titleNames("Mark Ridgeon + James O'Toole"), ["Mark Ridgeon", "James O'Toole"]);
    assert.deepEqual(titleNames("Mark x James O'Toole"), ["James O'Toole"]);
    assert.deepEqual(titleNames("Q3 pipeline review"), []);
    assert.deepEqual(titleNames("Pricing call: Acme and Globex (follow-up)"), []);
  });

  it("files a call whose only attendee name matches one contact in another workspace there", async () => {
    const id = noteId("nameone");
    notes.set(
      id,
      makeNote(id, home, {
        title: "Mark Ridgeon and James O'Toole",
        attendees: [
          { name: "Mark Ridgeon", email: null },
          { name: "James OToole", email: "" },
        ],
      }),
    );
    const result = await sync();
    assert.equal(result.error, undefined);
    assert.equal(result.filed, 1);
    const found = await rows(id);
    assert.equal(found.length, 1);
    assert.equal(found[0].workspace_id, eclipse.workspaceId);
    assert.equal(found[0].status, "filed");
    assert.equal(found[0].contact_id, jamesId);
    assert.deepEqual(found[0].participants, [{ name: "James OToole", email: null }]);
    const activity = await getAdminPool().query<{ contact_id: string }>(
      "select contact_id from crm.activities where workspace_id = $1 and metadata->>'externalId' = $2",
      [eclipse.workspaceId, id],
    );
    assert.deepEqual(activity.rows, [{ contact_id: jamesId }]);
  });

  it("files a name match in every workspace when the contacts there share an email", async () => {
    const here = (await createContact(home, { firstName: "Pat", lastName: "Kerr", email: "pat@kerr.test" })).body.contact.id;
    const there = (await createContact(eclipse, { firstName: "Pat", lastName: "Kerr", email: "pat@kerr.test" })).body.contact.id;
    const id = noteId("nameshared");
    notes.set(id, makeNote(id, home, { attendees: [{ name: "Pat Kerr", email: null }] }));
    await sync();
    const found = await rows(id);
    assert.deepEqual(
      found.map((row) => [row.workspace_id, row.status, row.contact_id]).sort(),
      [
        [home.workspaceId, "filed", here],
        [eclipse.workspaceId, "filed", there],
      ].sort(),
    );
  });

  it("leaves an ambiguous name unfiled where the likely contact lives, with them suggested", async () => {
    const first = (await createContact(eclipse, { firstName: "Sam", lastName: "Lee", email: "sam@one.test" })).body.contact.id;
    const second = (await createContact(eclipse, { firstName: "Sam", lastName: "Lee", email: "sam@two.test" })).body.contact.id;
    const id = noteId("nameambig");
    notes.set(id, makeNote(id, home, { title: "Weekly", attendees: [{ name: "Sam Lee", email: null }] }));
    const result = await sync();
    assert.equal(result.unfiled, 1);
    const found = await rows(id);
    assert.equal(found.length, 1);
    assert.equal(found[0].workspace_id, eclipse.workspaceId);
    assert.equal(found[0].status, "unfiled");
    assert.equal(found[0].contact_id, null);

    const toFile = await listToFile(eclipse);
    const item = toFile.unfiled.find((row) => row.id === found[0].id)!;
    assert.deepEqual(item.suggestions.map((contact) => contact.contactId).sort(), [first, second].sort());
    assert.ok(item.suggestions.every((contact) => contact.name === "Sam Lee"));
    assert.equal((await listToFile(home)).unfiled.some((row) => row.id === found[0].id), false);

    await runCaptureAction(eclipse, readCaptureAction({ kind: "import-file", id: found[0].id, contactId: second }));
    const filed = await rows(id);
    assert.equal(filed[0].status, "filed");
    assert.equal(filed[0].contact_id, second);
  });

  it("treats one name on different people in two workspaces as ambiguous", async () => {
    await createContact(home, { firstName: "Alex", lastName: "Moore", email: "alex@home.test" });
    const there = (await createContact(eclipse, { firstName: "Alex", lastName: "Moore", email: "alex@eclipse.test" })).body.contact.id;
    const id = noteId("nametwows");
    notes.set(id, makeNote(id, home, { attendees: [{ name: "Alex Moore", email: null }] }));
    await sync();
    const found = await rows(id);
    assert.equal(found.length, 1);
    assert.equal(found[0].status, "unfiled");
    assert.equal(found[0].workspace_id, home.workspaceId);
    const item = (await listToFile(home)).unfiled.find((row) => row.id === found[0].id)!;
    assert.equal(item.suggestions.length, 1);
    assert.notEqual(item.suggestions[0].contactId, there);
  });

  it("only suggests a contact named in the title, never files on it", async () => {
    const id = noteId("nametitle");
    notes.set(id, makeNote(id, home, { title: "Mark Ridgeon and James O'Toole", attendees: [] }));
    const result = await sync();
    assert.equal(result.filed, 0);
    assert.equal(result.unfiled, 1);
    const found = await rows(id);
    assert.equal(found.length, 1);
    assert.equal(found[0].workspace_id, eclipse.workspaceId);
    assert.equal(found[0].status, "unfiled");
    const item = (await listToFile(eclipse)).unfiled.find((row) => row.id === found[0].id)!;
    assert.deepEqual(item.suggestions, [{ contactId: jamesId, name: "James O'Toole", companyName: null }]);
  });

  it("keeps an unknown name unfiled in the home workspace with nothing suggested", async () => {
    const id = noteId("namenobody");
    notes.set(id, makeNote(id, home, { title: "Mark Ridgeon and Nobody Known", attendees: [{ name: "Nobody Known", email: null }] }));
    await sync();
    const found = await rows(id);
    assert.equal(found[0].workspace_id, home.workspaceId);
    assert.equal(found[0].status, "unfiled");
    const item = (await listToFile(home)).unfiled.find((row) => row.id === found[0].id)!;
    assert.deepEqual(item.suggestions, []);
  });

  it("lists a dismissed call, restores it to Capture, and keeps its transcript throughout", async () => {
    const id = noteId("dismiss");
    notes.set(id, makeNote(id, home, { title: "Supplier chat", attendees: [{ name: "Stranger", email: "stranger@unknown.test" }] }));
    await sync();
    const [row] = await rows(id);
    assert.equal(row.status, "unfiled");
    assert.ok(row.transcript);

    await runCaptureAction(home, readCaptureAction({ kind: "import-ignore", id: row.id }));
    assert.equal((await rows(id))[0].status, "ignored");
    assert.equal((await rows(id))[0].transcript, row.transcript);
    assert.equal((await listToFile(home)).unfiled.some((item) => item.id === row.id), false);
    const dismissed = await listDismissedImports(home);
    assert.equal(dismissed.total, 1);
    assert.equal(dismissed.items[0].id, row.id);
    assert.equal(dismissed.items[0].title, "Supplier chat");
    assert.equal((await listDismissedImports(eclipse)).total, 0);

    await runCaptureAction(home, readCaptureAction({ kind: "import-restore", id: row.id }));
    const restored = (await rows(id))[0];
    assert.equal(restored.status, "unfiled");
    assert.equal(restored.transcript, row.transcript);
    assert.equal((await listToFile(home)).unfiled.some((item) => item.id === row.id), true);
    assert.equal((await listDismissedImports(home)).total, 0);
    await assert.rejects(runCaptureAction(home, readCaptureAction({ kind: "import-restore", id: row.id })), /already back in Capture/);
  });

  it("keeps a dismissed call and its data through later syncs and webhooks", async () => {
    const id = noteId("dismisssync");
    notes.set(id, makeNote(id, home, { title: "Old supplier", attendees: [{ name: "Vendor", email: "vendor@unknown.test" }] }));
    await sync();
    const [row] = await rows(id);
    await runCaptureAction(home, readCaptureAction({ kind: "import-ignore", id: row.id }));

    notes.set(
      id,
      makeNote(id, home, {
        title: "Renamed in Granola",
        updated_at: new Date().toISOString(),
        attendees: [{ name: "Vendor", email: "vendor@unknown.test" }],
        transcript: [{ speaker: { source: "microphone", attribution: "me" }, text: "Different text.", start_time: hoursAgo(1), end_time: hoursAgo(1) }],
      }),
    );
    await getAdminPool().query("update crm.integration_state set last_synced_at = null where source = 'granola'");
    const result = await sync();
    assert.equal(result.error, undefined);
    await processGranolaWebhook(home, id, { fetchImpl: granola(notes) });

    const after = await rows(id);
    assert.equal(after.length, 1);
    assert.equal(after[0].id, row.id);
    assert.equal(after[0].status, "ignored");
    assert.equal(after[0].transcript, row.transcript);
    assert.equal((await listDismissedImports(home)).items.some((item) => item.id === row.id && item.title === "Old supplier"), true);
  });

  it("drops calls dismissed more than 30 days ago from the list without deleting them", async () => {
    const id = noteId("dismissold");
    notes.set(id, makeNote(id, home, { title: "Long ago", attendees: [{ name: "Someone", email: "someone@unknown.test" }] }));
    await sync();
    const [row] = await rows(id);
    await runCaptureAction(home, readCaptureAction({ kind: "import-ignore", id: row.id }));
    const client = await getAdminPool().connect();
    try {
      await client.query("begin");
      await client.query("set local session_replication_role = replica");
      await client.query("update crm.conversation_imports set updated_at = now() - interval '31 days' where id = $1", [row.id]);
      await client.query("commit");
    } finally {
      client.release();
    }
    assert.equal((await listDismissedImports(home)).items.some((item) => item.id === row.id), false);
    assert.equal((await rows(id))[0].status, "ignored");
  });

  it("moves a Teams transcript to the workspace of the person named in it and suggests them", async () => {
    const admin = getAdminPool();
    const inserted = await admin.query<{ id: string }>(
      `insert into crm.conversation_imports (workspace_id, user_id, source, external_id, kind, title, occurred_at, participants, transcript, status)
       values ($1, $2, 'teams', 'tr-names-1', 'call', 'Teams call', $3::timestamptz, $4::jsonb, 'Mark Ridgeon: Hello.\nSam Lee: Hi.', 'pending')
       returning id`,
      [home.workspaceId, home.userId, hoursAgo(72), JSON.stringify([{ name: "Mark Ridgeon", email: null }, { name: "Sam Lee", email: null }])],
    );
    await settleTeamsTranscripts(home);
    const found = await rows("tr-names-1");
    assert.equal(found.length, 1);
    assert.equal(found[0].workspace_id, eclipse.workspaceId);
    assert.equal(found[0].status, "unfiled");
    const item = (await listToFile(eclipse)).unfiled.find((row) => row.id === inserted.rows[0].id)!;
    assert.equal(item.suggestions.length, 2);
    assert.ok(item.suggestions.every((contact) => contact.name === "Sam Lee"));
  });
});
