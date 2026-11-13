"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import Button from "@/components/_ui/button";
import SectionHeader from "@/components/crm/section-header";
import type { Viewer } from "@/components/crm/viewer";
import { useShortcut } from "@/components/shortcuts/shortcuts-provider";
import { ChatContext, type ChatContextValue, type ChatEditing, type ChatWorkspace } from "@/components/chat/chat-context";
import { NewMessageDialog, NewRoomDialog } from "@/components/chat/chat-dialogs";
import ChatList, { listViews } from "@/components/chat/chat-list";
import { useChatEvents, useChatJoined } from "@/components/chat/chat-live";
import RoomSettings from "@/components/chat/room-settings";
import RoomView from "@/components/chat/room-view";
import ThreadPanel from "@/components/chat/thread-panel";
import ThreadsView from "@/components/chat/threads-view";
import { memberIds, messageBody, useChatActions } from "@/components/chat/use-chat-actions";
import { PHONE_LAYER, useKeyboardFit } from "@/components/chat/use-keyboard-fit";
import { clearDrafts, newClientKey } from "@/lib/chat/client";
import { chatHistoryState, chatLocationHref, messageHref, parseChatLocation, sameView, type ChatLocation, type ChatView } from "@/lib/chat/routes";
import { chatReducer, EMPTY_CHAT, loadsLatestFirst, localMessage, needsCatchUp, newestServerId, type ChatState } from "@/lib/chat/timeline";
import type { ChatConversation, ChatMessage, ChatPage, ChatRoom, ChatSidebar, ChatThread, ChatThreads } from "@/lib/chat/types";
import type { Mention } from "@/lib/mentions";
import { cn } from "@/lib/utils";
import { useCompaniesStore } from "@/stores/companies-store";
import ComposeIcon from "@/public/assets/images/mail/compose.svg";
import ChatIcon from "@/public/assets/images/chat/chat.svg";

export type Loaded<T> = T | { error: string } | null;

export type ChatInitial = {
  location: ChatLocation;
  sidebar: ChatSidebar | null;
  room: Loaded<ChatRoom>;
  page: Loaded<ChatPage>;
  thread: Loaded<ChatThread>;
  threads: Loaded<ChatThreads>;
};

const TICK_MS = 60_000;
const FOCUS_GAP_MS = 5_000;
const NOTICE_MS = 6_000;
const NEW_PARAM = "new";

function ok<T extends object>(value: Loaded<T>): value is T {
  return value !== null && !("error" in value);
}

function seeded(state: ChatState, initial: ChatInitial): ChatState {
  let next = state;
  const view = initial.location.view;
  if (view.kind === "room") {
    if (ok(initial.room)) next = chatReducer(next, { type: "room", room: initial.room });
    else if (initial.room) next = chatReducer(next, { type: "room-error", conversationId: view.id, error: initial.room.error });
    if (ok(initial.page)) next = chatReducer(next, { type: "page", conversationId: view.id, page: initial.page, mode: "replace" });
    else if (initial.page && !(initial.room && !ok(initial.room))) next = chatReducer(next, { type: "page-error", conversationId: view.id, error: initial.page.error });
  }
  if (initial.location.thread) {
    if (ok(initial.thread)) next = chatReducer(next, { type: "thread", thread: initial.thread, mode: "replace" });
    else if (initial.thread) next = chatReducer(next, { type: "thread-error", rootId: initial.location.thread, error: initial.thread.error });
  }
  return next;
}

function servedIds(initial: ChatInitial) {
  const ids = new Set<string>();
  if (initial.location.view.kind === "room" && ok(initial.room) && ok(initial.page)) ids.add(`room:${initial.location.view.id}`);
  if (initial.location.thread && ok(initial.thread)) ids.add(`thread:${initial.location.thread}`);
  return ids;
}

function parentOf(location: ChatLocation): ChatLocation {
  if (location.thread) return { view: location.view, thread: null, message: null };
  return { view: { kind: "home" }, thread: null, message: null };
}

function composerHasText() {
  const active = document.activeElement;
  return active instanceof HTMLTextAreaElement && active.value.length > 0;
}

