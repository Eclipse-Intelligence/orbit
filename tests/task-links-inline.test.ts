import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { scopesForRole } from "@/lib/crm/scopes";
import { changeTaskDoc } from "@/lib/crm/task-doc-links";
import { canChangeTask } from "@/lib/crm/task-rights";
import { addTaskParticipants, createTask, getTask, listPlannerTasks, updateTask } from "@/lib/crm/tasks";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createDoc } from "@/lib/docs/store";
import {
  descriptionParts,
  docReferenceTitle,
  hasDocReference,
  insertDocReference,
  insideClosedReference,
  caretAfterEdit,
  textEdit,
  withoutReferenceNear,
  partsSourceOffset,
  pickIntoDescription,
  PRIVATE_DOC_NOTE,
  removeDocQuery,
  showsDescriptionLinks,
} from "@/lib/task-doc-picks";
import { docQueryAt, parseTaskText, withoutDocQuery } from "@/lib/task-pad";
import { createUser, resetDatabase } from "./helpers";

const WEB = { operation: "link_task_doc", source: "web" } as const;

describe("[[ in a task's title and description", () => {
  it("removes the [[query from the title, as the Add task card does", () => {
    const title = "Send Acme the renewal terms [[ren";
    const found = docQueryAt(title, title.length);
    assert.deepEqual(found, { start: 28, end: 33, query: "ren" });
    assert.deepEqual(withoutDocQuery(title, found!), { text: "Send Acme the renewal terms ", caret: 28 });
  });

  it("writes a shared doc as [[Title]] at the caret", () => {
    const text = "Use the numbers in [[Renewal plan]] and check [[pri";
    const found = docQueryAt(text, text.length)!;
    const shared = pickIntoDescription(text, found, { title: "Pricing notes", shared: true });
    assert.equal(shared.text, "Use the numbers in [[Renewal plan]] and check [[Pricing notes]] ");
    assert.equal(shared.caret, shared.text.length);
    assert.equal(shared.note, null);

    const middle = "Check [[pri before sending.";
    const inside = docQueryAt(middle, 11)!;
    assert.deepEqual(inside, { start: 6, end: 11, query: "pri" });
    assert.deepEqual(insertDocReference(middle, inside, "Pricing notes"), { text: "Check [[Pricing notes]] before sending.", caret: 23 });
    assert.equal(insertDocReference("See [[pri]].", { start: 4, end: 9 }, "Pricing notes").text, "See [[Pricing notes]].");
    assert.equal(insertDocReference("[[q", { start: 0, end: 3 }, "Q3 [draft]\nplan").text, "[[Q3 draft plan]] ");
    assert.equal(docReferenceTitle(""), "Untitled");
  });

  it("only links a private doc and never writes its title into the description", () => {
    const text = "Use the numbers in [[Renewal plan]] and [[my d";
    const found = docQueryAt(text, text.length)!;
    const picked = pickIntoDescription(text, found, { title: "My draft terms", shared: false });
    assert.equal(picked.text, "Use the numbers in [[Renewal plan]] and ");
    assert.equal(picked.caret, picked.text.length);
    assert.equal(picked.note, PRIVATE_DOC_NOTE);
    assert.equal(PRIVATE_DOC_NOTE, "Linked. Private docs aren't named in the description.");
    assert.ok(!picked.text.includes("My draft"));

    assert.deepEqual(removeDocQuery("First line\n[[my d\nSecond line", { start: 11, end: 17 }), { text: "First line\n\nSecond line", caret: 11 });
    assert.deepEqual(removeDocQuery("Ask [[my d about it", { start: 4, end: 10 }), { text: "Ask about it", caret: 4 });
    assert.deepEqual(removeDocQuery("Ask [[my d]] now", { start: 4, end: 10 }), { text: "Ask now", caret: 4 });
  });

  it("shows the read view for a description with a doc reference on rows and in the panel, until it is being edited", () => {
    assert.equal(hasDocReference("Use [[Renewal plan]]"), true);
    assert.equal(hasDocReference("Use [[Renewal plan"), false);
    assert.equal(showsDescriptionLinks("Use [[Renewal plan]]", "row", false), true);
    assert.equal(showsDescriptionLinks("Use [[Renewal plan]]", "panel", false), true);
    assert.equal(showsDescriptionLinks("Use [[Renewal plan]]", "row", true), false);
    assert.equal(showsDescriptionLinks("See https://northwind.test", "row", false), false);
    assert.equal(showsDescriptionLinks("See https://northwind.test", "panel", false), true);
  });

  it("links [[Title]] only to a linked doc the viewer can open, and maps clicks back to the text", () => {
    const text = "Use [[Renewal plan]] and [[Secret]] or [[Elsewhere]].";
    const parts = descriptionParts(text, [
      { id: "a", title: "renewal  plan", readable: true },
      { id: "b", title: null, readable: false },
    ]);
    assert.deepEqual(parts, [
      { kind: "text", text: "Use ", start: 0 },
      { kind: "doc", id: "a", label: "Renewal plan", start: 4 },
      { kind: "text", text: " and [[Secret]] or [[Elsewhere]].", start: 20 },
    ]);
    assert.equal(partsSourceOffset(text, parts, 2), 2);
    assert.equal(partsSourceOffset(text, parts, 5), 7, "a click inside a doc link lands inside the brackets");
    assert.equal(partsSourceOffset(text, parts, 9), 11);
    assert.equal(partsSourceOffset(text, parts, 17), 21);
    assert.equal(partsSourceOffset(text, parts, 999), text.length);
    assert.deepEqual(descriptionParts("No references", []), [{ kind: "text", text: "No references", start: 0 }]);
  });

  it("puts the caret outside a doc link clicked at its edge, and never opens the picker inside a closed reference", () => {
    const text = "Use [[Renewal plan]] now";
    const parts = descriptionParts(text, [{ id: "a", title: "Renewal plan", readable: true }]);
    assert.equal(partsSourceOffset(text, parts, 4), 4, "the start of a link is before [[");
    assert.equal(partsSourceOffset(text, parts, 16), 20, "the end of a link is after ]]");
    assert.equal(partsSourceOffset(text, parts, 17), 21);
    const inside = docQueryAt(text, 12)!;
    assert.deepEqual(inside, { start: 4, end: 18, query: "Renewal plan" });
    assert.equal(insideClosedReference(text, inside), true);
    const after = "Use [[Renewal plan]] and [[pri";
    assert.equal(insideClosedReference(after, docQueryAt(after, after.length)!), false);
    assert.equal(docQueryAt(text, 20), null);
  });

  it("replaces the whole of a multi-word reference when the caret is in its first word", () => {
    const text = "Check [[renewal plan]] today";
    const found = docQueryAt(text, 10)!;
    assert.deepEqual(found, { start: 6, end: 20, query: "renewal plan" });
    assert.deepEqual(insertDocReference(text, found, "Renewal plan v2"), { text: "Check [[Renewal plan v2]] today", caret: 25 });
    assert.deepEqual(withoutDocQuery(text, found), { text: "Check today", caret: 6 });
    assert.deepEqual(docQueryAt("Call [[renewal now", 10), { start: 5, end: 14, query: "renewal" }, "an unclosed query still stops at the word");
    assert.equal(insideClosedReference("[[a]] b [[c", docQueryAt("[[a]] b [[c", 3)!), true);
  });

  it("never reads a date inside [[...]], open or closed, before or after picking", () => {
    const now = new Date("2026-11-12T09:00:00Z");
    const typing = "Check [[friday review 3pm";
    assert.equal(parseTaskText(typing, now).due, null);
    const found = docQueryAt(typing, typing.length)!;
    assert.deepEqual(found, { start: 6, end: 25, query: "friday review 3pm" });
    const picked = withoutDocQuery(typing, found);
    assert.equal(picked.text, "Check ");
    const closed = "Check [[Friday review 3pm]] with Jane";
    assert.equal(parseTaskText(closed, now).due, null);
    assert.equal(parseTaskText(closed, now).title, closed);
    const inside = docQueryAt(closed, 10)!;
    assert.deepEqual(inside, { start: 6, end: 25, query: "Friday review 3pm" });
    assert.equal(insertDocReference(closed, inside, "Friday review 3pm").text, closed);
    assert.equal(parseTaskText(`${closed} tomorrow`, now).due, "2026-11-13");
  });

  it("takes out the inserted reference nearest where it was put when linking fails, and edits only what changed", () => {
    assert.equal(withoutReferenceNear("See [[Plan]] then [[Plan]] here", "[[Plan]]", 18), "See [[Plan]] then here");
    assert.equal(withoutReferenceNear("See [[Plan]] then [[Plan]] here", "[[Plan]]", 2), "See then [[Plan]] here");
    assert.equal(withoutReferenceNear("Nothing here", "[[Plan]]", 0), "Nothing here");
    assert.deepEqual(textEdit("Check [[pri now", "Check [[Pricing notes]] now"), { start: 8, end: 11, insert: "Pricing notes]]" });
    assert.deepEqual(textEdit("Ask [[my d about", "Ask about"), { start: 4, end: 11, insert: "" });
    const removal = textEdit("See [[Plan]] and more", "See and more");
    assert.equal(caretAfterEdit(removal, 21), 12, "a caret after the removed reference moves back with the text");
    assert.equal(caretAfterEdit(removal, 2), 2, "a caret before it stays put");
    assert.equal(caretAfterEdit(removal, 8), 4, "a caret inside it lands where it was");
  });

  it("links duplicate titles to the first linked doc the viewer can open", () => {
    const parts = descriptionParts("[[Plan]]", [
      { id: "hidden", title: null, readable: false },
      { id: "first", title: "Plan", readable: true },
      { id: "second", title: "plan", readable: true },
    ]);
    assert.deepEqual(parts, [{ kind: "doc", id: "first", label: "Plan", start: 0 }]);
  });
});

