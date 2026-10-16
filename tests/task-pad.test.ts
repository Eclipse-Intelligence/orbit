import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { detectPadRecords } from "@/lib/crm/task-pad";
import type { UserActor } from "@/lib/crm/types";
import { getPool } from "@/lib/db/pool";
import { parseTaskText, stripMention } from "@/lib/task-pad";
import { createUser, resetDatabase } from "./helpers";

const FRIDAY_10AM = new Date("2026-10-16T09:00:00Z");

function parse(text: string) {
  return parseTaskText(text, FRIDAY_10AM);
}

describe("task pad parser", () => {
  it("reads days, times and reminders and leaves a clean title", () => {
    assert.deepEqual(parse("Take the dog for a walk Monday at 3pm"), {
      title: "Take the dog for a walk",
      due: "2026-10-19T15:00",
      remindMinutes: null,
      unsure: false,
    });
    assert.deepEqual(parse("Call Jane at Acme Monday 3pm, remind me 1 hour before"), {
      title: "Call Jane at Acme",
      due: "2026-10-19T15:00",
      remindMinutes: 60,
      unsure: false,
    });
    assert.equal(parse("Ship it Friday morning, remind 30 mins").remindMinutes, 30);
    assert.equal(parse("Check in with Bob in 3 days remind me a day before").remindMinutes, 1440);
    assert.equal(parse("Ping Sam tomorrow, remind me 45 minutes before").remindMinutes, 30);
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
      assert.equal(result.unsure, false, text);
      assert.equal(result.title, text);
    }
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