export default function ChatScreen({ viewer, workspaces, initial, now: initialNow }: { viewer: Viewer; workspaces: ChatWorkspace[]; initial: ChatInitial; now: number }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const location = useMemo(() => parseChatLocation(pathname, search) ?? initial.location, [pathname, search, initial.location]);
  const [state, dispatch] = useReducer(chatReducer, initial, (seed) => seeded(EMPTY_CHAT, seed));
  const [served, setServed] = useState(initial);
  const fresh = useRef(servedIds(initial));
  const [threadsSeed, setThreadsSeed] = useState(initial.threads);
  if (served !== initial) {
    setServed(initial);
    setThreadsSeed(initial.threads);
    if (ok(initial.room)) dispatch({ type: "room", room: initial.room });
    if (ok(initial.page) && initial.location.view.kind === "room") dispatch({ type: "page", conversationId: initial.location.view.id, page: initial.page, mode: "replace" });
    if (ok(initial.thread)) dispatch({ type: "thread", thread: initial.thread, mode: "replace" });
  }
  if (location.view.kind !== "threads" && threadsSeed !== null) setThreadsSeed(null);
  const storeChat = useCompaniesStore((store) => store.chat);
  const sidebar = storeChat ?? initial.sidebar;
  const joined = useChatJoined();
  const [notice, setNotice] = useState<string | null>(null);
  const actions = useChatActions(dispatch, state, viewer.id, setNotice);
  const [editing, setEditing] = useState<ChatEditing>(null);
  const [now, setNow] = useState(initialNow);
  const [newRoom, setNewRoom] = useState(false);
  const [newMessage, setNewMessage] = useState(false);
  const [settings, setSettings] = useState<{ open: boolean; adding: boolean }>({ open: false, adding: false });
  const [slide, setSlide] = useState<"room" | "thread" | null>(null);
  const [bottomSignal, setBottomSignal] = useState(0);
  const [threadBottomSignal, setThreadBottomSignal] = useState(0);
  const opener = useRef<HTMLElement | null>(null);
  const pane = useRef<HTMLDivElement>(null);
  const threadPane = useRef<HTMLDivElement>(null);
  const latest = useRef({ state, location, sidebar });
  useLayoutEffect(() => {
    latest.current = { state, location, sidebar };
  });
  const me = useMemo(() => ({ id: viewer.id, name: viewer.name }), [viewer.id, viewer.name]);
  const multi = workspaces.length > 1;
  const view = location.view;
  const roomId = view.kind === "room" ? view.id : null;
  const threadId = location.thread;
  const detail = view.kind !== "home";

  useKeyboardFit(pane, detail && !threadId);
  useKeyboardFit(threadPane, Boolean(threadId));

  useEffect(() => {
    if (!useCompaniesStore.getState().chat && initial.sidebar) useCompaniesStore.getState().setChat(initial.sidebar);
  }, [initial.sidebar]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const go = useCallback((next: ChatLocation, options: { replace?: boolean } = {}) => {
    const href = chatLocationHref(next);
    if (`${window.location.pathname}${window.location.search}` === href) return;
    if (options.replace) {
      const current = window.history.state as Record<string, unknown> | null;
      setSlide(null);
      window.history.replaceState(chatHistoryState(current?.chatPushed === true), "", href);
      return;
    }
    setSlide(next.thread ? "thread" : next.view.kind === "home" ? null : "room");
    window.history.pushState(chatHistoryState(true), "", href);
  }, []);

  const back = useCallback(() => {
    const current = latest.current.location;
    const state = window.history.state as Record<string, unknown> | null;
    setSlide(null);
    if (state?.chatPushed === true) window.history.back();
    else go(parentOf(current), { replace: true });
  }, [go]);

  const closeThread = useCallback(() => {
    if (!latest.current.location.thread) return;
    back();
    const target = opener.current;
    opener.current = null;
    window.setTimeout(() => {
      if (target?.isConnected) target.focus({ preventScroll: true });
    }, 50);
  }, [back]);

  const openThread = useCallback(
    (conversationId: string, rootId: string) => {
      const current = latest.current.location;
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const next: ChatView = current.view.kind === "threads" ? current.view : { kind: "room", id: conversationId };
      go({ view: next, thread: rootId, message: null }, { replace: Boolean(current.thread) && sameView(current.view, next) });
    },
    [go],
  );

  const conversation = useCallback((id: string) => latest.current.sidebar?.conversations.find((item) => item.id === id) ?? latest.current.state.rooms[id]?.conversation ?? null, []);

  const copyLink = useCallback(async (message: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${messageHref(message.conversationId, message)}`);
      return true;
    } catch {
      setNotice("Couldn't copy the link. Try again.");
      return false;
    }
  }, []);

  const { loadRoom, loadMessages, loadThread, deliver } = actions;

  const send = useCallback(
    (input: { conversationId: string; parentId: string | null; text: string; mentions: Mention[]; discardOnFailure?: boolean }) => {
      const body = messageBody(input.text, input.mentions);
      if (!body || !input.conversationId) return Promise.resolve(null);
      const message = localMessage({
        clientKey: newClientKey(),
        conversationId: input.conversationId,
        parentId: input.parentId,
        author: me,
        body,
        mentions: memberIds(body),
        at: new Date().toISOString(),
      });
      dispatch({ type: "pending", message });
      const timeline = latest.current.state.timelines[input.conversationId];
      const open = latest.current.location;
      if (!input.parentId && loadsLatestFirst(timeline)) {
        loadMessages(input.conversationId, "latest");
        if (open.view.kind === "room" && open.view.id === input.conversationId) setBottomSignal((value) => value + 1);
      }
      if (input.parentId && loadsLatestFirst(latest.current.state.threads[input.parentId]?.timeline)) {
        loadThread(input.parentId, "latest");
        if (open.thread === input.parentId) setThreadBottomSignal((value) => value + 1);
      }
      return deliver(message).then((error) => {
        if (error && input.discardOnFailure) dispatch({ type: "discard", message });
        return error;
      });
    },
    [deliver, loadMessages, loadThread, me],
  );

  useEffect(() => {
    if (!roomId) return;
    const key = `room:${roomId}`;
    if (fresh.current.has(key)) {
      fresh.current.delete(key);
      return;
    }
    const timeline = latest.current.state.timelines[roomId];
    const message = location.message;
    if (!timeline || timeline.status === "error") loadMessages(roomId, "latest", message ?? "unread");
    else if (message && !timeline.messages.some((item) => item.id === message)) loadMessages(roomId, "latest", message);
    else if (timeline.status === "ready" && !timeline.hasNewer) loadMessages(roomId, "newer");
    loadRoom(roomId);
  }, [roomId, location.message, loadMessages, loadRoom]);

  useEffect(() => {
    if (!threadId) return;
    const key = `thread:${threadId}`;
    if (fresh.current.has(key)) {
      fresh.current.delete(key);
      return;
    }
    const thread = latest.current.state.threads[threadId];
    if (!thread?.root || thread.timeline.status !== "ready") loadThread(threadId, "latest");
    else loadThread(threadId, "newer");
  }, [threadId, loadThread]);

  const roomTimeline = roomId ? state.timelines[roomId] : undefined;
  const roomCatchUp = needsCatchUp(roomTimeline);
  const roomMessages = roomTimeline?.messages;
  useEffect(() => {
    if (roomId && roomCatchUp && roomMessages) loadMessages(roomId, "newer");
  }, [roomId, roomCatchUp, roomMessages, loadMessages]);

  const threadTimeline = threadId ? state.threads[threadId]?.timeline : undefined;
  const threadCatchUp = needsCatchUp(threadTimeline);
  const threadMessages = threadTimeline?.messages;
  useEffect(() => {
    if (threadId && threadCatchUp && threadMessages) loadThread(threadId, "newer");
  }, [threadId, threadCatchUp, threadMessages, loadThread]);

  const wasJoined = useRef(joined);
  useEffect(() => {
    const rejoined = joined && !wasJoined.current;
    wasJoined.current = joined;
    if (!rejoined) return;
    const current = latest.current.location;
    if (current.view.kind === "room") {
      loadMessages(current.view.id, "newer");
      loadRoom(current.view.id);
    }
    if (current.thread) loadThread(current.thread, "newer");
  }, [joined, loadMessages, loadRoom, loadThread]);

  useEffect(() => {
    if (joined || !roomId || !sidebar) return;
    const entry = sidebar.conversations.find((item) => item.id === roomId);
    const timeline = latest.current.state.timelines[roomId];
    if (!entry?.lastMessageAt || !timeline || timeline.status !== "ready" || timeline.hasNewer) return;
    const newest = newestServerId(timeline.messages);
    const newestAt = timeline.messages.find((item) => item.id === newest)?.createdAt ?? "";
    if (entry.lastMessageAt > newestAt) loadMessages(roomId, newest ? "newer" : "latest");
  }, [sidebar, joined, roomId, loadMessages]);

  useEffect(() => {
    if (joined || !threadId || !sidebar) return;
    loadThread(threadId, "newer");
  }, [sidebar, joined, threadId, loadThread]);

  useEffect(() => {
    let last = Date.now();
    const onFocus = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < FOCUS_GAP_MS) return;
      last = Date.now();
      const current = latest.current.location;
      if (current.view.kind === "room") {
        loadMessages(current.view.id, "newer");
        loadRoom(current.view.id);
      }
      if (current.thread) loadThread(current.thread, "newer");
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [loadMessages, loadRoom, loadThread]);

  const wantsNew = search.get(NEW_PARAM) === "message";
  const [askedNew, setAskedNew] = useState(false);
  if (wantsNew !== askedNew) {
    setAskedNew(wantsNew);
    if (wantsNew) setNewMessage(true);
  }
  useEffect(() => {
    if (!wantsNew) return;
    const current = window.history.state as Record<string, unknown> | null;
    window.history.replaceState(chatHistoryState(current?.chatPushed === true), "", chatLocationHref(latest.current.location));
  }, [wantsNew]);

  const leftRoom = useCallback(
    (conversationId: string) => {
      dispatch({ type: "forget", conversationId });
      clearDrafts(viewer.id, conversationId);
    },
    [viewer.id],
  );

  useChatEvents((event) => {
    switch (event.type) {
      case "message":
        dispatch({ type: "incoming", message: event.message, root: event.root });
        return;
      case "edit":
        dispatch({ type: "edited", message: event.message });
        return;
      case "delete":
        dispatch({ type: "deleted", conversationId: event.conversationId, messageId: event.messageId, parentId: event.parentId, root: event.root });
        return;
      case "read":
        dispatch({ type: "read", conversationId: event.conversationId, lastReadAt: event.lastReadAt });
        return;
      case "thread-read":
        dispatch({ type: "thread-read", rootId: event.messageId, lastReadAt: event.lastReadAt });
        return;
      case "conversation":
        if (latest.current.state.rooms[event.conversationId]) loadRoom(event.conversationId);
        return;
      case "removed": {
        const current = latest.current.location;
        const threadRoom = current.thread ? latest.current.state.threads[current.thread]?.root?.conversationId : null;
        leftRoom(event.conversationId);
        if (current.view.kind === "room" && current.view.id === event.conversationId) {
          setSettings({ open: false, adding: false });
          go({ view: { kind: "home" }, thread: null, message: null }, { replace: true });
          setNotice("You're no longer in that conversation.");
        } else if (threadRoom === event.conversationId) {
          go({ view: current.view, thread: null, message: null }, { replace: true });
          setNotice("You're no longer in that conversation.");
        }
        return;
      }
    }
  });

  const step = useCallback(
    (direction: 1 | -1) => {
      if (composerHasText()) return false;
      const views = listViews(latest.current.sidebar);
      if (views.length === 0) return false;
      const current = latest.current.location.view;
      const index = views.findIndex((item) => sameView(item, current));
      const next = views[index < 0 ? (direction > 0 ? 0 : views.length - 1) : (index + direction + views.length) % views.length];
      go({ view: next, thread: null, message: null }, { replace: true });
      return true;
    },
    [go],
  );

  const roomForSettings = roomId ? (state.rooms[roomId] ?? null) : null;
  useShortcut("chat-prev", () => step(-1));
  useShortcut("chat-next", () => step(1));
  useShortcut("chat-new-message", () => setNewMessage(true));
  useShortcut("chat-new-room", () => setNewRoom(true));
  useShortcut("chat-room-settings", () => setSettings({ open: true, adding: false }), roomForSettings?.conversation.kind === "room");
  useShortcut("chat-close-thread", () => {
    if (!latest.current.location.thread) return false;
    closeThread();
  });
  useShortcut("chat-reply", () => {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>("[data-chat-message]") : null;
    const row = focused ?? document.querySelector<HTMLElement>("[data-chat-room-pane] [data-chat-message]:hover");
    if (!row || !row.closest("[data-chat-room-pane]")) return false;
    const id = row.dataset.chatMessage;
    const conversationId = row.dataset.chatConversation;
    if (!id || !conversationId || id.startsWith("local:")) return false;
    openThread(conversationId, id);
  });

  const failed = state.failed;
  const room = roomForSettings;
  const members = room?.members;
  const memberNames = useMemo(() => new Map((members ?? []).map((member) => [member.id.toLowerCase(), member.name])), [members]);
  const context = useMemo<ChatContextValue>(
    () => ({ ...actions, viewer: me, now, multi, workspaces, location, failed, editing, setEditing, go, back, openThread, closeThread, conversation, copyLink, send, memberNames }),
    [actions, me, now, multi, workspaces, location, failed, editing, go, back, openThread, closeThread, conversation, copyLink, send, memberNames],
  );

  const entry: ChatConversation | null = roomId ? (sidebar?.conversations.find((item) => item.id === roomId) ?? room?.conversation ?? null) : null;
  const thread = threadId ? (state.threads[threadId] ?? null) : null;

  function opened(conversation: ChatConversation) {
    go({ view: { kind: "room", id: conversation.id }, thread: null, message: null });
  }

  return (
    <ChatContext.Provider value={context}>
      <section data-quick-add-hide="" className="flex min-h-0 min-w-0 flex-1 flex-col">
        <SectionHeader
          title="Chat"
          viewer={viewer}
          action={
            <Button variant="secondary" size="icon" aria-label="New message" title="New message" onClick={() => setNewMessage(true)} className="max-md:size-11 md:hidden">
              <ComposeIcon aria-hidden className="size-3.5" />
            </Button>
          }
        />
        <div className="flex min-h-0 flex-1">
          <ChatList
            sidebar={sidebar}
            error={initial.sidebar ? null : "Couldn't load Chat. Try again."}
            view={view}
            onNewRoom={() => setNewRoom(true)}
            onNewMessage={() => setNewMessage(true)}
            className={cn(detail ? "max-md:hidden" : "max-md:flex-1")}
          />
          {!detail && (
            <div className="md:bg-surface-panel hidden min-w-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center md:my-2 md:mr-2 md:flex md:rounded-2xl">
              <ChatIcon aria-hidden className="text-faint size-5" />
              <p className="text-subtle">Pick a conversation, or start one.</p>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" className="hit" onClick={() => setNewRoom(true)}>
                  New room
                </Button>
                <Button variant="secondary" size="sm" className="hit" onClick={() => setNewMessage(true)}>
                  New message
                </Button>
              </div>
            </div>
          )}
          {detail && (
            <div
              ref={pane}
              data-chat-room-pane
              className={cn(
                PHONE_LAYER,
                "md:bg-surface-panel flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden max-md:z-30 md:my-2 md:mr-2 md:rounded-2xl",
                slide === "room" && "max-md:motion-safe:animate-enter-from-right",
                threadId && "max-xl:hidden",
              )}
            >
              {view.kind === "threads" ? (
                <ThreadsView initial={threadsSeed} />
              ) : view.kind === "room" ? (
                <RoomView
                  key={view.id}
                  conversationId={view.id}
                  conversation={entry}
                  room={room}
                  roomError={state.roomErrors[view.id] ?? null}
                  timeline={state.timelines[view.id] ?? null}
                  focusId={location.message}
                  bottomSignal={bottomSignal}
                  onSettings={() => setSettings({ open: true, adding: false })}
                  onAddPeople={() => setSettings({ open: true, adding: true })}
                />
              ) : null}
            </div>
          )}
          {threadId && (
            <div
              ref={threadPane}
              data-chat-thread-pane
              className={cn(
                PHONE_LAYER,
                "md:bg-surface-panel flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden max-md:z-[31] md:my-2 md:mr-2 md:rounded-2xl xl:w-[380px] xl:flex-none",
                slide === "thread" && "max-md:motion-safe:animate-enter-from-right",
              )}
            >
              <ThreadPanel key={threadId} rootId={threadId} thread={thread} conversation={roomId ? entry : null} bottomSignal={threadBottomSignal} onClose={closeThread} />
            </div>
          )}
        </div>
        {notice && (
          <div
            role="alert"
            className="bg-popover border-line-strong shadow-overlay ui-style fixed bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-xl border py-2 pr-2 pl-3.5"
          >
            <span className="min-w-0">{notice}</span>
            <Button variant="ghost" size="sm" onClick={() => setNotice(null)} className="hit max-md:h-11">
              Dismiss
            </Button>
          </div>
        )}
      </section>
      <NewRoomDialog open={newRoom} onOpenChange={setNewRoom} onCreated={opened} />
      <NewMessageDialog open={newMessage} onOpenChange={setNewMessage} onOpened={opened} />
      {room && room.conversation.kind === "room" && (
        <RoomSettings
          open={settings.open}
          onOpenChange={(open) => setSettings((current) => ({ ...current, open }))}
          room={room}
          adding={settings.adding}
          onLeft={() => {
            leftRoom(room.conversation.id);
            go({ view: { kind: "home" }, thread: null, message: null }, { replace: true });
          }}
        />
      )}
    </ChatContext.Provider>
  );
}
