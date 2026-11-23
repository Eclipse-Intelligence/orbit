import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { linkMatchesUrl, listFromUrl } from "@/lib/mail/link-props";
import { createFrameGuard } from "@/lib/mail/frame-guard";
import { frameDocument } from "@/lib/mail/frame-document";

const inbox = { view: "inbox", account: null, query: "" };

describe("links into Mail", () => {
  it("reads the list from the address the way the page does", () => {
    assert.deepEqual(listFromUrl(new URLSearchParams("")), inbox);
    assert.deepEqual(listFromUrl(new URLSearchParams("view=inbox:important")), { view: "inbox:important", account: null, query: "" });
    assert.deepEqual(listFromUrl(new URLSearchParams("view=scheduled")), { view: "scheduled", account: null, query: "" });
    assert.deepEqual(listFromUrl(new URLSearchParams("q=pricing&view=sent&account=a1")), { view: "sent", account: "a1", query: "pricing" });
    assert.deepEqual(listFromUrl(new URLSearchParams("view=nonsense")), inbox);
  });

  it("accepts props that match the address", () => {
    assert.equal(linkMatchesUrl(new URLSearchParams("thread=x%7Cy"), { thread: "x|y", query: inbox }), true);
    assert.equal(linkMatchesUrl(new URLSearchParams("view=sent"), { thread: null, query: { view: "sent", account: null, query: "" } }), true);
  });

  it("ignores props the address has moved past", () => {
    assert.equal(linkMatchesUrl(new URLSearchParams("thread=newer"), { thread: "older", query: inbox }), false);
    assert.equal(linkMatchesUrl(new URLSearchParams(""), { thread: "older", query: inbox }), false);
    assert.equal(linkMatchesUrl(new URLSearchParams("view=sent"), { thread: null, query: inbox }), false);
    assert.equal(linkMatchesUrl(new URLSearchParams("q=a"), { thread: null, query: inbox }), false);
  });
});

describe("the email frame", () => {
  it("connects the first hello of each srcdoc and ignores the rest", () => {
    const guard = createFrameGuard();
    guard.fresh();
    assert.equal(guard.hello(false), true);
    assert.equal(guard.hello(false), false);
    assert.equal(guard.hello(true), false);
    guard.fresh();
    assert.equal(guard.hello(false), true);
  });

  it("treats a second load of the same srcdoc as a navigation and restores it", () => {
    const guard = createFrameGuard();
    guard.fresh();
    assert.equal(guard.hello(false), true);
    assert.equal(guard.load(), "first");
    assert.equal(guard.load(), "restore");
    assert.equal(guard.load(), "first");
    assert.equal(guard.hello(false), true);
  });

  it("does not hand a port to the navigated page that is still in the frame while it is restored", () => {
    const guard = createFrameGuard();
    guard.fresh();
    assert.equal(guard.hello(false), true);
    assert.equal(guard.load(), "first");
    assert.equal(guard.load(), "restore");
    assert.equal(guard.hello(true), false);
    assert.equal(guard.hello(false), false);
    assert.equal(guard.load(), "first");
    assert.equal(guard.hello(true), true);
    assert.equal(guard.load(), "restore");
    assert.equal(guard.hello(false), false);
  });

  it("counts a load that happened before the page was hydrated", () => {
    const guard = createFrameGuard();
    guard.fresh();
    assert.equal(guard.hello(true), true);
    assert.equal(guard.load(), "restore");
  });

  it("does not count the same load twice when hello says it was already complete", () => {
    const guard = createFrameGuard();
    guard.fresh();
    assert.equal(guard.load(), "first");
    assert.equal(guard.hello(true), true);
    assert.equal(guard.load(), "restore");
  });

  it("does not misfire when the email changes", () => {
    const guard = createFrameGuard();
    guard.fresh();
    guard.hello(false);
    assert.equal(guard.load(), "first");
    guard.fresh();
    assert.equal(guard.hello(false), true);
    assert.equal(guard.load(), "first");
  });

  it("stops restoring an email that keeps navigating away", () => {
    const guard = createFrameGuard(2);
    guard.fresh();
    guard.hello(false);
    assert.equal(guard.load(), "first");
    assert.equal(guard.load(), "restore");
    assert.equal(guard.load(), "first");
    assert.equal(guard.load(), "restore");
    assert.equal(guard.load(), "first");
    assert.equal(guard.load(), "blocked");
    guard.fresh();
    assert.equal(guard.load(), "first");
  });

  it("keeps any secret out of the frame document", () => {
    const doc = frameDocument('<p style="color:red">Hi</p><a href="https://x.test">x</a>', true, true, "n0nce");
    assert.equal(/token|orbit-frame/i.test(doc), false);
    assert.equal(doc.includes("MessageChannel") || doc.includes("event.ports"), true);
    assert.equal(doc.indexOf("<!--"), -1);
  });
});
