import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discussionHref } from "@/lib/chat/discussions";
import { messageHref } from "@/lib/chat/routes";
import {
  CHAT_LINK_LABEL,
  DISCUSSION_LINK_LABELS,
  orbitLink,
  orbitPath,
  plainTaskText,
  TASK_TITLE_MAX,
  taskTitleFrom,
  taskTitleFromMessage,
} from "@/lib/chat/task-text";
import { descriptionParts, descriptionPreview, hasOrbitLink, partsSourceOffset, showsDescriptionLinks } from "@/lib/task-doc-picks";

const MEMBER = "0b6a0b52-4b0a-4f6f-9d2a-6a0e1d2c3b4a";
const RECORD = "5c0f6a52-4b0a-4f6f-9d2a-6a0e1d2c3b4b";
const ROOM = "11111111-2222-4333-8444-555555555555";
const MESSAGE = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const ROOT = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

describe("the task text made from a chat message", () => {
  it("shows mention tokens as names and strips Markdown markers", () => {
    const body = `**Please** send @[Sam Lee](member:${MEMBER}) the _renewal_ for @[Initech](company:${RECORD}) by ~~Friday~~ Monday.`;
    assert.equal(plainTaskText(body, "markdown"), "Please send Sam Lee the renewal for Initech by Friday Monday.");
    assert.equal(plainTaskText(`Ask @[Sam Lee](member:${MEMBER}) about it`, "plain"), "Ask Sam Lee about it");
  });

  it("keeps the words of links, code, quotes, lists and code blocks on one line", () => {
    const body = ["> Quoted line", "", "See [the plan](https://plan.test/a) and `npm test` or https://bare.test/x.", "", "- first", "- second", "", "```", "const a = 1;", "const b = 2;", "```"].join("\n");
    assert.equal(plainTaskText(body, "markdown"), "Quoted line See the plan and npm test or https://bare.test/x. first second const a = 1; const b = 2;");
  });

  it("leaves plain messages as typed, apart from whitespace", () => {
    assert.equal(plainTaskText("  *not bold*\n\n  two   lines ", "plain"), "*not bold* two lines");
  });

  it("names a mention inside code too, never the raw token", () => {
    assert.equal(plainTaskText(`\`@[Sam Lee](member:${MEMBER})\``, "markdown"), "Sam Lee");
  });

  it("keeps a title that fits and cuts a longer one on a word, within the task title limit", () => {
    assert.equal(taskTitleFrom("Short title"), "Short title");
    const exact = "a".repeat(TASK_TITLE_MAX);
    assert.equal(taskTitleFrom(exact), exact);
    const long = `${"word ".repeat(80)}end`;
    const cut = taskTitleFrom(long);
    assert.ok(cut.length <= TASK_TITLE_MAX, String(cut.length));
    assert.ok(cut.endsWith("word…"), cut.slice(-12));
    const unbroken = taskTitleFrom("b".repeat(500));
    assert.equal(unbroken.length, TASK_TITLE_MAX);
    assert.ok(unbroken.endsWith("…"));
  });

  it("never leaves half an emoji at the cut", () => {
    const cut = taskTitleFrom(`${"c".repeat(TASK_TITLE_MAX - 2)}😀😀😀`);
    assert.ok(cut.length <= TASK_TITLE_MAX);
    assert.doesNotMatch(cut, /[\ud800-\udbff]…$/);
    assert.doesNotMatch(cut, /[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("falls back to a webhook card's title when the message has no text", () => {
    const message = { body: "", format: "markdown" as const, hook: { title: "Deploy   failed", url: null, block: true } };
    assert.equal(taskTitleFromMessage(message), "Deploy failed");
    assert.equal(taskTitleFromMessage({ body: "Text wins", format: "plain", hook: message.hook }), "Text wins");
    assert.equal(taskTitleFromMessage({ body: "", format: "plain", hook: null }), "");
  });
});

describe("an Orbit link in a task description", () => {
  it("only accepts a path inside Orbit", () => {
    for (const path of [`/chat/${ROOM}?message=${MESSAGE}`, "/tasks?task=x", "/"]) assert.equal(orbitPath(path), true, path);
    for (const path of ["//evil.test/x", "https://evil.test", "javascript:alert(1)", "/a b", "/a(b)", "/a\\b", "", "chat/x", `/${"x".repeat(501)}`]) {
      assert.equal(orbitPath(path), false, path);
    }
    assert.throws(() => orbitLink("Bad", "//evil.test"), /inside Orbit/);
  });

  it("builds the link a message's task carries, for a room message, a thread and every discussion", () => {
    const message = orbitLink(CHAT_LINK_LABEL, messageHref(ROOM, { id: MESSAGE, parentId: null }));
    assert.equal(message, `[Message in Chat](/chat/${ROOM}?message=${MESSAGE})`);
    const reply = orbitLink(CHAT_LINK_LABEL, messageHref(ROOM, { id: MESSAGE, parentId: ROOT }));
    assert.equal(reply, `[Message in Chat](/chat/${ROOM}?thread=${ROOT}&message=${MESSAGE})`);
    assert.equal(hasOrbitLink(reply), true);
    assert.deepEqual(descriptionParts(reply, []).map((part) => part.kind), descriptionParts(message, []).map((part) => part.kind));
    for (const kind of ["task", "doc", "mail_thread"] as const) {
      const text = orbitLink(DISCUSSION_LINK_LABELS[kind], discussionHref({ kind, id: RECORD }));
      assert.equal(hasOrbitLink(text), true, kind);
    }
  });

  it("cleans a label that would break the link", () => {
    assert.equal(orbitLink("A [odd]\n(label)", "/chat"), "[A odd label](/chat)");
    assert.equal(orbitLink("[]", "/chat"), "[Link](/chat)");
  });

  it("is read back as a link, in order with doc references, and never for another site", () => {
    const text = `Chase this.\n[Message in Chat](/chat/${ROOM}?message=${MESSAGE})\nAlso [[Plan]] and [site](https://evil.test) and [ugly](//evil.test/x).`;
    const parts = descriptionParts(text, [{ id: "doc-1", title: "Plan", readable: true }]);
    assert.deepEqual(
      parts.map((part) => part.kind),
      ["text", "link", "text", "doc", "text"],
    );
    const link = parts[1];
    assert.equal(link.kind === "link" && link.href, `/chat/${ROOM}?message=${MESSAGE}`);
    assert.equal(link.kind === "link" && link.label, "Message in Chat");
    assert.equal(parts.map((part) => (part.kind === "text" ? part.text : "")).join("").includes("[site](https://evil.test)"), true);
    assert.equal(parts.map((part) => (part.kind === "text" ? part.text : "")).join("").includes("[ugly](//evil.test/x)"), true);
    assert.equal(hasOrbitLink("[site](https://evil.test)"), false);
    assert.equal(hasOrbitLink("[a](/ok)"), true);
  });

  it("shows the read view on rows and in the panel, until it is edited", () => {
    const text = `[Message in Chat](/chat/${ROOM})`;
    assert.equal(showsDescriptionLinks(text, "row", false), true);
    assert.equal(showsDescriptionLinks(text, "panel", false), true);
    assert.equal(showsDescriptionLinks(text, "panel", true), false);
  });

  it("shows the label of an Orbit link in a row's first line, and leaves other text alone", () => {
    assert.equal(descriptionPreview(`[Message in Chat](/chat/${ROOM}?message=${MESSAGE})\nMore`), "Message in Chat");
    assert.equal(descriptionPreview("Chase [Message in Chat](/chat/x) today\nMore"), "Chase Message in Chat today");
    assert.equal(descriptionPreview("[site](https://evil.test) and [[Plan]]"), "[site](https://evil.test) and [[Plan]]");
    assert.equal(descriptionPreview(null), "");
  });

  it("maps a click on the link back to the text", () => {
    const text = "Chase [Message in Chat](/chat/x) today";
    const parts = descriptionParts(text, []);
    assert.equal(partsSourceOffset(text, parts, 3), 3);
    assert.equal(partsSourceOffset(text, parts, 6), 6, "the start of a link is before it");
    assert.equal(partsSourceOffset(text, parts, 10), 11, "inside the link lands inside its label");
    assert.equal(partsSourceOffset(text, parts, 6 + "Message in Chat".length), text.indexOf(")") + 1, "the end of a link is after it");
    assert.equal(partsSourceOffset(text, parts, 999), text.length);
  });
});
