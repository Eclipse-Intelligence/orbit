import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SIGNATURE_HEIGHT_MAX, SIGNATURE_WIDTH_MAX, signatureCanvasSize, signatureScale } from "@/lib/proposals/signature-canvas";
import { teamKeys, withTeamKey, withoutTeamKey } from "@/lib/proposals/team-keys";

describe("team person keys", () => {
  it("gives each person a key before any are stored", () => {
    assert.deepEqual(teamKeys(undefined, 3, "b1"), ["b1-p0", "b1-p1", "b1-p2"]);
  });

  it("keeps a person's key when someone above them is removed", () => {
    const before = teamKeys(undefined, 3, "b1");
    const after = withoutTeamKey(undefined, 3, "b1", 0);
    assert.deepEqual(after, ["b1-p1", "b1-p2"]);
    assert.equal(after.indexOf(before[2]), 1);
    assert.equal(after.indexOf(before[0]), -1);
  });

  it("adds a new key without reusing a removed one", () => {
    const removed = withoutTeamKey(undefined, 3, "b1", 1);
    const added = withTeamKey(removed, 2, "b1", "b1-new");
    assert.deepEqual(added, ["b1-p0", "b1-p2", "b1-new"]);
    assert.equal(new Set(added).size, added.length);
  });

  it("fills people added elsewhere with keys that don't clash", () => {
    const keys = teamKeys(["b1-p1", "b1-p2"], 3, "b1");
    assert.equal(new Set(keys).size, 3);
  });
});

describe("signature canvas size", () => {
  it("uses the full pixel ratio when it fits", () => {
    assert.deepEqual(signatureCanvasSize(600, 144, 2), { scale: 2, width: 1200, height: 288 });
  });

  it("caps a wide pad on a Retina screen to the size Orbit accepts", () => {
    const size = signatureCanvasSize(1400, 144, 3);
    assert.ok(size.width <= SIGNATURE_WIDTH_MAX);
    assert.ok(size.height <= SIGNATURE_HEIGHT_MAX);
    assert.ok(Math.abs(size.width / 1400 - size.height / 144) < 0.01);
  });

  it("keeps pointer mapping proportional", () => {
    const scale = signatureScale(5000, 144, 2);
    assert.ok(scale < 2 && scale > 0);
    assert.equal(Math.round(5000 * scale), SIGNATURE_WIDTH_MAX);
  });

  it("falls back to a ratio of 1 and ignores empty pads", () => {
    assert.equal(signatureScale(300, 100, Number.NaN), 1);
    assert.deepEqual(signatureCanvasSize(0, 144, 2), { scale: 0, width: 0, height: 0 });
  });
});
