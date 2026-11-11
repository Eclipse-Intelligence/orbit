import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dayLabel, shortWhen } from "@/lib/chat/format";
import { chatLocationHref, chatSegments, messageHref, parseChatLocation } from "@/lib/chat/routes";
import {
  chatReducer,
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
    for (const id of ["chat-edit-last", "chat-reply", "chat-close-thread", "chat-prev", "chat-next"]) assert.ok(ids.includes(id), id);
  });
});
