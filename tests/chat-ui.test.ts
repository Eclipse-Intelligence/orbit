import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { dayLabel, shortWhen } from "@/lib/chat/format";
import { chatHistoryState, chatLocationHref, chatSegments, messageHref, parseChatLocation } from "@/lib/chat/routes";
import {
  appendCards,
  chatReducer,
  refreshCards,
  EMPTY_CHAT,
  lastOwnMessage,
  localMessage,
  sidebarBadge,
  sidebarRead,
  startsGroup,
  typingLine,
  upsertMessage,
  type ChatState,
} from "@/lib/chat/timeline";
import type { ChatMessage, ChatPage, ChatSidebar } from "@/lib/chat/types";
import { SHORTCUTS, sequenceShortcut } from "@/lib/shortcuts";

const ROOM = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const SAM = "33333333-3333-4333-8333-333333333333";

let sequence = 0;
function message(input: Partial<ChatMessage> & { at: string }): ChatMessage {
  sequence += 1;
  return {
    id: input.id ?? `aaaaaaaa-aaaa-4aaa-8aaa-${String(sequence).padStart(12, "0")}`,
    conversationId: ROOM,
    parentId: null,
    author: { id: SAM, name: "Sam Okafor" },
    clientKey: null,
    body: "Hello",
    mentions: [],
    replyCount: 0,
    lastReplyAt: null,
    replyAuthors: [],
    editedAt: null,
    deletedAt: null,
    createdAt: input.at,
    ...input,
  };
}

function page(messages: ChatMessage[], extra: Partial<ChatPage> = {}): ChatPage {
  return { messages, hasOlder: false, hasNewer: false, firstUnreadId: null, lastReadAt: "2026-11-11T09:00:00.000Z", ...extra };
}

function loaded(messages: ChatMessage[], extra: Partial<ChatPage> = {}): ChatState {
  return chatReducer(EMPTY_CHAT, { type: "page", conversationId: ROOM, page: page(messages, extra), mode: "replace" });
}

describe("chat routes", () => {
  it("reads rooms, threads and the home view from the path", () => {
    assert.deepEqual(chatSegments([]), { kind: "home" });
    assert.deepEqual(chatSegments(["threads"]), { kind: "threads" });
    assert.deepEqual(chatSegments([ROOM.toUpperCase()]), { kind: "room", id: ROOM });
    assert.equal(chatSegments(["nope"]), null);
    assert.equal(chatSegments([ROOM, "x"]), null);
  });

  it("keeps thread and message links and drops bad ids", () => {
    const thread = "44444444-4444-4444-8444-444444444444";
    assert.deepEqual(parseChatLocation(`/chat/${ROOM}`, `thread=${thread}`), { view: { kind: "room", id: ROOM }, thread, message: null });
    assert.deepEqual(parseChatLocation("/chat", `thread=${thread}`), { view: { kind: "home" }, thread: null, message: null });
    assert.deepEqual(parseChatLocation(`/chat/${ROOM}`, "message=bad"), { view: { kind: "room", id: ROOM }, thread: null, message: null });
    assert.equal(parseChatLocation("/mail"), null);
    assert.equal(chatLocationHref({ view: { kind: "threads" }, thread }), `/chat/threads?thread=${thread}`);
    assert.equal(chatLocationHref({ view: { kind: "home" }, thread }), "/chat");
    assert.equal(messageHref(ROOM, { id: thread, parentId: null }), `/chat/${ROOM}?message=${thread}`);
    assert.equal(messageHref(ROOM, { id: SAM, parentId: thread }), `/chat/${ROOM}?thread=${thread}`);
  });
});

