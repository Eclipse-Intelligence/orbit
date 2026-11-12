import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { createOpportunity } from "@/lib/crm/opportunities";
import { scopesForRole } from "@/lib/crm/scopes";
import { detectPadRecords, searchPadRecords } from "@/lib/crm/task-pad";
import { createTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { mergeMarks, nameMarks, padConfirmLine, padNeedsConfirm, parseTaskText, reminderClock, stripMention } from "@/lib/task-pad";
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

  it("leaves prices in the title instead of reading them as times", () => {
    const invoice = parse("Invoice £12.50 by Friday");
    assert.deepEqual({ title: invoice.title, due: invoice.due }, { title: "Invoice £12.50", due: "2026-10-23T09:00" });
    for (const [text, title] of [
      ["Pay $9.15", "Pay $9.15"],
      ["Refund € 7.45 tomorrow", "Refund € 7.45"],
      ["Charge GBP 12.50 tomorrow", "Charge GBP 12.50"],
      ["Charge 12.50 GBP tomorrow", "Charge 12.50 GBP"],
      ["Quote usd 3pm", "Quote usd 3pm"],
    ] as const) {
      const result = parse(text);
      assert.equal(result.title, title, text);
      assert.ok(!result.due || result.due.endsWith("T09:00"), text);
    }
    const priced = parse("Send the £12.50 invoice at 14:30");
    assert.deepEqual({ title: priced.title, due: priced.due }, { title: "Send the £12.50 invoice", due: "2026-10-16T14:30" });
  });

  it("still reads every time form it read before", () => {
    const cases: [string, string, string][] = [
      ["Call at 12.50", "Call", "2026-10-16T12:50"],
      ["Call 12:50", "Call", "2026-10-16T12:50"],
      ["Call at 12:50", "Call", "2026-10-16T12:50"],
      ["Call 12.50pm", "Call", "2026-10-16T12:50"],
      ["Call 1.30pm tomorrow", "Call", "2026-10-17T13:30"],
      ["Call at 3pm", "Call", "2026-10-16T15:00"],
      ["Call 9am", "Call", "2026-10-17T09:00"],
      ["Call at noon", "Call", "2026-10-16T12:00"],
    ];
    for (const [text, title, due] of cases) {
      const result = parse(text);
      assert.deepEqual({ title: result.title, due: result.due }, { title, due }, text);
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

  it("words the confirmation line for what the card will link", () => {
    const base = { contactTitle: null, company: null, companyDomain: null, matchedBy: null, word: null };
    const jane = { name: "Jane Cooper", company: { name: "Northwind" } };
    assert.equal(
      padConfirmLine({ ...base, contact: jane, contactTitle: "Head of Operations", matchedBy: "name", word: "Jane" }),
      "Jane Cooper, Head of Operations at Northwind, is the only Jane",
    );
    assert.equal(padConfirmLine({ ...base, contact: jane, matchedBy: "name", word: "Jane" }), "Jane Cooper at Northwind is the only Jane");
    assert.equal(padConfirmLine({ ...base, contact: { name: "Jane Cooper", company: null }, matchedBy: "full" }), "Jane Cooper");
    assert.equal(padConfirmLine({ ...base, contact: null, company: { name: "Zoom" }, companyDomain: "zoom.us", word: "Zoom" }), "Zoom (zoom.us) is the only Zoom");
    assert.equal(padConfirmLine({ ...base, contact: null }), null);
  });

  it("saves on one Enter unless the latest text needs a confirmation Mark hasn't seen", () => {
    const none = { contactId: null, companyId: null, ask: null };
    const plain = { contactByName: false, companyOneWord: false };
    assert.equal(padNeedsConfirm(none, { ...none, ...plain, contactId: "raj", companyId: "halden" }), false, "a full name links straight away");
    assert.equal(padNeedsConfirm(none, { ...none, ...plain, companyId: "halden" }), false, "a multi-word company links straight away");
    assert.equal(padNeedsConfirm({ ...none, contactId: "jane" }, { ...none, ...plain }), false, "a stale link is dropped without asking");
    assert.equal(padNeedsConfirm(none, { ...none, contactId: "jane", contactByName: true, companyOneWord: false }), true, "a first name is shown first");
    assert.equal(padNeedsConfirm({ ...none, contactId: "jane" }, { ...none, contactId: "jane", contactByName: true, companyOneWord: false }), false, "a first name already shown saves");
    assert.equal(padNeedsConfirm(none, { ...none, companyId: "zoom", contactByName: false, companyOneWord: true }), true, "a one-word company is shown first");
    assert.equal(padNeedsConfirm(none, { ...none, ...plain, ask: "Janet" }), true, "an ambiguous name asks first");
    assert.equal(padNeedsConfirm({ ...none, ask: "Janet" }, { ...none, ...plain, ask: "Janet" }), false, "a question already shown saves unlinked");
  });

  it("shows when a reminder goes off", () => {
    assert.equal(reminderClock("2026-11-16T15:00", 60), "14:00");
    assert.equal(reminderClock("2026-11-16T15:00", 0), "15:00");
    assert.equal(reminderClock("2026-11-16T09:00", 1440), "Sun 15 Nov, 09:00");
    assert.equal(reminderClock("soon", 5), null);
  });

  it("finds an @ mention at the caret", () => {
    assert.deepEqual(stripMention("Call @Ac", 8), { start: 5, end: 8, query: "Ac" });
    assert.equal(stripMention("email me@acme.com", 17), null);
    assert.equal(stripMention("No mention", 10), null);
  });
});

describe("task pad record detection", () => {
  let owner: UserActor;
  let acme: string;
  let halden: string;
  let priya: string;

  async function join(email: string, name: string) {
    const user = await createUser(email, name);
    await getAdminPool().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, user.userId]);
    return { ...user, workspaceId: owner.workspaceId, role: "member" as const, scopes: scopesForRole("member") };
  }

  before(async () => {
    await resetDatabase();
    owner = await createUser("pad@orbit.test", "Mark Ridgeon");
    acme = (await createCompany(owner, { name: "Acme", domain: "acme-pad.test" })).body.company.id;
    await createCompany(owner, { name: "Ace", domain: "ace-pad.test" });
    await createCompany(owner, { name: "Monday", domain: "monday-pad.test" });
    halden = (await createCompany(owner, { name: "Halden Group", domain: "halden-pad.test" })).body.company.id;
    await createContact(owner, { companyId: acme, firstName: "Jane", lastName: "Doe", email: "jane@acme-pad.test" });
    await createContact(owner, { firstName: "Jane", lastName: "Smith", email: "jane@smith-pad.test" });
    priya = (await createContact(owner, { companyId: acme, firstName: "Priya", lastName: "Shah", jobTitle: "Head of Operations", email: "priya@acme-pad.test" })).body.contact.id;
    await createContact(owner, { companyId: halden, firstName: "Sam", lastName: "Whitfield", jobTitle: "Operations Director", email: "sam@halden-pad.test" });
    await createContact(owner, { firstName: "Sam", lastName: "Reid", email: "sam@reid-pad.test" });
    await createContact(owner, { firstName: "Sam", lastName: "Okafor", email: "sam@okafor-pad.test" });
    await createContact(owner, { firstName: "Lena", lastName: "Fox", email: "lena@fox-pad.test" });
    await join("sam@team-pad.test", "Sam Okafor");
    await join("lena@team-pad.test", "Lena Brandt");
    await createOpportunity(owner, { companyId: acme, name: "Acme renewal 2027" });
    await createOpportunity(owner, { companyId: halden, name: "Halden pilot" });
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

  it("proposes the only contact with a first name, with their company and title, and skips dates", async () => {
    const found = await detectPadRecords(owner, "Call Priya Monday 3pm");
    assert.equal(found.contact?.id, priya);
    assert.equal(found.matchedBy, "name");
    assert.equal(found.word, "Priya");
    assert.equal(found.contactTitle, "Head of Operations");
    assert.equal(found.company?.id, acme);
    assert.equal(found.ask, null);
    assert.equal(padConfirmLine(found), "Priya Shah, Head of Operations at Acme, is the only Priya");
    assert.equal((await detectPadRecords(owner, "call priya about pricing")).contact, null);
  });

  it("narrows a shared first name to the company named, and otherwise asks", async () => {
    const atAcme = await detectPadRecords(owner, "Call Jane at Acme");
    assert.equal(atAcme.contact?.name, "Jane Doe");
    const unsure = await detectPadRecords(owner, "Call Jane tomorrow");
    assert.equal(unsure.contact, null);
    assert.equal(unsure.ask?.word, "Jane");
    assert.deepEqual(unsure.ask?.candidates.map((candidate) => candidate.name).sort(), ["Jane Doe", "Jane Smith"]);
  });

  it("never offers a teammate as a contact and asks when a first name is also a teammate's", async () => {
    const sam = await detectPadRecords(owner, "Call Sam about the pilot tomorrow");
    assert.equal(sam.contact, null);
    assert.equal(sam.ask?.word, "Sam");
    assert.deepEqual(sam.ask?.candidates.map((candidate) => candidate.name).sort(), ["Sam Reid", "Sam Whitfield"]);
    assert.equal(sam.ask?.candidates.find((candidate) => candidate.name === "Sam Whitfield")?.detail, "Operations Director · Halden Group");
    const lena = await detectPadRecords(owner, "Ask Lena for the slides");
    assert.equal(lena.contact, null);
    assert.deepEqual(lena.ask?.candidates.map((candidate) => candidate.name), ["Lena Fox"]);
    const named = await detectPadRecords(owner, "Ask Sam Okafor about the pilot");
    assert.equal(named.contact, null);
    assert.equal(named.ask, null);
  });

  it("still never links a first name when a task is saved without links", async () => {
    const task = (await createTask(owner, { title: "Call Priya Monday" })).body.task;
    assert.deepEqual([task.contactId, task.companyId], [null, null]);
  });

  it("searches people, companies and opportunities to link by hand", async () => {
    const people = await searchPadRecords(owner, "contact", "Sam");
    assert.deepEqual(people.map((person) => person.name).sort(), ["Sam Reid", "Sam Whitfield"]);
    const companies = await searchPadRecords(owner, "company", "hald");
    assert.deepEqual(companies.map((company) => company.name), ["Halden Group"]);
    const all = await searchPadRecords(owner, "opportunity", "");
    assert.equal(all.length, 2);
    const atHalden = await searchPadRecords(owner, "opportunity", "", halden);
    assert.deepEqual(atHalden.map((opportunity) => [opportunity.name, opportunity.company?.id]), [["Halden pilot", halden]]);
    const atAcme = await searchPadRecords(owner, "contact", "", acme);
    assert.deepEqual(atAcme.slice(0, 2).map((person) => person.name).sort(), ["Jane Doe", "Priya Shah"]);
    assert.ok(atAcme.some((person) => person.name === "Jane Smith"), "a company only puts its people first");
    assert.ok(!atAcme.some((person) => person.name === "Sam Okafor"), "teammates are never offered");
  });

  it("asks about an earlier shared name rather than proposing a later unique one", async () => {
    const found = await detectPadRecords(owner, "Call Jane and Priya");
    assert.equal(found.contact, null);
    assert.equal(found.ask?.word, "Jane");
  });

  it("does not read the leading verb as a surname", async () => {
    await createContact(owner, { firstName: "Bill", lastName: "Chase", email: "bill@chase-pad.test" });
    const found = await detectPadRecords(owner, "Chase Priya for the invoice");
    assert.equal(found.contact?.id, priya);
    const mid = await detectPadRecords(owner, "Invoice from Chase");
    assert.equal(mid.contact?.name, "Bill Chase");
  });

  it("counts each name on its own, so many matches never look unique", async () => {
    for (let index = 0; index < 9; index += 1) {
      await createContact(owner, { firstName: "John", lastName: `Tester${String.fromCharCode(65 + index)}`, email: `john${index}@many-pad.test` });
    }
    await createContact(owner, { firstName: "Oscar", lastName: "Lone", email: "oscar@lone-pad.test" });
    const many = await detectPadRecords(owner, "Ask John to call Oscar");
    assert.equal(many.contact, null);
    assert.equal(many.ask?.word, "John");
    assert.equal(many.ask?.candidates.length, 6);
    const lone = await detectPadRecords(owner, "Ask Oscar to call John");
    assert.equal(lone.contact?.name, "Oscar Lone");
  });

  it("scopes a shared first name to the company chosen on the card", async () => {
    const found = await detectPadRecords(owner, "Call Jane", { companyId: acme });
    assert.equal(found.contact?.name, "Jane Doe");
    const elsewhere = await detectPadRecords(owner, "Call Priya", { companyId: halden });
    assert.equal(elsewhere.contact, null);
    assert.deepEqual(elsewhere.ask?.candidates.map((candidate) => candidate.name), ["Priya Shah"]);
  });

  it("finds a full name that contains a date word, but never a date word alone", async () => {
    const media = (await createCompany(owner, { name: "Friday Media", domain: "friday-pad.test" })).body.company.id;
    const found = await detectPadRecords(owner, "Chase Friday Media invoice");
    assert.equal(found.company?.id, media);
    const monday = await detectPadRecords(owner, "Call Priya Monday");
    assert.notEqual(monday.company?.name, "Monday");
  });
});
