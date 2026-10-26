import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lockAxis, resisted, swipeCommit, velocityOf } from "@/components/mail/swipe";

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
});
