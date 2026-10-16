import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { detectPadRecords } from "@/lib/crm/task-pad";
import type { UserActor } from "@/lib/crm/types";
import { getPool } from "@/lib/db/pool";
import { mergeMarks, nameMarks, parseTaskText, stripMention } from "@/lib/task-pad";
import { createUser, resetDatabase } from "./helpers";

const FRIDAY_10AM = new Date("2026-10-16T09:00:00Z");

function parse(text: string) {
  return parseTaskText(text, FRIDAY_10AM);
}

describe("task pad parser", () => {
  it("reads days, times and reminders and leaves a clean title", () => {
    const walk = parse("Take the dog for a walk Monday at 3pm");
    assert.deepEqual(
      { title: walk.title, due: walk.due, remindMinutes: walk.remindMinutes, unsure: walk.unsure },
      { title: "Take the dog for a walk", due: "2026-10-19T15:00", remindMinutes: null, unsure: false },
    );
    const call = parse("Call Jane at Acme Monday 3pm, remind me 1 hour before");
    assert.deepEqual(
      { title: call.title, due: call.due, remindMinutes: call.remindMinutes, unsure: call.unsure },
      { title: "Call Jane at Acme", due: "2026-10-19T15:00", remindMinutes: 60, unsure: false },
    );
    assert.equal(parse("Ship it Friday morning, remind 30 mins").remindMinutes, 30);
    assert.equal(parse("Check in with Bob in 3 days remind me a day before").remindMinutes, 1440);
    assert.equal(parse("Ping Sam tomorrow, remind me 45 minutes before").remindMinutes, 30);
  });

  it("keeps the time when a reminder follows it", () => {
    const result = parse("Speak to Toby Sutton OBE tomorrow at 12:15 and remind me 30 mins before");
    assert.equal(result.due, "2026-10-17T12:15");
    assert.equal(result.remindMinutes, 30);
    assert.equal(result.title, "Speak to Toby Sutton OBE");
    assert.equal(parse("at 12:15 remind me 30 mins").due, "2026-10-16T12:15");
    assert.equal(parse("Lunch 1.30pm tomorrow").due, "2026-10-17T13:30");
  });

  it("understands common ways of saying when", () => {
    const cases: [string, string | null][] = [
      ["Send proposal", null],
      ["Send proposal tomorrow", "2026-10-17T09:00"],
      ["Review deck on 22 Oct at 10:30", "2026-10-22T10:30"],
      ["Follow up 22/10", "2026-10-22T09:00"],
      ["Chase invoice in 2 hours", "2026-10-16T12:00"],
      ["Book flights next week", "2026-10-19T09:00"],
      ["Email Sam tonight", "2026-10-16T19:00"],
      ["Quarterly review December 3rd 2026", "2026-12-03T09:00"],
      ["Renew domain 1 Feb", "2027-02-01T09:00"],
      ["Finish report by end of day", "2026-10-16T17:00"],
      ["Lunch with Tom at noon", "2026-10-16T12:00"],
      ["Call mum 9am", "2026-10-17T09:00"],
      ["Plan Wed 2pm", "2026-10-21T14:00"],
      ["Wrap up end of week", "2026-10-16T17:00"],
    ];
    for (const [text, due] of cases) assert.equal(parse(text).due, due, text);
  });

  it("doesn't mistake names and words for dates", () => {
    for (const text of ["Send Monica the deck", "I sat down with Sunil", "Call Jane", "Fix the deck"]) {
      const result = parse(text);
      assert.equal(result.due, null, text);
      assert.deepEqual(result.marks, [], text);
      assert.equal(result.unsure, false, text);
      assert.equal(result.title, text);
    }
  });

  it("marks where it read each part so the input can highlight it", () => {
    const text = "Call Toby Sutton OBE at 3pm on Wednesday and remind me 15 mins";
    const marks = mergeMarks([...parse(text).marks, ...nameMarks(text, ["Toby Sutton OBE"])]);
    assert.deepEqual(
      marks.map((mark) => [mark.kind, text.slice(mark.start, mark.end)]),
      [
        ["record", "Toby Sutton OBE"],
        ["when", "3pm"],
        ["when", "Wednesday"],
        ["reminder", "remind me 15 mins"],
      ],
    );
    assert.deepEqual(nameMarks("Visit Acme and acme again", ["Acme"]).length, 2);
    assert.deepEqual(nameMarks("Visit Acmeworks", ["Acme"]), []);
  });

  it("flags leftovers it can't read so the AI can help", () => {
    const result = parse("Prep for Thursday after next");
    assert.equal(result.unsure, true);
  });

  it("finds an @ mention at the caret", () => {
    assert.deepEqual(stripMention("Call @Ac", 8), { start: 5, end: 8, query: "Ac" });
    assert.equal(stripMention("email me@acme.com", 17), null);
    assert.equal(stripMention("No mention", 10), null);
  });
});

describe("task pad record detection", () => {
  let owner: UserActor;

  before(async () => {
    await resetDatabase();
    owner = await createUser("pad@orbit.test", "Mark Ridgeon");
    const acme = (await createCompany(owner, { name: "Acme", domain: "acme-pad.test" })).body.company.id;
    await createCompany(owner, { name: "Ace", domain: "ace-pad.test" });
    await createContact(owner, { companyId: acme, firstName: "Jane", lastName: "Doe", email: "jane@acme-pad.test" });
    await createContact(owner, { firstName: "Jane", lastName: "Smith", email: "jane@smith-pad.test" });
  });

  after(async () => {
    await getPool().end();
  });

  it("links a company or person named exactly once", async () => {
    const found = await detectPadRecords(owner, "Call Jane Doe at Acme about pricing");
    assert.equal(found.company?.name, "Acme");
    assert.equal(found.contact?.name, "Jane Doe");
    assert.equal(found.contact?.company?.name, "Acme");
  });

  it("ignores partial words and ambiguous names", async () => {
    const found = await detectPadRecords(owner, "Find a place to meet Jane");
    assert.equal(found.company, null);
    assert.equal(found.contact, null);
  });
});