describe("chat timeline", () => {
  it("replaces an optimistic message with the server copy without duplicating it", () => {
    const first = message({ at: "2026-11-11T09:00:00.000Z" });
    let state = loaded([first]);
    const local = localMessage({ clientKey: "key-1", conversationId: ROOM, parentId: null, author: { id: ME, name: "Mark" }, body: "Hi", mentions: [], at: "2026-11-11T09:05:00.000Z" });
    state = chatReducer(state, { type: "pending", message: local });
    assert.deepEqual(
      state.timelines[ROOM].messages.map((item) => item.id),
      [first.id, local.id],
    );
    const server = message({ at: "2026-11-11T09:04:59.000Z", author: { id: ME, name: "Mark" }, clientKey: "key-1", body: "Hi" });
    state = chatReducer(state, { type: "incoming", message: server, root: null });
    state = chatReducer(state, { type: "incoming", message: server, root: null });
    assert.deepEqual(
      state.timelines[ROOM].messages.map((item) => item.id),
      [first.id, server.id],
    );
  });

  it("keeps a failed send until it is retried and clears the failure when it lands", () => {
    const local = localMessage({ clientKey: "key-2", conversationId: ROOM, parentId: null, author: { id: ME, name: "Mark" }, body: "Hi", mentions: [], at: "2026-11-11T09:05:00.000Z" });
    let state = chatReducer(loaded([]), { type: "pending", message: local });
    state = chatReducer(state, { type: "failed", clientKey: "key-2", error: "Couldn't send. Try again." });
    assert.equal(state.failed["key-2"], "Couldn't send. Try again.");
    state = chatReducer(state, { type: "incoming", message: message({ at: "2026-11-11T09:05:01.000Z", clientKey: "key-2", author: { id: ME, name: "Mark" } }), root: null });
    assert.equal(state.failed["key-2"], undefined);
    assert.equal(state.timelines[ROOM].messages.length, 1);
  });

  it("keeps messages in order when older and newer pages arrive", () => {
    const a = message({ at: "2026-11-11T08:00:00.000Z" });
    const b = message({ at: "2026-11-11T09:00:00.000Z" });
    const c = message({ at: "2026-11-11T10:00:00.000Z" });
    let state = loaded([b], { hasOlder: true, hasNewer: true });
    state = chatReducer(state, { type: "page", conversationId: ROOM, page: page([a], { hasOlder: false, hasNewer: true }), mode: "older" });
    state = chatReducer(state, { type: "page", conversationId: ROOM, page: page([c], { hasOlder: true, hasNewer: false }), mode: "newer" });
    const timeline = state.timelines[ROOM];
    assert.deepEqual(
      timeline.messages.map((item) => item.id),
      [a.id, b.id, c.id],
    );
    assert.equal(timeline.hasOlder, false);
    assert.equal(timeline.hasNewer, false);
  });

  it("ignores live messages while a later page is still unloaded", () => {
    const state = loaded([message({ at: "2026-11-11T08:00:00.000Z" })], { hasNewer: true });
    const next = chatReducer(state, { type: "incoming", message: message({ at: "2026-11-11T11:00:00.000Z" }), root: null });
    assert.equal(next.timelines[ROOM].messages.length, 1);
  });

  it("updates the root's reply count when a reply arrives and keeps a deleted root with replies", () => {
    const root = message({ at: "2026-11-11T08:00:00.000Z" });
    let state = loaded([root]);
    const reply = message({ at: "2026-11-11T08:10:00.000Z", parentId: root.id });
    state = chatReducer(state, { type: "incoming", message: reply, root: { id: root.id, replyCount: 1, lastReplyAt: reply.createdAt, replyAuthors: [{ id: SAM, name: "Sam Okafor" }] } });
    assert.equal(state.timelines[ROOM].messages[0].replyCount, 1);
    state = chatReducer(state, { type: "deleted", conversationId: ROOM, messageId: root.id, parentId: null, root: null });
    assert.equal(state.timelines[ROOM].messages.length, 1);
    assert.ok(state.timelines[ROOM].messages[0].deletedAt);
    assert.equal(state.timelines[ROOM].messages[0].body, "");
    const lone = message({ at: "2026-11-11T09:00:00.000Z" });
    state = chatReducer(state, { type: "incoming", message: lone, root: null });
    state = chatReducer(state, { type: "deleted", conversationId: ROOM, messageId: lone.id, parentId: null, root: null });
    assert.equal(state.timelines[ROOM].messages.length, 1);
  });

  it("adds replies to an open thread and leaves other threads alone", () => {
    const root = message({ at: "2026-11-11T08:00:00.000Z", replyCount: 0 });
    let state = chatReducer(loaded([root]), {
      type: "thread",
      thread: { conversation: null as never, root, replies: [], hasOlder: false, hasNewer: false, following: true, lastReadAt: null },
      mode: "replace",
    });
    const reply = message({ at: "2026-11-11T08:10:00.000Z", parentId: root.id });
    state = chatReducer(state, { type: "incoming", message: reply, root: { id: root.id, replyCount: 1, lastReplyAt: reply.createdAt, replyAuthors: [] } });
    assert.deepEqual(
      state.threads[root.id].timeline.messages.map((item) => item.id),
      [reply.id],
    );
    assert.equal(state.threads[root.id].root?.replyCount, 1);
  });

  it("groups messages from one person within five minutes", () => {
    const a = message({ at: "2026-11-11T09:00:00.000Z" });
    const b = message({ at: "2026-11-11T09:04:00.000Z" });
    const c = message({ at: "2026-11-11T09:20:00.000Z" });
    assert.equal(startsGroup(null, a, false), true);
    assert.equal(startsGroup(a, b, true), false);
    assert.equal(startsGroup(b, c, true), true);
    assert.equal(startsGroup(a, { ...b, author: { id: ME, name: "Mark" } }, true), true);
    assert.equal(startsGroup(a, b, false), true);
  });

  it("finds your last message for Up arrow editing", () => {
    const mine = message({ at: "2026-11-11T09:00:00.000Z", author: { id: ME, name: "Mark" } });
    const theirs = message({ at: "2026-11-11T09:01:00.000Z" });
    assert.equal(lastOwnMessage([mine, theirs], ME)?.id, mine.id);
    assert.equal(lastOwnMessage([theirs], ME), null);
  });

  it("upserts by id in time order", () => {
    const a = message({ at: "2026-11-11T09:00:00.000Z" });
    const b = message({ at: "2026-11-11T09:01:00.000Z" });
    assert.deepEqual(
      upsertMessage([b], a).map((item) => item.id),
      [a.id, b.id],
    );
  });

  it("words typing for one, two and more people", () => {
    assert.equal(typingLine([]), "");
    assert.equal(typingLine(["Sam"]), "Sam is typing…");
    assert.equal(typingLine(["Sam", "Priya"]), "Sam and Priya are typing…");
    assert.equal(typingLine(["Sam", "Priya", "John"]), "Several people are typing…");
  });
});

