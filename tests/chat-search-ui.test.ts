import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chatJumps, jumpLabel } from "@/lib/chat/jump";
import { chatLocationHref, chatSegments, messageHref, parseChatLocation, sameView } from "@/lib/chat/routes";
import { EMPTY_SEARCH, readSearchQuery, searchExcerpt, searchFilterCount, searchLength, searchParts, searchReady, writeSearchQuery } from "@/lib/chat/search";
import type { ChatConversation, ChatSidebar } from "@/lib/chat/types";
import { matchingShortcuts, SHORTCUTS } from "@/lib/shortcuts";

const ROOM = "11111111-1111-4111-8111-111111111111";
const PERSON = "22222222-2222-4222-8222-222222222222";

function conversation(input: Partial<ChatConversation> & { id: string; name: string }): ChatConversation {
  return {
    kind: "room",
    workspaceId: null,
    workspaceName: null,
    dmUser: null,
    people: [],
    topic: null,
    archivedAt: null,
    createdAt: "",
    lastMessageAt: null,
    lastReadAt: "",
    unread: 0,
    mentions: 0,
    notify: "default",
    muteMentions: false,
    starred: false,
    ...input,
  };
}

describe("search text", () => {
  it("counts characters people see, and needs three", () => {
    assert.equal(searchLength("  ab "), 2);
    assert.equal(searchLength("🙂🙂🙂"), 3);
    assert.equal(searchReady("ab"), false);
    assert.equal(searchReady(" abc "), true);
    assert.equal(searchReady("a b"), true);
  });

  it("shows the text around the first match, without the markup", () => {
    assert.equal(searchExcerpt("Short *message* here", "plain", "message"), "Short *message* here");
    assert.equal(searchExcerpt("Short **message** with [a link](https://x.test)", "markdown", "link"), "Short message with a link");
    assert.equal(searchExcerpt("It is _not_ in the *Growth* plan, snake_case stays, 2 * 3 * 4", "markdown", "plan"), "It is not in the Growth plan, snake_case stays, 2 * 3 * 4");
    assert.equal(searchExcerpt("Ask @[Sam Okafor](member:33333333-3333-4333-8333-333333333333) now", "markdown", "ask"), "Ask @Sam Okafor now");
    const long = `${"before ".repeat(40)}needle${" after".repeat(40)}`;
    const excerpt = searchExcerpt(long, "plain", "NEEDLE");
    assert.ok(excerpt.startsWith("…") && excerpt.endsWith("…") && excerpt.includes("needle"));
    assert.ok(excerpt.length <= 205);
    const emoji = `${"😀".repeat(70)} needle ${"😀".repeat(70)}`;
    const cut = searchExcerpt(emoji, "plain", "needle");
    assert.doesNotMatch(cut, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    for (const lead of [59, 60, 61, 62]) {
      const shifted = searchExcerpt(`${"😀".repeat(lead / 2)}${lead % 2 ? "x" : ""}needle${"😀".repeat(150)}`, "plain", "needle");
      assert.doesNotMatch(shifted, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/, String(lead));
    }
    assert.equal(readSearchQuery(new URLSearchParams(`q=${"😀".repeat(150)}`)).q, "😀".repeat(150));
    assert.equal(Array.from(readSearchQuery(new URLSearchParams(`q=${"😀".repeat(300)}`)).q).length, 200);
    const early = searchExcerpt(`needle${" after".repeat(60)}`, "plain", "needle");
    assert.ok(!early.startsWith("…") && early.endsWith("…"));
  });

  it("splits text around every match, ignoring case and treating the search as plain text", () => {
    assert.deepEqual(searchParts("Renewal due, renewal sent", "renewal"), [
      { text: "Renewal", match: true },
      { text: " due, ", match: false },
      { text: "renewal", match: true },
      { text: " sent", match: false },
    ]);
    assert.deepEqual(searchParts("Cost is (100%) [x]", "(100%) [x]"), [
      { text: "Cost is ", match: false },
      { text: "(100%) [x]", match: true },
    ]);
    assert.deepEqual(searchParts("Nothing here", "zzz"), [{ text: "Nothing here", match: false }]);
    assert.deepEqual(searchParts("Anything", "  "), [{ text: "Anything", match: false }]);
  });
});

describe("search in the address", () => {
  it("round trips the text and every filter, and drops what it can't read", () => {
    const query = { q: "sso plan", in: ROOM, from: PERSON, file: true, after: "2026-11-01", before: "2026-11-20" };
    const params = writeSearchQuery(query);
    assert.deepEqual(readSearchQuery(params), query);
    assert.equal(searchFilterCount(query), 5);
    assert.equal(searchFilterCount({ ...EMPTY_SEARCH, q: "plan" }), 0);
    const broken = readSearchQuery(new URLSearchParams("q=plan&in=nope&from=1&file=yes&after=2026-13-45&before=tomorrow"));
    assert.deepEqual(broken, { ...EMPTY_SEARCH, q: "plan" });
    assert.equal(readSearchQuery(new URLSearchParams(`q=${"x".repeat(500)}`)).q.length, 200);
  });

  it("carries a reply's id with its thread so the thread can highlight it", () => {
    const reply = { id: PERSON, parentId: ROOM };
    assert.equal(messageHref(ROOM, reply), `/chat/${ROOM}?thread=${ROOM}&message=${PERSON}`);
    assert.deepEqual(parseChatLocation(`/chat/${ROOM}`, `?thread=${ROOM}&message=${PERSON}`), { view: { kind: "room", id: ROOM }, thread: ROOM, message: PERSON });
    assert.equal(chatLocationHref({ view: { kind: "room", id: ROOM }, thread: ROOM, message: PERSON }), `/chat/${ROOM}?thread=${ROOM}&message=${PERSON}`);
    assert.equal(chatLocationHref({ view: { kind: "room", id: ROOM }, thread: null, message: PERSON }), `/chat/${ROOM}?message=${PERSON}`);
    assert.deepEqual(parseChatLocation("/chat/threads", `?message=${PERSON}`), { view: { kind: "threads" }, thread: null, message: null });
  });

  it("routes the results page and never carries a thread or message with it", () => {
    assert.deepEqual(chatSegments(["search"]), { kind: "search", query: EMPTY_SEARCH });
    const view = { kind: "search" as const, query: { ...EMPTY_SEARCH, q: "sso", in: ROOM } };
    assert.equal(chatLocationHref({ view, thread: ROOM, message: ROOM }), `/chat/search?q=sso&in=${ROOM}`);
    assert.deepEqual(parseChatLocation("/chat/search", `?q=sso&in=${ROOM}&thread=${ROOM}&message=${ROOM}`), { view, thread: null, message: null });
    assert.deepEqual(parseChatLocation("/chat/search", ""), { view: { kind: "search", query: EMPTY_SEARCH }, thread: null, message: null });
    assert.equal(sameView(view, { kind: "search", query: EMPTY_SEARCH }), true);
    assert.equal(sameView(view, { kind: "room", id: ROOM }), false);
    assert.equal(chatSegments(["searching"]), null);
  });
});

describe("jump to a conversation", () => {
  const sidebar: ChatSidebar = {
    conversations: [
      conversation({ id: "a1", name: "sales", lastMessageAt: "2026-11-10T09:00:00.000Z" }),
      conversation({ id: "a2", name: "sales-ops", unread: 2, lastMessageAt: "2026-11-09T09:00:00.000Z" }),
      conversation({ id: "a3", name: "Sam Okafor", kind: "dm", unread: 1, mentions: 0, lastMessageAt: "2026-11-11T09:00:00.000Z" }),
      conversation({ id: "a4", name: "general", unread: 4, mentions: 1, lastMessageAt: "2026-11-08T09:00:00.000Z" }),
      conversation({ id: "a5", name: "Priya Nair", kind: "dm", lastMessageAt: "2026-11-11T10:00:00.000Z", workspaceName: null }),
      conversation({ id: "a6", name: "launch", workspaceName: "Ridgeon", lastMessageAt: "2026-11-01T09:00:00.000Z" }),
    ],
    archived: [{ id: "z1", name: "sales-2024", workspaceName: "Ridgeon" }],
    threads: { unread: 0, mentions: 0 },
    unreadConversations: 3,
    scheduled: 0,
    mentioned: true,
  };

  it("lists only the unread conversations before anything is typed, mentions first and then the newest", () => {
    assert.deepEqual(chatJumps(sidebar, "", true).map((item) => item.id), ["a4", "a3", "a2"]);
    assert.deepEqual(chatJumps(sidebar, "   ", true).map((item) => item.id), ["a4", "a3", "a2"]);
    assert.deepEqual(chatJumps(null, "sales", true), []);
  });

  it("matches names and workspaces, with unread first and then the newest, archived rooms last", () => {
    assert.deepEqual(chatJumps(sidebar, "sales", true).map((item) => item.id), ["a2", "a1", "z1"]);
    assert.deepEqual(chatJumps(sidebar, "#sales ops", true).map((item) => item.id), ["a2"]);
    assert.deepEqual(chatJumps(sidebar, "ridgeon", true).map((item) => item.id), ["a6", "z1"]);
    assert.equal(chatJumps(sidebar, "sales-2024", true)[0].workspaceName, "Ridgeon");
    assert.deepEqual(chatJumps(sidebar, "SAM", true).map((item) => item.id), ["a3"]);
    assert.deepEqual(chatJumps(sidebar, "nothing like it", true), []);
    assert.equal(chatJumps(sidebar, "sales", true).find((item) => item.id === "z1")?.archived, true);
  });

  it("matches a workspace name only when the person is in more than one workspace", () => {
    assert.deepEqual(chatJumps(sidebar, "ridgeon", false), []);
    assert.deepEqual(chatJumps(sidebar, "launch ridgeon", false), []);
    assert.deepEqual(chatJumps(sidebar, "launch", false).map((item) => item.id), ["a6"]);
    assert.deepEqual(chatJumps(sidebar, "ridgeon", true).map((item) => item.id), ["a6", "z1"]);
  });

  it("caps the list and labels rooms and direct messages", () => {
    const many: ChatSidebar = { ...sidebar, archived: [], conversations: Array.from({ length: 20 }, (_, index) => conversation({ id: `r${index}`, name: `room ${index}` })) };
    assert.equal(chatJumps(many, "room", true).length, 8);
    assert.equal(jumpLabel({ kind: "room", name: "sales" }), "#sales");
    assert.equal(jumpLabel({ kind: "dm", name: "Sam Okafor" }), "Sam Okafor");
  });
});

describe("search shortcuts", () => {
  const press = (key: string, shift = false) => matchingShortcuts({ key, metaKey: true, ctrlKey: false, altKey: false, shiftKey: shift }, true).map((shortcut) => shortcut.id);

  it("tries Chat search before Docs search on Command Shift F, and finds in a room with Command F", () => {
    assert.deepEqual(press("f", true), ["chat-search", "docs-search"]);
    assert.deepEqual(press("F", true), ["chat-search", "docs-search"]);
    assert.deepEqual(press("f"), ["chat-find"]);
    for (const id of ["chat-search", "chat-find"]) assert.ok(SHORTCUTS.some((shortcut) => shortcut.id === id && shortcut.whileTyping), id);
  });
});
