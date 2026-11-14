import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { createOpportunity } from "@/lib/crm/opportunities";
import { scopesForRole } from "@/lib/crm/scopes";
import { detectPadRecords, parsePadWithAi, searchPadRecords } from "@/lib/crm/task-pad";
import { createTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import {
  mergeMarks,
  nameMarks,
  padConfirmLine,
  padDueHasTime,
  padNeedsConfirm,
  padRelease,
  padSaveIds,
  parseTaskText,
  reminderClock,
  resolvePadLinks,
  stripMention,
  type PadPick,
} from "@/lib/task-pad";
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
      ["Send proposal tomorrow", "2026-10-17"],
      ["Review deck on 22 Oct at 10:30", "2026-10-22T10:30"],
      ["Follow up 22/10", "2026-10-22"],
      ["Chase invoice in 2 hours", "2026-10-16T12:00"],
      ["Book flights next week", "2026-10-19"],
      ["Email Sam tonight", "2026-10-16T19:00"],
      ["Quarterly review December 3rd 2026", "2026-12-03"],
      ["Renew domain 1 Feb", "2027-02-01"],
      ["Finish report by end of day", "2026-10-16T17:00"],
      ["Lunch with Tom at noon", "2026-10-16T12:00"],
      ["Call mum 9am", "2026-10-17T09:00"],
      ["Plan Wed 2pm", "2026-10-21T14:00"],
      ["Wrap up end of week", "2026-10-16T17:00"],
    ];
    for (const [text, due] of cases) assert.equal(parse(text).due, due, text);
  });

  it("keeps a day alone as date only, and gives a time only when one is typed", () => {
    assert.equal(parse("Call Jane Monday").due, "2026-10-19");
    assert.equal(parse("Call Jane Monday").remindMinutes, null);
    assert.equal(parse("Call Jane Monday at 11:15").due, "2026-10-19T11:15");
    assert.equal(parse("Call Jane Monday morning").due, "2026-10-19T09:00");
    assert.equal(parse("Call Jane in 3 days").due, "2026-10-19");
    const reminded = parse("Call Jane Monday, remind me 15 mins before");
    assert.deepEqual({ due: reminded.due, remindMinutes: reminded.remindMinutes }, { due: "2026-10-19", remindMinutes: 15 });
    assert.equal(padDueHasTime("2026-10-19"), false);
    assert.equal(padDueHasTime("2026-10-19T09:00"), true);
    assert.equal(padDueHasTime(null), false);
  });

  it("reads the AI fallback's date-only due and keeps the reminder it asks for", async () => {
    const answers = [
      { title: "Call Jane", due: "2026-10-19", remindMinutes: 15 },
      { title: "Call Jane", due: "2026-10-19T11:15", remindMinutes: 45 },
      { title: "Call Jane", due: null, remindMinutes: 15 },
      { title: "Call Jane", due: "next Monday", remindMinutes: null },
    ];
    const prompts: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      prompts.push(body.messages[0].content);
      const content = JSON.stringify(answers[prompts.length - 1]);
      return Response.json({ model: "test", choices: [{ message: { content }, finish_reason: "stop" }] });
    };
    const previous = process.env.LLM_API_KEY;
    process.env.LLM_API_KEY = "llm-test";
    try {
      assert.deepEqual(await parsePadWithAi("ring jane after the weekend, nudge me 15 mins before", FRIDAY_10AM, { fetchImpl }), {
        title: "Call Jane",
        due: "2026-10-19",
        remindMinutes: 15,
      });
      assert.deepEqual(await parsePadWithAi("ring jane monday 11.15, nudge me 45 mins before", FRIDAY_10AM, { fetchImpl }), {
        title: "Call Jane",
        due: "2026-10-19T11:15",
        remindMinutes: 30,
      });
      assert.deepEqual(await parsePadWithAi("ring jane, nudge me", FRIDAY_10AM, { fetchImpl }), { title: "Call Jane", due: null, remindMinutes: null });
      assert.deepEqual(await parsePadWithAi("ring jane next monday", FRIDAY_10AM, { fetchImpl }), { title: "Call Jane", due: null, remindMinutes: null });
    } finally {
      if (previous === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = previous;
    }
    assert.match(prompts[0], /the day alone as YYYY-MM-DD/);
    assert.doesNotMatch(prompts[0], /09:00/);
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
    assert.deepEqual({ title: invoice.title, due: invoice.due }, { title: "Invoice £12.50", due: "2026-10-23" });
    for (const [text, title] of [
      ["Pay $9.15", "Pay $9.15"],
      ["Refund € 7.45 tomorrow", "Refund € 7.45"],
      ["Charge GBP 12.50 tomorrow", "Charge GBP 12.50"],
      ["Charge 12.50 GBP tomorrow", "Charge 12.50 GBP"],
      ["Quote usd 3pm", "Quote usd 3pm"],
    ] as const) {
      const result = parse(text);
      assert.equal(result.title, title, text);
      assert.ok(!result.due || /^\d{4}-\d{2}-\d{2}$/.test(result.due), text);
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

  it("needs a stronger signal before reading numbers as dates or times, and asks the AI when unsure", () => {
    const monday = new Date("2026-11-16T10:30:00Z");
    const read = (text: string) => {
      const result = parseTaskText(text, monday);
      return { title: result.title, due: result.due, remindMinutes: result.remindMinutes, durationMinutes: result.durationMinutes, unsure: result.unsure };
    };
    const plain = (title: string, unsure = false) => ({ title, due: null, remindMinutes: null, durationMinutes: null, unsure });
    const at = (title: string, due: string, durationMinutes: number | null = null, unsure = false) => ({ title, due, remindMinutes: null, durationMinutes, unsure });
    assert.deepEqual(read("Review 24/7 support plan"), plain("Review 24/7 support plan"));
    assert.deepEqual(read("Read version 2.10 notes"), plain("Read version 2.10 notes"));
    assert.deepEqual(read("Call Sam 2.30"), plain("Call Sam 2.30", true));
    assert.deepEqual(read("Send 1/2 page summary"), plain("Send 1/2 page summary", true));
    assert.deepEqual(read("Call Sam sat 3pm"), at("Call Sam", "2026-11-21T15:00"));
    assert.deepEqual(read("Call Sam 3pm sat"), at("Call Sam", "2026-11-21T15:00"));
    assert.deepEqual(read("Call Sam on sat"), at("Call Sam", "2026-11-21"));
    assert.deepEqual(read("Call Sam next sun"), at("Call Sam", "2026-11-22"));
    assert.deepEqual(read("Call Sam weds"), at("Call Sam", "2026-11-18"));
    assert.deepEqual(read("I sat down with Sunil"), plain("I sat down with Sunil"));
    assert.deepEqual(read("Call Sam tomorrow 9"), at("Call Sam", "2026-11-17T09:00", null, true));
    assert.deepEqual(read("Call Sam tomorrow at 9"), at("Call Sam", "2026-11-17T09:00", null, true));
    assert.deepEqual(read("Call Sam 9 tomorrow"), at("Call Sam", "2026-11-17T09:00", null, true));
    assert.deepEqual(read("Call Sam at 9"), at("Call Sam", "2026-11-17T09:00", null, true));
    assert.deepEqual(read("Call Sam at 17"), at("Call Sam", "2026-11-16T17:00"));
    assert.deepEqual(read("Call Sam tomorrow 2.30"), at("Call Sam 2.30", "2026-11-17", null, true));
    assert.deepEqual(read("Call Sam 1:30"), plain("Call Sam 1:30", true));
    assert.deepEqual(read("Call Sam at 3 sat"), at("Call Sam at 3", "2026-11-21", null, true));
    assert.deepEqual(read("Meet at 10 Downing Street"), plain("Meet at 10 Downing Street"));
    assert.deepEqual(read("Call Sam 8am-6pm"), at("Call Sam", "2026-11-17T08:00"));
    assert.deepEqual(read("Call 020 7946 0-5pm"), plain("Call 020 7946 0-5pm", true));
    assert.deepEqual(read("Call Sam 3-4pm"), at("Call Sam", "2026-11-16T15:00", 60));
    assert.deepEqual(read("Call Sam 11-1pm"), at("Call Sam", "2026-11-16T11:00", 120));
    assert.deepEqual(read("Call Sam remind me 15 mins before"), plain("Call Sam remind me 15 mins before", true));
    assert.deepEqual(read("Follow up 22/11"), at("Follow up", "2026-11-22", null, true));
    assert.deepEqual(read("Follow up 3/4"), at("Follow up", "2027-04-03", null, true));
    assert.deepEqual(read("Follow up on 3/4"), at("Follow up", "2027-04-03"));
    assert.deepEqual(read("Call Sam on 3/4/27"), at("Call Sam", "2027-04-03"));
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

  it("works out the card's links from what was found and what was set by hand", () => {
    const acme = { id: "acme", name: "Acme" };
    const beta = { id: "beta", name: "Beta" };
    const jane = { id: "jane", name: "Jane Doe", company: acme };
    const rebuild = { id: "rebuild", name: "Website rebuild", companyId: "acme" };
    const unset = <T,>(): PadPick<T> => ({ set: false, value: undefined as T });
    const base = { fixedCompany: null, contact: unset<typeof jane | null>(), company: unset<typeof acme | null>(), opportunity: unset<typeof acme | null>(), dismissed: [] };
    const found = { company: null, contact: null, opportunity: null, ask: null };

    const deal = resolvePadLinks({ ...base, text: "Send Website rebuild proposal", found: { ...found, company: acme, opportunity: rebuild } });
    assert.deepEqual([deal.company?.id, deal.opportunity?.id], ["acme", "rebuild"], "an opportunity named alone brings its company");
    assert.deepEqual(padSaveIds(deal, base), { companyId: "acme", opportunityId: "rebuild" });

    const named = resolvePadLinks({ ...base, text: "Call Jane", found: { ...found, company: acme, contact: jane } });
    assert.equal(named.contact?.id, "jane");
    const unlinked = { ...base, contact: { set: true, value: null } };
    const dropped = resolvePadLinks({ ...unlinked, text: "Call Jane", found: { ...found, company: acme, contact: jane } });
    assert.deepEqual([dropped.contact, dropped.company], [null, null], "Don't link drops a company that only came from the person");
    assert.deepEqual(padSaveIds(dropped, unlinked), { contactId: null });
    const kept = resolvePadLinks({ ...unlinked, text: "Call Jane at Acme", found: { ...found, company: acme, contact: jane } });
    assert.equal(kept.company?.id, "acme", "a company named in the text stays");
    const viaDeal = resolvePadLinks({ ...unlinked, text: "Call Jane about Website rebuild", found: { company: acme, contact: jane, opportunity: rebuild, ask: null } });
    assert.deepEqual([viaDeal.company?.id, viaDeal.opportunity?.id], ["acme", "rebuild"], "a company from a named opportunity stays");

    const fixed = { ...base, fixedCompany: beta };
    const elsewhere = resolvePadLinks({ ...fixed, text: "Call Jane", found: { ...found, company: acme, contact: jane } });
    assert.deepEqual([elsewhere.contact, elsewhere.company?.id], [null, "beta"], "a person at another company never joins a fixed company");

    assert.deepEqual(padSaveIds(resolvePadLinks({ ...base, text: "Buy milk", found }), base), {}, "nothing found leaves the server rule to decide");
    assert.deepEqual(padSaveIds(null, base), {}, "a failed check sends nothing it found");
    assert.deepEqual(padSaveIds(null, fixed), { companyId: "beta" }, "a failed check still sends the fixed company");
    assert.deepEqual(padSaveIds(null, { ...base, contact: { set: true, value: jane } }), { contactId: "jane" });

    const bob = { id: "bob", name: "Bob Ray", company: beta };
    const handBob = { ...base, contact: { set: true, value: bob } };
    const retyped = resolvePadLinks({ ...handBob, text: "Call Acme", found: { ...found, company: acme } });
    assert.deepEqual([retyped.contact?.id, retyped.company?.id], ["bob", "beta"], "a hand-picked person keeps their company when the text names another");
    assert.deepEqual(padSaveIds(retyped, handBob), { companyId: "beta", contactId: "bob" });

    const side = { set: true, value: null, side: true };
    assert.deepEqual(padRelease(side), { set: false, value: undefined }, "a clear made by another pick is forgotten when the text changes");
    assert.deepEqual(padRelease({ set: true, value: null }), { set: true, value: null }, "a clear Mark made himself stays");
    const released = { ...base, contact: padRelease<typeof jane | null>(side) };
    assert.equal(resolvePadLinks({ ...released, text: "Call Jane Doe", found: { ...found, company: acme, contact: jane } }).contact?.id, "jane");
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
    const both = await detectPadRecords(owner, "Call Monday re Friday Media");
    assert.equal(both.company?.id, media);
  });

  it("links an opportunity named on its own, with its company", async () => {
    const found = await detectPadRecords(owner, "Send Halden pilot proposal");
    assert.equal(found.opportunity?.name, "Halden pilot");
    assert.equal(found.company?.id, halden);
  });
});