describe("chat sidebar badge", () => {
  const sidebar: ChatSidebar = {
    conversations: [
      { id: ROOM, kind: "room", name: "sales", workspaceId: null, workspaceName: null, dmUser: null, createdAt: "", lastMessageAt: null, lastReadAt: "", unread: 3, mentions: 1 },
      { id: SAM, kind: "dm", name: "Sam", workspaceId: null, workspaceName: null, dmUser: { id: SAM, name: "Sam" }, createdAt: "", lastMessageAt: null, lastReadAt: "", unread: 0, mentions: 0 },
    ],
    threads: { unread: 0, mentions: 0 },
    unreadConversations: 1,
    mentioned: true,
  };

  it("counts unread conversations and turns purple for mentions", () => {
    assert.deepEqual(sidebarBadge(sidebar), { count: 1, mentioned: true });
    assert.deepEqual(sidebarBadge(null), { count: 0, mentioned: false });
  });

  it("clears a conversation when it is read", () => {
    const read = sidebarRead(sidebar, ROOM);
    assert.equal(read.unreadConversations, 0);
    assert.equal(read.mentioned, false);
    assert.deepEqual(sidebarBadge(read), { count: 0, mentioned: false });
    assert.equal(sidebarRead(read, ROOM), read);
  });

  it("falls back to unread threads when no conversation is unread", () => {
    assert.deepEqual(sidebarBadge({ ...sidebar, conversations: [], unreadConversations: 0, threads: { unread: 2, mentions: 1 }, mentioned: true }), { count: 2, mentioned: true });
  });
});

