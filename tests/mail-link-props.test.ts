import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { linkMatchesUrl, listFromUrl } from "@/lib/mail/link-props";
import { acceptFrameMessage } from "@/lib/mail/frame-keys";

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

describe("messages from the email frame", () => {
  it("only accepts messages carrying the frame's own token", () => {
    assert.ok(acceptFrameMessage({ type: "key", key: "#", token: "abc" }, "abc"));
    assert.equal(acceptFrameMessage({ type: "key", key: "#" }, "abc"), null);
    assert.equal(acceptFrameMessage({ type: "key", key: "#", token: "other" }, "abc"), null);
    assert.equal(acceptFrameMessage({ type: "height", value: 10, token: "" }, ""), null);
    assert.equal(acceptFrameMessage(null, "abc"), null);
    assert.equal(acceptFrameMessage("abc", "abc"), null);
  });
});
