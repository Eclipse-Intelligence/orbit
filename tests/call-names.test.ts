import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { foldName, nameKey, titleNames } from "@/lib/crm/call-names";
import { moveImport } from "@/lib/crm/call-routing";
import { pageRequests, pruneHidden } from "@/lib/crm/capture-format";
import { listToFile } from "@/lib/crm/capture";
import { readCaptureAction, runCaptureAction } from "@/lib/crm/capture-actions";
import { createContact } from "@/lib/crm/contacts";
import { ignoreImport, listDismissedImports, restoreImport } from "@/lib/crm/conversations";
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
  let tara: UserActor;
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
    const teammate = await createUser("tara@eclipse.test", "Tara Mate");
    await getAdminPool().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [eclipse.workspaceId, teammate.userId]);
    tara = { ...teammate, workspaceId: eclipse.workspaceId, workspaceName: "Eclipse", role: "member", scopes: scopesForRole("member") };
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
    assert.equal(foldName("JOSÉ  Álvarez"), "jose alvarez");
    assert.equal(foldName("Anne-Marie O’Neil"), "anne marie oneil");
    assert.notEqual(foldName("Joan Nesmith"), foldName("Jo Anne Smith"));
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
    assert.deepEqual(item.suggestions, [{ contactId: jamesId, name: "James O'Toole", companyName: null, email: "james@otoole.test" }]);
    assert.equal(item.suggestedBy, "title");
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

  it("lists every dismissed call newest dismissal first, pages them, and stamps and clears the dismissal time", async () => {
    const ids: string[] = [];
    for (const label of ["pageone", "pagetwo", "pagethree"]) {
      const id = noteId(label);
      notes.set(id, makeNote(id, home, { title: label, attendees: [{ name: "Someone", email: `${label}@unknown.test` }] }));
    }
    await sync();
    for (const label of ["pageone", "pagetwo", "pagethree"]) {
      const [row] = await rows(noteId(label));
      ids.push(row.id);
      await ignoreImport(home, row.id);
    }
    const admin = getAdminPool();
    await admin.query("update crm.conversation_imports set dismissed_at = now() - interval '400 days' where id = $1", [ids[0]]);
    await admin.query("update crm.conversation_imports set dismissed_at = now() - interval '40 days' where id = $1", [ids[1]]);
    await admin.query("update crm.conversation_imports set title = 'pageone', error = null where id = $1", [ids[0]]);

    const all = await listDismissedImports(home, { limit: 100 });
    const order = all.items.map((item) => item.id).filter((id) => ids.includes(id));
    assert.deepEqual(order, [ids[2], ids[1], ids[0]]);
    assert.ok(all.total >= 3);
    const first = await listDismissedImports(home, { limit: 1 });
    const second = await listDismissedImports(home, { offset: 1, limit: 1 });
    assert.equal(first.items.length, 1);
    assert.equal(second.items.length, 1);
    assert.notEqual(first.items[0].id, second.items[0].id);
    assert.equal(first.total, all.total);
    assert.equal(second.total, all.total);
    assert.equal((await listDismissedImports(home, { offset: all.total })).total, all.total);
    assert.equal("sourceSummary" in all.items[0], false);

    const stamp = await admin.query<{ dismissed_at: Date | null }>("select dismissed_at from crm.conversation_imports where id = $1", [ids[2]]);
    assert.ok(stamp.rows[0].dismissed_at);
    await restoreImport(home, ids[2]);
    const cleared = await admin.query<{ dismissed_at: Date | null; status: string }>("select dismissed_at, status from crm.conversation_imports where id = $1", [ids[2]]);
    assert.deepEqual(cleared.rows[0], { dismissed_at: null, status: "unfiled" });
  });

  it("never lets a colleague see, dismiss or restore someone else's call, or delete their dismissed copy with a move", async () => {
    const id = noteId("colleague");
    notes.set(id, makeNote(id, home, { title: "Mark Ridgeon and James O'Toole", attendees: [] }));
    await sync();
    const [row] = await rows(id);
    assert.equal(row.workspace_id, eclipse.workspaceId);
    await assert.rejects(ignoreImport(tara, row.id), /not found/i);
    await ignoreImport(eclipse, row.id);
    assert.equal((await listDismissedImports(tara)).items.some((item) => item.id === row.id), false);
    assert.equal((await listDismissedImports(eclipse)).items.some((item) => item.id === row.id), true);
    await assert.rejects(restoreImport(tara, row.id), /not found/i);
    assert.equal((await rows(id))[0].status, "ignored");
    await restoreImport(eclipse, row.id);
    const back = (await listToFile(eclipse)).unfiled.find((entry) => entry.id === row.id)!;
    assert.deepEqual(back.suggestions.map((entry) => entry.contactId), [jamesId]);

    const admin = getAdminPool();
    const shared = noteId("sharednote");
    await admin.query(
      `insert into crm.conversation_imports (workspace_id, user_id, source, external_id, kind, title, transcript, status)
       values ($1, $2, 'granola', $3, 'meeting', 'Their copy', 'Tara: hello', 'ignored')`,
      [eclipse.workspaceId, tara.userId, shared],
    );
    const mine = await admin.query<{ id: string }>(
      `insert into crm.conversation_imports (workspace_id, user_id, source, external_id, kind, title, transcript, status)
       values ($1, $2, 'granola', $3, 'meeting', 'My copy', 'Mark: hello', 'unfiled') returning id`,
      [home.workspaceId, home.userId, shared],
    );
    await assert.rejects(moveImport(home, mine.rows[0].id, eclipse.workspaceId), /A colleague dismissed this call in that workspace/);
    const copies = await rows(shared);
    assert.deepEqual(
      copies.map((copy) => [copy.workspace_id, copy.status]).sort(),
      [
        [eclipse.workspaceId, "ignored"],
        [home.workspaceId, "unfiled"],
      ].sort(),
    );
  });

  it("refuses to restore a filed call", async () => {
    const id = noteId("restorefiled");
    notes.set(id, makeNote(id, home, { attendees: [{ name: "James O'Toole", email: null }] }));
    await sync();
    const [row] = await rows(id);
    assert.equal(row.status, "filed");
    await assert.rejects(restoreImport(eclipse, row.id), /already filed/);
  });

  it("drops a restored row from the hidden set only once the server no longer lists it", () => {
    const hidden = new Set(["import:a", "email:b"]);
    assert.equal(pruneHidden(hidden, ["import:a", "email:b", "task:c"]), hidden);
    const pruned = pruneHidden(hidden, ["email:b", "task:c"]);
    assert.deepEqual([...pruned], ["email:b"]);
    assert.equal(pruneHidden(pruned, ["import:a", "email:b"]).has("import:a"), false);
  });

  it("never files on a namesake when another workspace's email match has a different person by that name", async () => {
    const zed = (await createContact(home, { firstName: "Zed", lastName: "Known", email: "zed@known.test" })).body.contact.id;
    await createContact(home, { firstName: "Rory", lastName: "Bell", email: "rory@home.test" });
    await createContact(eclipse, { firstName: "Rory", lastName: "Bell", email: "rory@eclipse.test" });
    const id = noteId("nameemail");
    notes.set(id, makeNote(id, home, { attendees: [{ name: "Zed Known", email: "zed@known.test" }, { name: "Rory Bell", email: null }] }));
    await sync();
    const found = await rows(id);
    assert.deepEqual(
      found.map((row) => [row.workspace_id, row.status, row.contact_id]),
      [[home.workspaceId, "filed", zed]],
    );
  });

  it("files only on a word for word full name, and only suggests run-together or single-word names", async () => {
    const jo = (await createContact(eclipse, { firstName: "Jo Anne", lastName: "Smith", email: "jo@anne.test" })).body.contact.id;
    const benedict = (await createContact(eclipse, { firstName: "Benedict", email: "benedict@one.test" })).body.contact.id;
    const cases = [
      ["joan", "Joan Nesmith", jo],
      ["benedict", "Ben Edict", benedict],
    ] as const;
    for (const [label, name, contact] of cases) {
      const id = noteId(`loose${label}`);
      notes.set(id, makeNote(id, home, { attendees: [{ name, email: null }] }));
      await sync();
      const [row] = await rows(id);
      assert.equal(row.status, "unfiled", name);
      assert.equal(row.workspace_id, eclipse.workspaceId, name);
      const item = (await listToFile(eclipse)).unfiled.find((entry) => entry.id === row.id)!;
      assert.deepEqual(item.suggestions.map((entry) => entry.contactId), [contact], name);
      assert.equal(item.suggestedBy, "name");
    }
  });

  it("matches accented capitals and decomposed accents the same way whatever the database collation", async () => {
    const jose = (await createContact(eclipse, { firstName: "José", lastName: "Álvarez", email: "jose@alvarez.test" })).body.contact.id;
    const renee = (await createContact(eclipse, { firstName: "Renée", lastName: "Fossé", email: "renee@fosse.test" })).body.contact.id;
    const cases = [
      ["upper", "JOSÉ ÁLVAREZ", jose],
      ["plain", "Jose Alvarez", jose],
      ["decomposed", "Renée Fossé".normalize("NFD"), renee],
    ] as const;
    for (const [label, name, contact] of cases) {
      const id = noteId(`accent${label}`);
      notes.set(id, makeNote(id, home, { attendees: [{ name, email: null }] }));
      await sync();
      const [row] = await rows(id);
      assert.deepEqual([row.workspace_id, row.status, row.contact_id], [eclipse.workspaceId, "filed", contact], name);
    }
  });

  it("never matches a contact in a workspace the person isn't in, or a teammate's name", async () => {
    const olive = await createUser("olive@elsewhere.test", "Olive Other");
    await createContact(olive, { firstName: "Quinn", lastName: "Hart", email: "quinn@hart.test" });
    await createContact(home, { firstName: "Tara", lastName: "Mate", email: "tara@personal.test" });
    const cases = [
      ["outsider", "Quinn Hart"],
      ["teammate", "Tara Mate"],
    ] as const;
    for (const [label, name] of cases) {
      const id = noteId(`excl${label}`);
      notes.set(id, makeNote(id, home, { title: "Catch up", attendees: [{ name, email: null }] }));
      await sync();
      const [row] = await rows(id);
      assert.deepEqual([row.workspace_id, row.status], [home.workspaceId, "unfiled"], name);
      const item = (await listToFile(home)).unfiled.find((entry) => entry.id === row.id)!;
      assert.deepEqual(item.suggestions, [], name);
    }
  });

  it("uses an attendee name that is an email address as their email", async () => {
    const id = noteId("nameisemail");
    notes.set(id, makeNote(id, home, { attendees: [{ name: "james@otoole.test", email: null }] }));
    await sync();
    const [row] = await rows(id);
    assert.deepEqual([row.workspace_id, row.status, row.contact_id], [eclipse.workspaceId, "filed", jamesId]);
    assert.deepEqual(row.participants, [{ name: null, email: "james@otoole.test" }]);
  });

  it("falls back to the title when the attendees match nobody", async () => {
    const id = noteId("titlefallback");
    notes.set(id, makeNote(id, home, { title: "Mark x James O'Toole", attendees: [{ name: "Vendor", email: "vendor@nobody.test" }] }));
    await sync();
    const [row] = await rows(id);
    assert.deepEqual([row.workspace_id, row.status], [eclipse.workspaceId, "unfiled"]);
    const item = (await listToFile(eclipse)).unfiled.find((entry) => entry.id === row.id)!;
    assert.deepEqual(item.suggestions.map((entry) => entry.contactId), [jamesId]);
    assert.equal(item.suggestedBy, "title");
  });

  it("checks names in a workspace where a colleague already holds the note, and still gives the person their own copy", async () => {
    const homeKit = (await createContact(home, { firstName: "Kit", lastName: "Lane", email: "kit@home.test" })).body.contact.id;
    await createContact(eclipse, { firstName: "Kit", lastName: "Lane", email: "kit@eclipse.test" });
    const id = noteId("kitlane");
    await getAdminPool().query(
      `insert into crm.conversation_imports (workspace_id, user_id, source, external_id, kind, title, transcript, status)
       values ($1, $2, 'granola', $3, 'meeting', 'Kit catch up', 'Tara: hi', 'unfiled')`,
      [eclipse.workspaceId, tara.userId, id],
    );
    notes.set(id, makeNote(id, home, { title: "Kit catch up", attendees: [{ name: "Kit Lane", email: null }] }));
    await sync();
    const found = await rows(id);
    assert.equal(found.some((row) => row.status === "filed" || row.contact_id === homeKit), false);
    const activity = await getAdminPool().query("select 1 from crm.activities where contact_id = $1", [homeKit]);
    assert.equal(activity.rowCount, 0);
    const mine = found.filter((row) => row.workspace_id === home.workspaceId);
    assert.deepEqual(mine.map((row) => row.status), ["unfiled"]);
    const item = (await listToFile(home)).unfiled.find((entry) => entry.id === mine[0].id)!;
    assert.deepEqual(item.suggestions.map((entry) => entry.contactId), [homeKit]);
    await sync();
    assert.equal((await rows(id)).length, found.length);
  });

  it("files on the one word for word match even when a run-together namesake exists", async () => {
    const jon = (await createContact(eclipse, { firstName: "Jon", lastName: "Oakes", email: "jon@oakes.test" })).body.contact.id;
    await createContact(eclipse, { firstName: "Jo", lastName: "Noakes", email: "jo@noakes.test" });
    const annsmith = (await createContact(eclipse, { firstName: "Mary", lastName: "Annsmith", email: "mary@annsmith.test" })).body.contact.id;
    const oakes = noteId("jonoakes");
    notes.set(oakes, makeNote(oakes, home, { attendees: [{ name: "Jon Oakes", email: null }] }));
    const mary = noteId("maryannsmith");
    notes.set(mary, makeNote(mary, home, { attendees: [{ name: "Mary Ann Smith", email: null }] }));
    await sync();
    const [filed] = await rows(oakes);
    assert.deepEqual([filed.workspace_id, filed.status, filed.contact_id], [eclipse.workspaceId, "filed", jon]);
    const [waiting] = await rows(mary);
    assert.equal(waiting.status, "unfiled");
    const item = (await listToFile(eclipse)).unfiled.find((entry) => entry.id === waiting.id)!;
    assert.deepEqual(item.suggestions.map((entry) => entry.contactId), [annsmith]);
  });

  it("only suggests Cyrillic names, and sees namesakes written in another case or with odd spaces", async () => {
    const ivan = (await createContact(eclipse, { firstName: "Иван", lastName: "Петров", email: "ivan@one.test" })).body.contact.id;
    const ivanUpper = (await createContact(home, { firstName: "ИВАН", lastName: "ПЕТРОВ", email: "ivan@two.test" })).body.contact.id;
    const oleg = (await createContact(eclipse, { firstName: "Олег", lastName: "Сидоров", email: "oleg@one.test" })).body.contact.id;
    const petr = (await createContact(eclipse, { firstName: "Петр ", lastName: "Орлов", email: "petr@one.test" })).body.contact.id;
    const cases = [
      ["ivan", "Иван Петров", home.workspaceId, [ivanUpper]],
      ["oleg", "олег сидоров", eclipse.workspaceId, [oleg]],
      ["petr", "Петр Орлов", eclipse.workspaceId, [petr]],
    ] as const;
    for (const [label, name, workspaceId, contacts] of cases) {
      const id = noteId(`cyr${label}`);
      notes.set(id, makeNote(id, home, { attendees: [{ name, email: null }] }));
      await sync();
      const [row] = await rows(id);
      assert.deepEqual([row.workspace_id, row.status, row.contact_id], [workspaceId, "unfiled", null], name);
      const actor = workspaceId === home.workspaceId ? home : eclipse;
      const item = (await listToFile(actor)).unfiled.find((entry) => entry.id === row.id)!;
      assert.deepEqual(item.suggestions.map((entry) => entry.contactId), [...contacts], name);
    }
    assert.equal((await listToFile(eclipse)).unfiled.some((entry) => entry.suggestions.some((suggestion) => suggestion.contactId === ivan)), false);
  });

  it("keeps Devanagari vowel signs, so different names never match and none files", async () => {
    const ram = (await createContact(eclipse, { firstName: "राम", lastName: "Sharma", email: "ram@sharma.test" })).body.contact.id;
    const exact = noteId("devexact");
    notes.set(exact, makeNote(exact, home, { attendees: [{ name: "राम Sharma", email: null }] }));
    const other = noteId("devother");
    notes.set(other, makeNote(other, home, { attendees: [{ name: "रमा Sharma", email: null }] }));
    await sync();
    const [same] = await rows(exact);
    assert.deepEqual([same.workspace_id, same.status, same.contact_id], [eclipse.workspaceId, "unfiled", null]);
    const suggested = (await listToFile(eclipse)).unfiled.find((entry) => entry.id === same.id)!;
    assert.deepEqual(suggested.suggestions.map((entry) => entry.contactId), [ram]);
    const [different] = await rows(other);
    assert.deepEqual([different.workspace_id, different.status, different.contact_id], [home.workspaceId, "unfiled", null]);
    const none = (await listToFile(home)).unfiled.find((entry) => entry.id === different.id)!;
    assert.deepEqual(none.suggestions, []);
  });

  it("stamps a dismissal once, keeps it on a second dismiss, stamps an insert as dismissed, and ignores bad paging input", async () => {
    const admin = getAdminPool();
    const inserted = await admin.query<{ id: string; dismissed_at: Date | null }>(
      `insert into crm.conversation_imports (workspace_id, user_id, source, external_id, kind, title, status)
       values ($1, $2, 'granola', $3, 'meeting', 'Born dismissed', 'ignored') returning id, dismissed_at`,
      [home.workspaceId, home.userId, noteId("borndismissed")],
    );
    assert.ok(inserted.rows[0].dismissed_at);
    await admin.query("update crm.conversation_imports set dismissed_at = now() - interval '2 days' where id = $1", [inserted.rows[0].id]);
    await ignoreImport(home, inserted.rows[0].id);
    const kept = await admin.query<{ old: boolean }>("select dismissed_at < now() - interval '1 day' as old from crm.conversation_imports where id = $1", [inserted.rows[0].id]);
    assert.equal(kept.rows[0].old, true);
    for (const offset of [Number.NaN, Number.POSITIVE_INFINITY, 1e30, -5]) {
      const page = await listDismissedImports(home, { offset, limit: Number.NaN });
      assert.ok(page.items.length > 0, String(offset));
    }
    assert.equal((await listDismissedImports(eclipse)).items.some((item) => item.title === "Their copy"), false);
  });

  it("moves a call onto your own dismissed copy in that workspace", async () => {
    const admin = getAdminPool();
    const shared = noteId("owncopy");
    await admin.query(
      `insert into crm.conversation_imports (workspace_id, user_id, source, external_id, kind, title, transcript, status)
       values ($1, $2, 'granola', $3, 'meeting', 'Old copy', 'Mark: old', 'ignored')`,
      [eclipse.workspaceId, home.userId, shared],
    );
    const moving = await admin.query<{ id: string }>(
      `insert into crm.conversation_imports (workspace_id, user_id, source, external_id, kind, title, transcript, status)
       values ($1, $2, 'granola', $3, 'meeting', 'New copy', 'Mark: new', 'unfiled') returning id`,
      [home.workspaceId, home.userId, shared],
    );
    assert.equal(await moveImport(home, moving.rows[0].id, eclipse.workspaceId), moving.rows[0].id);
    const copies = await rows(shared);
    assert.deepEqual(copies.map((copy) => [copy.workspace_id, copy.status, copy.transcript]), [[eclipse.workspaceId, "unfiled", "Mark: new"]]);
  });

  it("never prunes a row whose change is pending or being saved", () => {
    const hidden = new Set(["import:a", "email:b"]);
    const kept = pruneHidden(hidden, [], ["import:a"]);
    assert.deepEqual([...kept], ["import:a"]);
    assert.deepEqual([...pruneHidden(kept, [], [])], []);
  });

  it("treats names with invisible characters as the same name, so a hidden namesake still blocks filing", async () => {
    const cases = [
      ["zerowidth", "Pat", "Pa\u200bt"],
      ["softhyphen", "Kim", "Ki\u00adm"],
    ] as const;
    for (const [label, first, hidden] of cases) {
      await createContact(home, { firstName: first, lastName: "Doe", email: `${label}@home.test` });
      await createContact(eclipse, { firstName: hidden, lastName: "Doe", email: `${label}@eclipse.test` });
      const id = noteId(`hidden${label}`);
      notes.set(id, makeNote(id, home, { attendees: [{ name: `${first} Doe`, email: null }] }));
      await sync();
      const found = await rows(id);
      assert.deepEqual(found.map((row) => [row.status, row.contact_id]), [["unfiled", null]], label);
    }
    assert.equal(foldName("Pa\u200bt Doe"), "pat doe");
    assert.equal(foldName("Pa\u00adt Doe"), "pat doe");
  });

  it("reaches every dismissed call past 220, a page at a time", async () => {
    const admin = getAdminPool();
    await admin.query(
      `insert into crm.conversation_imports (workspace_id, user_id, source, external_id, kind, title, status)
       select $1, $2, 'granola', 'not_bulk' || lpad(n::text, 10, '0'), 'meeting', 'Bulk ' || n, 'ignored'
       from generate_series(1, 240) n`,
      [eclipse.workspaceId, home.userId],
    );
    const first = await listDismissedImports(eclipse);
    assert.equal(first.items.length, 20);
    const seen = new Set(first.items.map((item) => item.id));
    let offset = first.items.length;
    while (offset < first.total) {
      const page = await listDismissedImports(eclipse, { offset, limit: 20 });
      assert.ok(page.items.length > 0, `stuck at ${offset}`);
      for (const item of page.items) seen.add(item.id);
      offset += page.items.length;
    }
    assert.equal(seen.size, first.total);
    assert.ok(seen.size >= 240);
    const requests = pageRequests(20, 230);
    assert.deepEqual(requests, [
      { offset: 20, limit: 200 },
      { offset: 220, limit: 30 },
    ]);
    const reloaded = new Set<string>();
    for (const request of pageRequests(20, first.total - 20)) {
      for (const item of (await listDismissedImports(eclipse, request)).items) reloaded.add(item.id);
    }
    assert.equal(reloaded.size, first.total - 20);
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
