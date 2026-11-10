import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keepLeaving } from "@/components/mail/leaving";
import { lockAxis, resisted, startsAtEdge, startsInEditable, swipeCommit, velocityOf } from "@/components/mail/swipe";
import type { ThreadSummary } from "@/lib/mail/view";

describe("mail swipes", () => {
  it("decides the direction on the first movement, favouring sideways for thumb arcs", () => {
    assert.equal(lockAxis(0, 0), null);
    assert.equal(lockAxis(-3, 1), "x");
    assert.equal(lockAxis(-3, 3.5), "x");
    assert.equal(lockAxis(-1, 3), "y");
    assert.equal(lockAxis(0, 2), "y");
  });

  it("measures speed from recent movement, even when moves arrive merged", () => {
    const samples = [
      { x: 250, y: 500, at: 0 },
      { x: 205, y: 500, at: 90 },
    ];
    assert.equal(velocityOf(samples), -0.5);
    const steady = [0, 16, 32, 48, 64, 80].map((at, index) => ({ x: 300 - index * 10, y: 500, at }));
    assert.equal(velocityOf(steady), -0.625);
    assert.equal(velocityOf([{ x: 1, y: 1, at: 0 }]), 0);
  });

  it("commits on distance or a flick, only towards an email that exists, and resists at the ends", () => {
    assert.equal(swipeCommit(-130, -0.1, 390, { left: true, right: true }), "left");
    assert.equal(swipeCommit(-45, -0.5, 390, { left: true, right: true }), "left");
    assert.equal(swipeCommit(-45, 0.5, 390, { left: true, right: true }), null);
    assert.equal(swipeCommit(-20, -2, 390, { left: true, right: true }), null);
    assert.equal(swipeCommit(200, 1, 390, { left: true, right: false }), null);
    assert.equal(resisted(-100, true), -100);
    assert.equal(resisted(-100, false), -12);
    assert.equal(resisted(1000, false), 48);
  });

  it("leaves touches that start in a text field or the composer to the browser", () => {
    const element = (editable: boolean) => ({ nodeType: 1, closest: () => (editable ? {} : null) });
    const text = (parent: unknown) => ({ nodeType: 3, parentElement: parent });
    assert.equal(startsInEditable(element(true) as unknown as EventTarget), true);
    assert.equal(startsInEditable(text(element(true)) as unknown as EventTarget), true);
    assert.equal(startsInEditable(element(false) as unknown as EventTarget), false);
    assert.equal(startsInEditable(text(null) as unknown as EventTarget), false);
    assert.equal(startsInEditable(null), false);
  });

  it("keeps back gestures to the left edge so the reader's sideways swipes still move between emails", () => {
    assert.equal(startsAtEdge(0), true);
    assert.equal(startsAtEdge(24), true);
    assert.equal(startsAtEdge(25), false);
    assert.equal(startsAtEdge(200), false);
  });

  it("keeps removed rows in place while they animate away, and drops them on a reload", () => {
    const thread = (key: string) => ({ key }) as ThreadSummary;
    const shown = (keys: string[]) => keys.map((key) => ({ thread: thread(key), leaving: false }));
    const layout = (rows: { thread: ThreadSummary; leaving: boolean }[]) => rows.map((row) => `${row.thread.key}${row.leaving ? "-" : ""}`).join(" ");
    assert.equal(layout(keepLeaving(shown(["a", "b", "c", "d"]), [thread("a"), thread("d")])), "a b- c- d");
    assert.equal(layout(keepLeaving(shown(["a", "b", "c"]), [thread("b"), thread("c")])), "a- b c");
    assert.equal(layout(keepLeaving(shown(["a", "b", "c"]), [thread("n"), thread("a"), thread("c")])), "n a b- c");
    assert.equal(layout(keepLeaving([{ thread: thread("a"), leaving: true }, ...shown(["b"])], [thread("a"), thread("b")])), "a b");
  });
});
