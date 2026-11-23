import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPendingMarks } from "@/components/mail/pending-marks";
import type { ThreadSummary } from "@/lib/mail/view";

function thread(key: string, unread: boolean, flagged = false) {
  return { key, unread, flagged } as ThreadSummary;
}

describe("pending mail marks", () => {
  it("keeps a read that is still saving when a reload brings the older unread copy", () => {
    const marks = createPendingMarks();
    const read = marks.hold("a", "read");
    const [kept, other] = marks.keep([thread("a", true), thread("b", true)]);
    assert.equal(kept.unread, false);
    assert.equal(other.unread, true);
    read.saved();
    assert.equal(marks.keep([thread("a", true)])[0].unread, true);
  });

  it("keeps a read for a list fetched before it saved, even when the list arrives after", () => {
    const marks = createPendingMarks();
    const read = marks.hold("a", "read");
    const stale = marks.reading();
    read.saved();
    assert.equal(marks.keep([thread("a", true)], stale.startedAt)[0].unread, false);
    const fresh = marks.reading();
    assert.equal(marks.keep([thread("a", true)], fresh.startedAt)[0].unread, true);
    stale.done();
    fresh.done();
    assert.equal(marks.keep([thread("a", true)], 0)[0].unread, true);
  });

  it("drops a change that failed so a reload shows the server copy", () => {
    const marks = createPendingMarks();
    const read = marks.hold("a", "read");
    const stale = marks.reading();
    read.failed();
    assert.equal(marks.keep([thread("a", true)], stale.startedAt)[0].unread, true);
  });

  it("applies changes still saving in the order they were made", () => {
    const marks = createPendingMarks();
    const first = marks.hold("a", "read");
    marks.hold("a", "unread");
    marks.hold("a", "flag");
    first.saved();
    const [kept] = marks.keep([thread("a", false)]);
    assert.equal(kept.unread, true);
    assert.equal(kept.flagged, true);
  });

  it("returns the same list when nothing is saving", () => {
    const marks = createPendingMarks();
    const list = [thread("a", true)];
    assert.equal(marks.keep(list), list);
  });
});

describe("pending mail moves", () => {
  it("keeps a moved thread out of a list read that started before the move was saved", () => {
    const marks = createPendingMarks();
    const stale = marks.reading();
    const moved = marks.hide("a");
    assert.deepEqual(marks.keep([thread("a", true), thread("b", true)], stale.startedAt).map((item) => item.key), ["b"]);
    moved.saved();
    assert.deepEqual(marks.keep([thread("a", true), thread("b", true)], stale.startedAt).map((item) => item.key), ["b"]);
    const fresh = marks.reading();
    assert.deepEqual(marks.keep([thread("a", true), thread("b", true)], fresh.startedAt).map((item) => item.key), ["a", "b"]);
    stale.done();
    fresh.done();
    assert.deepEqual(marks.keep([thread("a", true)]).map((item) => item.key), ["a"]);
  });

  it("shows the thread again when the move fails or is undone", () => {
    const marks = createPendingMarks();
    const moved = marks.hide("a");
    assert.equal(marks.keep([thread("a", true)]).length, 0);
    moved.failed();
    assert.equal(marks.keep([thread("a", true)]).length, 1);
  });

  it("still applies marks to the threads that stay", () => {
    const marks = createPendingMarks();
    marks.hide("a");
    const read = marks.hold("b", "read");
    const [kept] = marks.keep([thread("a", true), thread("b", true)]);
    assert.equal(kept.key, "b");
    assert.equal(kept.unread, false);
    read.failed();
  });
});
