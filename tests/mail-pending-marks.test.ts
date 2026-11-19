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
