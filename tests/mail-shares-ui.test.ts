import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SHORTCUT_BY_ID, comboMatches } from "@/lib/shortcuts";
import type { SharedThreadSummary } from "@/lib/mail/share-types";
import {
  SHARE_REACH,
  NO_ACCESS,
  addPeopleQuestion,
  candidateDetail,
  joinNames,
  listForThread,
  mailUrl,
  peopleLine,
  personFirstName,
  readShareParam,
  removedLine,
  sharedByLabel,
  sharedCountLabel,
  sharedListPerson,
  sortShared,
  stepShare,
} from "@/lib/mail/share-view";

const MARK = "11111111-1111-4111-8111-111111111111";
const SAM = "22222222-2222-4222-8222-222222222222";
const PRIYA = "33333333-3333-4333-8333-333333333333";

function summary(shareId: string, latestAt: string | null, sharedAt = "2026-11-01T09:00:00.000Z"): SharedThreadSummary {
  return {
    shareId,
    owner: { id: MARK, name: "Mark Ridgeon" },
    sharedAt,
    subject: "Re: Revised pricing",
    snippet: "Thanks Mark",
    latestAt,
    counterpart: { name: "Tom Becker", address: "tom@haldengroup.com" },
    count: 4,
    hasAttachments: true,
  };
}

describe("shared thread copy", () => {
  it("names the owner by first name", () => {
    assert.equal(sharedByLabel({ name: "Mark Ridgeon" }), "Shared by Mark");
    assert.equal(removedLine({ name: "Mark Ridgeon" }), "Mark removed you from this thread.");
    assert.equal(personFirstName("  "), "Someone");
  });

  it("lists the people in a thread with the viewer last as you", () => {
    const people = [
      { id: MARK, name: "Mark Ridgeon" },
      { id: PRIYA, name: "Priya Nair" },
      { id: SAM, name: "Sam Okafor" },
    ];
    assert.equal(peopleLine(people, SAM), "Mark, Priya and you");
    assert.equal(peopleLine(people.slice(0, 2), SAM), "Mark and Priya");
    assert.equal(peopleLine([people[0], people[2]], SAM), "Mark and you");
    assert.equal(joinNames([]), "");
  });

  it("asks before adding someone tagged in a note", () => {
    assert.equal(addPeopleQuestion([{ name: "Sam Okafor" }]), "Add Sam to this thread?");
    assert.equal(addPeopleQuestion([{ name: "Sam Okafor" }, { name: "John Hale" }]), "Add Sam and John to this thread?");
  });

  it("keeps the reach line and counts terse, with no dashes", () => {
    assert.equal(SHARE_REACH, "They see this thread, its attachments and notes. Nothing else in your mailbox. Only you can send.");
    assert.equal(sharedCountLabel(1), "1 shared thread");
    assert.equal(sharedCountLabel(3), "3 shared threads");
    for (const line of [SHARE_REACH, sharedByLabel({ name: "Mark" }), removedLine({ name: "Mark" })]) assert.doesNotMatch(line, /[–—]/);
  });
});

describe("shared list", () => {
  it("sorts newest first, falling back to when it was shared", () => {
    const sorted = sortShared([
      summary("a", "2026-11-02T10:00:00.000Z"),
      summary("b", null, "2026-11-05T10:00:00.000Z"),
      summary("c", "2026-11-04T10:00:00.000Z"),
    ]);
    assert.deepEqual(
      sorted.map((thread) => thread.shareId),
      ["b", "c", "a"],
    );
  });

  it("steps with J and K and stays inside the list", () => {
    const list = [summary("a", null), summary("b", null), summary("c", null)];
    assert.equal(stepShare(list, null, 1), "a");
    assert.equal(stepShare(list, null, -1), "c");
    assert.equal(stepShare(list, "a", 1), "b");
    assert.equal(stepShare(list, "c", 1), "c");
    assert.equal(stepShare(list, "a", -1), "a");
    assert.equal(stepShare(list, "gone", 1), "a");
    assert.equal(stepShare([], null, 1), null);
  });

  it("shows the other party, or the owner when there is none", () => {
    assert.equal(sharedListPerson(summary("a", null)), "Tom Becker");
    assert.equal(sharedListPerson({ ...summary("a", null), counterpart: { name: null, address: "tom@haldengroup.com" } }), "tom@haldengroup.com");
    assert.equal(sharedListPerson({ ...summary("a", null), counterpart: null }), "Mark Ridgeon");
  });

  it("only accepts a share id from a link", () => {
    assert.equal(readShareParam(MARK.toUpperCase()), MARK);
    assert.equal(readShareParam("not-a-share"), null);
    assert.equal(readShareParam(null), null);
  });
});

describe("share shortcut", () => {
  it("shares with Shift S without taking plain S from Flag", () => {
    const share = SHORTCUT_BY_ID.get("mail-share")!;
    const flag = SHORTCUT_BY_ID.get("mail-flag")!;
    const shiftS = { key: "S", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true };
    const plainS = { key: "s", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
    assert.equal(share.group, "Mail");
    assert.ok(share.combos!.some((combo) => comboMatches(combo, shiftS, true)));
    assert.ok(!share.combos!.some((combo) => comboMatches(combo, plainS, true)));
    assert.ok(!flag.combos!.some((combo) => comboMatches(combo, shiftS, true)));
  });
});

describe("mail links and the Ask path", () => {
  const shared = { view: "shared", account: null, query: "" };
  const inbox = { view: "inbox", account: null, query: "" };

  it("writes a share id as shared= in the Shared tab and a thread as thread= elsewhere", () => {
    assert.equal(mailUrl(shared, MARK), `/mail?view=shared&shared=${MARK}`);
    assert.equal(mailUrl(shared, null), "/mail?view=shared");
    assert.equal(mailUrl({ ...shared, account: SAM }, MARK), `/mail?view=shared&account=${SAM}&shared=${MARK}`);
    assert.equal(mailUrl(inbox, "source|conv"), "/mail?thread=source%7Cconv");
    assert.equal(mailUrl({ view: "shared", account: null, query: "pricing" }, "source|conv"), "/mail?q=pricing&thread=source%7Cconv");
  });

  it("leaves the Shared tab before opening one of your own threads, from Ask or a push", () => {
    assert.deepEqual(listForThread(shared), inbox);
    assert.deepEqual(listForThread({ ...shared, account: SAM }), { ...inbox, account: SAM });
    assert.equal(listForThread(inbox), null);
    assert.equal(listForThread({ view: "shared", account: null, query: "pricing" }), null);
  });

  it("describes people to add by their role here, or their address when they aren't in this workspace", () => {
    assert.equal(candidateDetail({ role: "admin", email: "sam@eclipse.test" }), "Admin");
    assert.equal(candidateDetail({ role: null, email: "sam@eclipse.test" }), "sam@eclipse.test");
    assert.equal(NO_ACCESS, "You no longer have access to this thread.");
  });
});
