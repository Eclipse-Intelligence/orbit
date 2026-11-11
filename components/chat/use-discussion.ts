"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { openDiscussionAction } from "@/app/(crm)/discussions";
import type { ChatContextValue, ChatEditing } from "@/components/chat/chat-context";
import { useChatEvents, useChatJoined } from "@/components/chat/chat-live";
import { memberIds, messageBody, useChatActions } from "@/components/chat/use-chat-actions";
import { draftKey, newClientKey, writeDraft } from "@/lib/chat/client";
import { discussionCount, discussionHref, draftSubjectKey } from "@/lib/chat/discussions";
import type { ChatLocation } from "@/lib/chat/routes";
import { chatReducer, EMPTY_CHAT, localMessage, needsCatchUp, type ChatAction, type ChatState, type ThreadState, type Timeline } from "@/lib/chat/timeline";
import type { ChatDiscussion, ChatMessage, ChatNeedsShare, ChatPerson, ChatSubject, ChatSubjectKind } from "@/lib/chat/types";
import type { Mention } from "@/lib/mentions";

const TIMEOUT_MS = 15_000;
const TICK_MS = 60_000;
const FOCUS_GAP_MS = 5_000;
const RELOAD_SETTLE_MS = 400;
const NOTICE_MS = 6_000;
const LOAD_FAILED = "Couldn't load the discussion. Try again.";
const OPEN_FAILED = "Couldn't open the discussion. Try again.";
const NOWHERE: ChatLocation = {
  view: { kind: "home" },
  thread: null,
  message: null,
};
const NO_NAMES = new Map<string, string>();

export type NeedsSharePrompt = ChatNeedsShare & { parentId: string | null; text: string; mentions: Mention[] };

export type Discussion = {
  subject: ChatSubject;
  needsShare: NeedsSharePrompt | null;
  composerVersion: number;
  settleNeedsShare: (added: boolean) => void;
  context: ChatContextValue;
  conversationId: string | null;
  draftId: string;
  status: "loading" | "ready" | "error";
  error: string | null;
  notice: string | null;
  dismissNotice: () => void;
  count: number;
  timeline: Timeline | null;
  threadId: string | null;
  thread: ThreadState | null;
  reload: () => void;
  loadOlder: () => void;
};

