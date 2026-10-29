import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NoteTitle } from "@/lib/docs/client-types";
import { linkMatches } from "@/lib/docs/editor/link-matches";

function note(id: string, title: string, shared = false, folderName: string | null = null): NoteTitle {
  return { id, title, shared, folderName };
}

const RECENT_FIRST = [
  note("n1", "Q4 pricing review", true, "Partnerships"),
  note("n2", "Pricing", false, "Clients"),
  note("n3", "Acme pricing notes", true),
  note("n4", "Price list 2027"),
  note("n5", "Pricing sheet", true, "Ideas"),
  note("n6", "Weekly sync"),
];

describe("local link matches", () => {
  it("puts title prefixes first, then other matches, each most recently edited first", () => {
    assert.deepEqual(linkMatches(RECENT_FIRST, "pric", null).map((match) => match.id), ["n2", "n4", "n5", "n1", "n3"]);
  });

  it("matches case-insensitively anywhere in the title", () => {
    assert.deepEqual(linkMatches(RECENT_FIRST, "PRICING N", null).map((match) => match.title), ["Acme pricing notes"]);
    assert.deepEqual(linkMatches(RECENT_FIRST, "  weekly   sync ", null).map((match) => match.id), ["n6"]);
  });

  it("leaves out the current note", () => {
    assert.deepEqual(linkMatches(RECENT_FIRST, "pricing", "n2").map((match) => match.id), ["n5", "n1", "n3"]);
  });

  it("returns at most six, and the most recent notes for an empty query", () => {
    const many = Array.from({ length: 10 }, (_, index) => note(`m${index}`, `Plan ${index}`));
    assert.equal(linkMatches(many, "plan", null).length, 6);
    assert.deepEqual(linkMatches(RECENT_FIRST, "", "n1").map((match) => match.id), ["n2", "n3", "n4", "n5", "n6"]);
    assert.equal(linkMatches(RECENT_FIRST, "pr", null, 2).length, 2);
  });

  it("keeps sharing and folder so rows can warn and show where a note lives", () => {
    const [match] = linkMatches(RECENT_FIRST, "q4", null);
    assert.deepEqual(match, { id: "n1", title: "Q4 pricing review", shared: true, folderName: "Partnerships" });
  });

  it("finds nothing when no title contains the query", () => {
    assert.deepEqual(linkMatches(RECENT_FIRST, "renewal", null), []);
  });
});
