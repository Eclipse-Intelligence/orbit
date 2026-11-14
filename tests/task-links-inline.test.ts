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
  partsSourceOffset,
  pickIntoDescription,
  PRIVATE_DOC_NOTE,
  removeDocQuery,
  showsDescriptionLinks,
} from "@/lib/task-doc-picks";
import { docQueryAt, withoutDocQuery } from "@/lib/task-pad";
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
    const planned = (await listPlannerTasks(mark)).find((item) => item.id === task.id);
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
});