async function fetchDiscussion(subject: ChatSubject) {
  let response: Response;
  try {
    response = await fetch(`/api/chat/discussions?${subject.kind}=${encodeURIComponent(subject.id)}`, {
      cache: "no-store",
      credentials: "same-origin",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error(LOAD_FAILED);
  }
  const body = (await response.json().catch(() => null)) as (ChatDiscussion & { error?: string }) | null;
  if (!response.ok || !body) throw new Error(body?.error || LOAD_FAILED);
  return body;
}

function discussionReducer(state: ChatState, action: ChatAction | { type: "reset" }) {
  return action.type === "reset" ? EMPTY_CHAT : chatReducer(state, action);
}

export function useDiscussion(kind: ChatSubjectKind, id: string, person: ChatPerson, options: { enabled?: boolean; initialCount?: number; onSent?: (message: ChatMessage) => void } = {}): Discussion {
  const enabled = options.enabled ?? true;
  const initialCount = options.initialCount ?? 0;
  const subject = useMemo<ChatSubject>(() => ({ kind, id }), [kind, id]);
  const viewer = useMemo<ChatPerson>(() => ({ id: person.id, name: person.name }), [person.id, person.name]);
  const [state, dispatch] = useReducer(discussionReducer, EMPTY_CHAT);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [status, setStatus] = useState<Discussion["status"]>("loading");
  const [error, setError] = useState<string | null>(null);
  const [serverCount, setServerCount] = useState(initialCount);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ChatEditing>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [needsShare, setNeedsShare] = useState<NeedsSharePrompt | null>(null);
  const [composerVersion, setComposerVersion] = useState(0);
  const refusals = useRef(new Map<string, ChatNeedsShare>());
  const noteRefusal = useCallback((clientKey: string, needs: ChatNeedsShare) => {
    refusals.current.set(clientKey, needs);
  }, []);
  const actions = useChatActions(dispatch, state, viewer.id, setNotice, noteRefusal);
  const { loadMessages, loadThread, deliver } = actions;
  const joined = useChatJoined();
  const subjectKey = `${enabled ? "on" : "off"}:${draftSubjectKey(subject)}`;
  const [seen, setSeen] = useState(subjectKey);
  if (seen !== subjectKey) {
    setSeen(subjectKey);
    setConversationId(null);
    setStatus("loading");
    setError(null);
    setServerCount(initialCount);
    setThreadId(null);
    setEditing(null);
    setNeedsShare(null);
    dispatch({ type: "reset" });
  }
  const latest = useRef({ conversationId, threadId, subjectKey });
  useLayoutEffect(() => {
    latest.current = { conversationId, threadId, subjectKey };
  });
  const draftId = draftSubjectKey(subject);
  const sent = useRef(options.onSent);
  useLayoutEffect(() => {
    sent.current = options.onSent;
  });

  const load = useCallback(() => {
    if (!enabled) return Promise.resolve();
    const asked = subjectKey;
    return fetchDiscussion(subject).then(
      (found) => {
        if (latest.current.subjectKey !== asked) return;
        setServerCount(found.count);
        if (found.conversationId && found.page) {
          latest.current.conversationId = found.conversationId;
          setConversationId(found.conversationId);
          dispatch({
            type: "page",
            conversationId: found.conversationId,
            page: found.page,
            mode: "replace",
          });
        }
        setStatus("ready");
        setError(null);
      },
      (failure: Error) => {
        if (latest.current.subjectKey !== asked) return;
        setStatus((current) => (current === "ready" ? current : "error"));
        setError(failure.message);
      },
    );
  }, [subject, subjectKey, enabled]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const settle = useRef(0);
  const reloadSoon = useCallback(() => {
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => void load(), RELOAD_SETTLE_MS);
  }, [load]);
  useEffect(() => () => window.clearTimeout(settle.current), []);

  const catchUp = useCallback(() => {
    const { conversationId: id, threadId: root } = latest.current;
    if (!id) {
      void load();
      return;
    }
    loadMessages(id, "newer");
    if (root) loadThread(root, "newer");
  }, [load, loadMessages, loadThread]);

  useChatEvents((event) => {
    switch (event.type) {
      case "message":
        if (!latest.current.conversationId && event.subject?.kind === subject.kind && event.subject.id === subject.id) reloadSoon();
        dispatch({
          type: "incoming",
          message: event.message,
          root: event.root,
        });
        return;
      case "edit":
        dispatch({ type: "edited", message: event.message });
        return;
      case "delete":
        dispatch({
          type: "deleted",
          conversationId: event.conversationId,
          messageId: event.messageId,
          parentId: event.parentId,
          root: event.root,
        });
        return;
      case "thread-read":
        dispatch({
          type: "thread-read",
          rootId: event.messageId,
          lastReadAt: event.lastReadAt,
        });
        return;
    }
  });

  const wasJoined = useRef(joined);
  useEffect(() => {
    const rejoined = joined && !wasJoined.current;
    wasJoined.current = joined;
    if (rejoined) catchUp();
  }, [joined, catchUp]);

  useEffect(() => {
    let last = Date.now();
    const onFocus = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < FOCUS_GAP_MS) return;
      last = Date.now();
      catchUp();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [catchUp]);

  const timeline = conversationId ? (state.timelines[conversationId] ?? null) : null;
  const catching = needsCatchUp(timeline ?? undefined);
  useEffect(() => {
    if (conversationId && catching) loadMessages(conversationId, "newer");
  }, [conversationId, catching, loadMessages]);

  const ensureConversation = useCallback(async () => {
    const known = latest.current.conversationId;
    if (known) return { id: known, error: null };
    const asked = latest.current.subjectKey;
    const result = await openDiscussionAction(subject).catch(() => ({
      error: OPEN_FAILED,
    }));
    if (latest.current.subjectKey !== asked) return { id: null, error: OPEN_FAILED };
    if (!("ok" in result) || !result.ok)
      return {
        id: null,
        error: "error" in result ? result.error : OPEN_FAILED,
      };
    const id = result.conversationId;
    latest.current.conversationId = id;
    setConversationId(id);
    dispatch({
      type: "page",
      conversationId: id,
      page: {
        messages: [],
        hasOlder: false,
        hasNewer: false,
        firstUnreadId: null,
        lastReadAt: new Date().toISOString(),
      },
      mode: "replace",
    });
    loadMessages(id, "newer");
    return { id, error: null };
  }, [subject, loadMessages]);

  const send = useCallback(
    async (input: { parentId: string | null; text: string; mentions: Mention[] }) => {
      const body = messageBody(input.text, input.mentions);
      if (!body) return null;
      const asked = latest.current.subjectKey;
      const opened = await ensureConversation();
      if (!opened.id) return opened.error;
      if (latest.current.subjectKey !== asked) return OPEN_FAILED;
      writeDraft(draftKey(viewer.id, draftSubjectKey(subject), input.parentId), {
        text: "",
        mentions: [],
      });
      const message = localMessage({
        clientKey: newClientKey(),
        conversationId: opened.id,
        parentId: input.parentId,
        author: viewer,
        body,
        mentions: memberIds(body),
        at: new Date().toISOString(),
      });
      dispatch({ type: "pending", message });
      setNeedsShare(null);
      const error = await deliver(message);
      if (error === null) {
        sent.current?.(message);
        return null;
      }
      const refused = message.clientKey ? refusals.current.get(message.clientKey) : undefined;
      if (!refused) return null;
      refusals.current.delete(message.clientKey!);
      dispatch({ type: "discard", message });
      if (latest.current.subjectKey === asked && refused.canAdd) setNeedsShare({ ...refused, parentId: input.parentId, text: input.text, mentions: input.mentions });
      return error;
    },
    [deliver, ensureConversation, subject, viewer],
  );

  const settleNeedsShare = useCallback(
    (added: boolean) => {
      const prompt = needsShare;
      setNeedsShare(null);
      if (!prompt) return;
      writeDraft(draftKey(viewer.id, draftSubjectKey(subject), prompt.parentId), added ? { text: "", mentions: [] } : { text: prompt.text, mentions: prompt.mentions });
      setComposerVersion((version) => version + 1);
      if (added) void send({ parentId: prompt.parentId, text: prompt.text, mentions: prompt.mentions });
    },
    [needsShare, send, subject, viewer.id],
  );

  const openThread = useCallback(
    (...[, rootId]: [string, string]) => {
      setThreadId(rootId);
      loadThread(rootId, "latest");
    },
    [loadThread],
  );

  const closeThread = useCallback(() => setThreadId(null), []);

  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${discussionHref(subject)}`);
      return true;
    } catch {
      setNotice("Couldn't copy the link. Try again.");
      return false;
    }
  }, [subject]);

  const context = useMemo<ChatContextValue>(
    () => ({
      ...actions,
      viewer,
      now,
      multi: false,
      workspaces: [],
      location: NOWHERE,
      failed: state.failed,
      editing,
      setEditing,
      go: () => undefined,
      back: closeThread,
      openThread,
      closeThread,
      conversation: () => null,
      copyLink,
      send: (input) => send(input),
      memberNames: NO_NAMES,
    }),
    [actions, viewer, now, state.failed, editing, closeThread, openThread, copyLink, send],
  );

  const loaded = timeline?.status === "ready" && !timeline.hasOlder;
  const count = loaded ? discussionCount(timeline.messages) : serverCount;

  return {
    subject,
    needsShare,
    composerVersion,
    settleNeedsShare,
    context,
    conversationId,
    draftId,
    status,
    error,
    notice,
    dismissNotice: () => setNotice(null),
    count,
    timeline,
    threadId,
    thread: threadId ? (state.threads[threadId] ?? null) : null,
    reload: () => void load(),
    loadOlder: () => {
      if (conversationId) loadMessages(conversationId, "older");
    },
  };
}