describe("chips and doc links on an existing task", () => {
  let mark: UserActor;
  let priya: UserActor;
  let shared: string;
  let privateDoc: string;

  async function join(user: UserActor, role: WorkspaceRole): Promise<UserActor> {
    await getAdminPool().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [mark.workspaceId, user.userId, role]);
    return { ...user, workspaceId: mark.workspaceId, workspaceName: mark.workspaceName, role, scopes: scopesForRole(role) };
  }

  before(async () => {
    await resetDatabase();
    mark = await createUser("mark@links-inline.test", "Mark Ridgeon");
    priya = await join(await createUser("priya@links-inline.test", "Priya Nair"), "member");
    shared = (await createDoc(mark, { title: "Renewal plan", content: "Numbers.", shared: true })).id;
    privateDoc = (await createDoc(mark, { title: "My draft terms", content: "Draft." })).id;
  });

  after(async () => {
    await getPool().end();
    await getAdminPool().end();
  });

  it("links a shared doc for everyone, but a private doc named in the text stays plain for a tagged teammate", async () => {
    const description = "Use the numbers in [[Renewal plan]] and [[My draft terms]].";
    const task = (await createTask(mark, { title: "Send Acme the renewal terms", ownerId: mark.userId, description, docIds: [shared, privateDoc] })).body.task;
    await addTaskParticipants(mark, task.id, [priya.userId]);

    const own = descriptionParts(description, (await getTask(mark, task.id)).docs);
    assert.deepEqual(
      own.flatMap((part) => (part.kind === "doc" ? [[part.id, part.label]] : [])),
      [
        [shared, "Renewal plan"],
        [privateDoc, "My draft terms"],
      ],
    );

    const seen = await getTask(priya, task.id);
    assert.deepEqual(seen.docs.find((doc) => doc.id === privateDoc), { id: privateDoc, title: null, readable: false });
    const theirs = descriptionParts(description, seen.docs);
    assert.deepEqual(
      theirs.flatMap((part) => (part.kind === "doc" ? [[part.id, part.label]] : [])),
      [[shared, "Renewal plan"]],
    );
    assert.ok(theirs.some((part) => part.kind === "text" && part.text.includes("[[My draft terms]]")));

    const unlinked = await updateTask(mark, task.id, { docIds: [privateDoc] });
    assert.deepEqual(
      descriptionParts(description, unlinked.body.task.docs).flatMap((part) => (part.kind === "doc" ? [part.label] : [])),
      ["My draft terms"],
      "a shared doc that is no longer linked shows as written",
    );
  });

  it("only lets the assignee or creator change links, and a tagged teammate can't link a doc", async () => {
    const task = (await createTask(mark, { title: "Book the Q1 review", ownerId: mark.userId })).body.task;
    await addTaskParticipants(mark, task.id, [priya.userId]);
    assert.equal(canChangeTask(mark, task), true);
    assert.equal(canChangeTask(priya, task), false);
    await assert.rejects(() => changeTaskDoc(priya, task.id, shared, "link", WEB), /assignee|creator|can't|Only/i);
    assert.deepEqual((await getTask(mark, task.id)).docIds, []);
    const linked = await changeTaskDoc(mark, task.id, shared, "link", WEB);
    assert.ok(linked);
    assert.deepEqual((await getTask(mark, task.id)).docIds, [shared]);
  });

  it("gives Calendar's tasks their docs and link rights, so its panel shows the same chips", async () => {
    const task = (await createTask(mark, { title: "Review the renewal plan", ownerId: mark.userId, docIds: [shared, privateDoc] })).body.task;
    const planned = (await listPlannerTasks(mark, Date.now(), { links: true })).find((item) => item.id === task.id);
    assert.ok(planned);
    assert.equal(planned.canLinkDocs, true);
    assert.deepEqual(
      planned.docs.map((doc) => [doc.title, doc.readable]),
      [
        ["Renewal plan", true],
        ["My draft terms", true],
      ],
    );
  });

  it("keeps Calendar private: another person's private doc and email stay hidden, tagged tasks aren't listed, and time blocks load no links", async () => {
    const connection = await getAdminPool().query<{ id: string }>(
      `insert into crm.mailbox_connections (workspace_id, user_id, provider, email, status, refresh_token)
       values ($1, $2, 'microsoft', $3, 'connected', 'cipher') returning id`,
      [mark.workspaceId, mark.userId, "mark@links-inline.test"],
    );
    const source = await getAdminPool().query<{ id: string }>("insert into crm.mail_sources (workspace_id, user_id, connection_id, email) values ($1, $2, $3, $4) returning id", [
      mark.workspaceId,
      mark.userId,
      connection.rows[0].id,
      "mark@links-inline.test",
    ]);
    const folder = await getAdminPool().query<{ id: string }>(
      "insert into crm.mail_folders (workspace_id, user_id, source_id, provider_folder_id, name, role) values ($1, $2, $3, 'inbox-x', 'inbox', 'inbox') returning id",
      [mark.workspaceId, mark.userId, source.rows[0].id],
    );
    await getAdminPool().query(
      `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, internet_message_id, thread_key, subject, snippet,
         from_email, to_recipients, cc_recipients, sent_at, received_at)
       values ($1, $2, $3, $4, 'inline-1', '<inline-1@mail.test>', 'terms', 'Mark''s pricing terms', 'Hello', 'jane@acme.test', '[]'::jsonb, '[]'::jsonb, now(), now())`,
      [mark.workspaceId, mark.userId, source.rows[0].id, folder.rows[0].id],
    );
    const thread = `${source.rows[0].id}|terms`;

    const hers = (await createTask(mark, { title: "Send Priya's renewal pack", ownerId: priya.userId, docIds: [shared, privateDoc], mailThreadKey: thread })).body.task;
    const planned = (await listPlannerTasks(priya, Date.now(), { links: true })).find((item) => item.id === hers.id);
    assert.ok(planned);
    assert.deepEqual(planned.docs, [
      { id: shared, title: "Renewal plan", readable: true },
      { id: privateDoc, title: null, readable: false },
    ]);
    assert.deepEqual(planned.mailThread, { subject: null, readable: false });
    assert.equal(planned.canLinkDocs, true, "the assignee can link docs on their own task");
    const own = (await listPlannerTasks(mark, Date.now(), { links: true })).find((item) => item.id === hers.id);
    assert.equal(own, undefined, "Calendar lists only the viewer's own tasks");

    const tagged = (await createTask(mark, { title: "Mark's tagged task", ownerId: mark.userId, docIds: [privateDoc], mailThreadKey: thread })).body.task;
    await addTaskParticipants(mark, tagged.id, [priya.userId]);
    assert.equal((await listPlannerTasks(priya, Date.now(), { links: true })).some((item) => item.id === tagged.id), false, "a tagged viewer never gets the task in Calendar");
    const seen = await getTask(priya, tagged.id);
    assert.deepEqual([seen.docs[0], seen.mailThread, seen.canLinkDocs], [{ id: privateDoc, title: null, readable: false }, { subject: null, readable: false }, false]);

    const blocks = (await listPlannerTasks(mark)).find((item) => item.id === tagged.id);
    assert.ok(blocks);
    assert.deepEqual([blocks.docs, blocks.canLinkDocs, blocks.mailThread?.readable ?? false], [[], false, false], "time blocks read no doc titles or mail");
  });
});