describe("chat dates and shortcuts", () => {
  it("labels days and times in London time", () => {
    const now = Date.parse("2026-11-11T12:00:00.000Z");
    assert.equal(dayLabel("2026-11-11T08:00:00.000Z", now), "Today");
    assert.equal(dayLabel("2026-11-10T08:00:00.000Z", now), "Yesterday");
    assert.equal(dayLabel("2026-11-09T08:00:00.000Z", now), "Monday");
    assert.equal(dayLabel("2026-10-01T08:00:00.000Z", now), "1 October");
    assert.equal(dayLabel("2025-10-01T08:00:00.000Z", now), "1 October 2025");
    assert.equal(shortWhen("2026-11-11T08:05:00.000Z", now), "08:05");
    assert.equal(shortWhen("2026-11-10T08:05:00.000Z", now), "Yesterday");
  });

  it("opens Chat with G then H and lists its keys", () => {
    assert.equal(sequenceShortcut("g", "h")?.href, "/chat");
    assert.equal(sequenceShortcut("g", "c")?.href, "/contacts");
    const ids = SHORTCUTS.filter((shortcut) => shortcut.group === "Chat").map((shortcut) => shortcut.id);
    for (const id of ["chat-edit-last", "chat-reply", "chat-close-thread", "chat-prev", "chat-next", "chat-new-room", "chat-room-settings"]) assert.ok(ids.includes(id), id);
    assert.equal(sequenceShortcut("c", "h")?.id, "chat-new-message");
  });
});

