import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { minimalChange } from "@/lib/mail/body-editor";
import { draftStateLine } from "@/lib/mail/share-view";
import { newerVersion, reconcileText, textChanges } from "@/lib/mail/shared-text";

describe("shared draft text", () => {
  it("takes the server's value for each field the person hasn't changed", () => {
    const base = { subject: "Pricing", body: "Hi Tom" };
    const fresh = { subject: "Pricing v2", body: "Hi Tom, from Sam" };
    assert.deepEqual(reconcileText(base, base, fresh), fresh);
    assert.deepEqual(reconcileText(base, { subject: "Pricing", body: "Hi Tom, mine" }, fresh), { subject: "Pricing v2", body: "Hi Tom, mine" });
    assert.deepEqual(reconcileText(base, { subject: "Mine", body: "Hi Tom" }, fresh), { subject: "Mine", body: "Hi Tom, from Sam" });
  });

  it("sends only the fields that changed", () => {
    const base = { subject: "Pricing", body: "Hi" };
    assert.equal(textChanges(base, base), null);
    assert.deepEqual(textChanges(base, { subject: "Pricing ", body: "Hi" }), { subject: "Pricing ", body: null });
    assert.deepEqual(textChanges(base, { subject: "Pricing", body: "Hello" }), { subject: null, body: "Hello" });
  });

  it("drops answers older than one already seen", () => {
    assert.equal(newerVersion(null, 0), true);
    assert.equal(newerVersion(4, 4), true);
    assert.equal(newerVersion(4, 3), false);
  });

  it("changes only the part of the message that differs, so the cursor stays put", () => {
    assert.deepEqual(minimalChange("Hi Tom, thanks", "Hi Tom, many thanks"), { from: 8, to: 8, insert: "many " });
    assert.deepEqual(minimalChange("abc", "abc"), { from: 3, to: 3, insert: "" });
    assert.deepEqual(minimalChange("aaa", "aa"), { from: 2, to: 3, insert: "" });
    assert.deepEqual(minimalChange("", "new"), { from: 0, to: 0, insert: "new" });
  });

  it("names each read only state", () => {
    const owner = { name: "Mark Ridgeon" };
    assert.equal(draftStateLine("failed", owner, null), "Couldn't send. Read only until Mark unschedules it.");
    assert.equal(draftStateLine("scheduled", owner, "Fri 09:00"), "Scheduled for Fri 09:00. Read only until Mark unschedules it.");
    assert.equal(draftStateLine("sending", owner, null), "Mark is sending. Read only.");
    assert.equal(draftStateLine("editing", owner, null), null);
  });
});
