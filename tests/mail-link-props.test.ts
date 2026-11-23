import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { linkMatchesUrl, listFromUrl } from "@/lib/mail/link-props";
import { acceptedHello, frameToken, frameTokenComment, portIsStale } from "@/lib/mail/frame-keys";
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
  const token = "0123456789abcdef0123456789abcdef";
  const other = "fedcba9876543210fedcba9876543210";
  const doc = frameDocument('<p>Hi</p><a href="https://x.test">x</a>', true, true, "n0nce", token);

  it("hands a port to a hello with the document's own token", () => {
    assert.equal(acceptedHello({ type: "hello", token, id: "a1" }, doc, null), "a1");
  });

  it("refuses a hello with a wrong token, no token or no document", () => {
    assert.equal(acceptedHello({ type: "hello", token: other, id: "a1" }, doc, null), null);
    assert.equal(acceptedHello({ type: "hello", id: "a1" }, doc, null), null);
    assert.equal(acceptedHello({ type: "hello", token: "", id: "a1" }, doc, null), null);
    assert.equal(acceptedHello({ type: "hello", token, id: "a1" }, null, null), null);
    assert.equal(acceptedHello({ type: "hello", token, id: "a1" }, "<p>no comment</p>", null), null);
    assert.equal(acceptedHello({ type: "key", token, id: "a1" }, doc, null), null);
    assert.equal(acceptedHello({ type: "hello", token, id: 4 }, doc, null), null);
    assert.equal(acceptedHello(null, doc, null), null);
    assert.equal(acceptedHello("hello", doc, null), null);
  });

  it("refuses a hello carrying the previous document's token after the srcdoc changed", () => {
    const next = frameDocument("<p>Changed</p>", true, true, "n0nce", other);
    assert.equal(acceptedHello({ type: "hello", token, id: "a1" }, next, null), null);
    assert.equal(acceptedHello({ type: "hello", token: other, id: "b1" }, next, null), "b1");
  });

  it("answers a document once, and a reloaded copy of it again", () => {
    assert.equal(acceptedHello({ type: "hello", token, id: "a1" }, doc, "a1"), null);
    assert.equal(acceptedHello({ type: "hello", token, id: "a2" }, doc, "a1"), "a2");
  });

  it("keeps a port made for the current document and drops one made for an earlier document", () => {
    const next = frameDocument("<p>Changed</p>", true, true, "n0nce", other);
    assert.equal(portIsStale(doc, token), false);
    assert.equal(portIsStale(next, token), true);
    assert.equal(portIsStale(next, other), false);
    assert.equal(portIsStale(next, null), true);
    assert.equal(portIsStale(null, token), true);
  });

  it("keeps the port a new document got before the reset ran", () => {
    const next = frameDocument("<p>Changed</p>", true, true, "n0nce", other);
    assert.equal(portIsStale(next, token), true);
    const id = acceptedHello({ type: "hello", token: other, id: "b1" }, next, "a1");
    assert.equal(id, "b1");
    assert.equal(portIsStale(next, frameToken(next)), false);
  });

  it("reads the token from the start of the document and nowhere else", () => {
    const planted = `<!doctype html><html><head></head><body>${frameTokenComment(other)}<meta name="orbit-frame" content="${other}">orbit-frame:${other}</body></html>`;
    assert.equal(frameToken(doc), token);
    assert.equal(frameToken(planted), null);
    assert.equal(frameToken(`${frameTokenComment(other)}${doc}`), null);
    assert.equal(frameToken(frameDocument(`<!--orbit-frame:${other}-->`, true, true, "n0nce", token)), token);
    assert.equal(frameToken(null), null);
  });

  it("keeps the token out of every attribute and removes the script that holds it", () => {
    const tags = [...doc.matchAll(/<[a-z][^>]*>/gi)].map((match) => match[0]).filter((tag) => !tag.startsWith("<script"));
    for (const tag of tags) assert.equal(tag.includes(token), false, tag);
    assert.equal(doc.startsWith(`<!doctype html><!--orbit-frame:${token}-->`), true);
    assert.equal(doc.includes("document.currentScript"), true);
    assert.equal(doc.includes("removeChild(holder)"), true);
    assert.equal(doc.split(token).length - 1, 2);
  });
});