describe("chat review fixes", () => {
  const mine = (key: string, at: string) => localMessage({ clientKey: key, conversationId: ROOM, parentId: null, author: { id: ME, name: "Mark" }, body: "Hi", mentions: [], at });

  it("swaps a message sent while the room loads and asks for newer messages after", () => {
    let state = chatReducer(EMPTY_CHAT, { type: "loading", conversationId: ROOM });
    state = chatReducer(state, { type: "pending", message: mine("load-1", "2026-11-11T09:05:00.000Z") });
    const echo = message({ at: "2026-11-11T09:05:00.100Z", author: { id: ME, name: "Mark" }, clientKey: "load-1" });
    state = chatReducer(state, { type: "incoming", message: echo, root: null });
    assert.deepEqual(
      state.timelines[ROOM].messages.map((item) => item.id),
      [echo.id],
    );

    const other = message({ at: "2026-11-11T09:06:00.000Z" });
    let loading = chatReducer(chatReducer(EMPTY_CHAT, { type: "loading", conversationId: ROOM }), { type: "pending", message: mine("load-2", "2026-11-11T09:07:00.000Z") });
    loading = chatReducer(loading, { type: "incoming", message: other, root: null });
    const landed = message({ at: "2026-11-11T09:07:00.100Z", author: { id: ME, name: "Mark" }, clientKey: "load-2" });
    loading = chatReducer(loading, { type: "page", conversationId: ROOM, page: page([landed]), mode: "replace" });
    assert.deepEqual(
      loading.timelines[ROOM].messages.map((item) => item.id),
      [landed.id],
    );
    assert.equal(loading.timelines[ROOM].stale, true);
    loading = chatReducer(loading, { type: "page", conversationId: ROOM, page: page([other]), mode: "newer" });
    assert.equal(loading.timelines[ROOM].stale, false);
    assert.equal(loading.timelines[ROOM].messages.length, 2);
  });

  it("keeps your copy until the latest page loads when later messages are still unloaded", () => {
    let state = loaded([message({ at: "2026-11-11T08:00:00.000Z" })], { hasNewer: true });
    const local = mine("gap-1", "2026-11-11T09:00:00.000Z");
    state = chatReducer(state, { type: "pending", message: local });
    const echo = message({ at: "2026-11-11T09:00:00.100Z", author: { id: ME, name: "Mark" }, clientKey: "gap-1" });
    state = chatReducer(state, { type: "incoming", message: echo, root: null });
    assert.ok(state.timelines[ROOM].messages.some((item) => item.id === local.id));
    assert.ok(!state.timelines[ROOM].messages.some((item) => item.id === echo.id));
    assert.equal(state.timelines[ROOM].stale, true);
  });

  it("keeps a reply sent from a Threads card so its failure can show", () => {
    const root = "55555555-5555-4555-8555-555555555555";
    const reply = localMessage({ clientKey: "card-1", conversationId: ROOM, parentId: root, author: { id: ME, name: "Mark" }, body: "Hi", mentions: [], at: "2026-11-11T09:00:00.000Z" });
    let state = chatReducer(EMPTY_CHAT, { type: "pending", message: reply });
    assert.deepEqual(
      state.threads[root].timeline.messages.map((item) => item.id),
      [reply.id],
    );
    state = chatReducer(state, { type: "failed", clientKey: "card-1", error: "Couldn't send. Try again." });
    assert.equal(state.failed["card-1"], "Couldn't send. Try again.");
  });

  it("never marks a delivered message as failed", () => {
    let state = chatReducer(loaded([]), { type: "pending", message: mine("done-1", "2026-11-11T09:00:00.000Z") });
    state = chatReducer(state, { type: "incoming", message: message({ at: "2026-11-11T09:00:01.000Z", author: { id: ME, name: "Mark" }, clientKey: "done-1" }), root: null });
    state = chatReducer(state, { type: "failed", clientKey: "done-1", error: "Couldn't send. Try again." });
    assert.equal(state.failed["done-1"], undefined);
  });

  it("clears the New divider once the room is read or newer pages load", () => {
    const unread = message({ at: "2026-11-11T09:30:00.000Z" });
    let state = loaded([unread], { firstUnreadId: unread.id });
    assert.equal(state.timelines[ROOM].firstUnreadId, unread.id);
    state = chatReducer(state, { type: "read", conversationId: ROOM, lastReadAt: "2026-11-11T09:31:00.000Z" });
    assert.equal(state.timelines[ROOM].firstUnreadId, null);
    let paged = loaded([unread], { firstUnreadId: unread.id });
    paged = chatReducer(paged, { type: "page", conversationId: ROOM, page: page([message({ at: "2026-11-11T09:40:00.000Z" })], { firstUnreadId: unread.id }), mode: "newer" });
    assert.equal(paged.timelines[ROOM].firstUnreadId, null);
  });

  it("ignores a stale reply count that arrives after a newer one", () => {
    const root = message({ at: "2026-11-11T08:00:00.000Z" });
    let state = loaded([root]);
    const late = { id: root.id, replyCount: 2, lastReplyAt: "2026-11-11T08:20:00.000Z", replyAuthors: [] };
    state = chatReducer(state, { type: "incoming", message: message({ at: "2026-11-11T08:20:00.000Z", parentId: root.id }), root: late });
    state = chatReducer(state, { type: "incoming", message: message({ at: "2026-11-11T08:10:00.000Z", parentId: root.id }), root: { ...late, replyCount: 1, lastReplyAt: "2026-11-11T08:10:00.000Z" } });
    assert.equal(state.timelines[ROOM].messages[0].replyCount, 2);
  });

  it("keeps Next's history markers out of Chat's history state and survives bad paths", () => {
    assert.deepEqual(chatHistoryState(true), { chatPushed: true });
    assert.equal(parseChatLocation("/chat/%E0%A4%A"), null);
    for (const file of readdirSync("components/chat")) {
      assert.doesNotMatch(readFileSync(`components/chat/${file}`, "utf8"), /\.\.\.\s*(window\.)?history\.state|\.\.\.current,\s*chatPushed/, file);
    }
  });

  it("merges refreshed thread cards without dropping later pages", () => {
    const card = (id: string, unread: number) => ({ conversation: { id: ROOM, kind: "room" as const, name: "sales" }, root: message({ id, at: "2026-11-11T08:00:00.000Z" }), latest: [], earlier: 0, unread, mentions: 0, lastReadAt: "" });
    const a = card("aaaaaaaa-aaaa-4aaa-8aaa-00000000000a", 0);
    const b = card("aaaaaaaa-aaaa-4aaa-8aaa-00000000000b", 0);
    const c = card("aaaaaaaa-aaaa-4aaa-8aaa-00000000000c", 0);
    assert.deepEqual(
      refreshCards([a, b, c], [{ ...c, unread: 1 }, a]).map((item) => [item.root.id, item.unread]),
      [
        [c.root.id, 1],
        [a.root.id, 0],
        [b.root.id, 0],
      ],
    );
    assert.deepEqual(
      appendCards([a], [a, b]).map((item) => item.root.id),
      [a.root.id, b.root.id],
    );
  });
});
