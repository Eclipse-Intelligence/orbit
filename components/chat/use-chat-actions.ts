"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, type Dispatch } from "react";
import { deleteMessageAction, editMessageAction, postMessageAction } from "@/app/(crm)/chat/actions";
import { chatJoined, refreshChatSidebar } from "@/components/chat/chat-live";
import { chatApi, draftKey, readDraft, writeDraft } from "@/lib/chat/client";
import { isLocal, newerCursor, oldestServerId, sidebarRead, type ChatAction, type ChatState } from "@/lib/chat/timeline";
import type { ChatMessage, ChatNeedsShare } from "@/lib/chat/types";
import { encodeMentions, mentionsIn, type Mention } from "@/lib/mentions";
import { useCompaniesStore } from "@/stores/companies-store";

export const SEND_FAILED = "Couldn't send. Try again.";

export type ChatTimelineActions = {
  loadRoom: (conversationId: string) => void;
  loadMessages: (conversationId: string, mode: "latest" | "older" | "newer", around?: string | null) => void;
  loadThread: (rootId: string, mode: "latest" | "older" | "newer") => void;
  deliver: (message: ChatMessage) => Promise<string | null>;
  retry: (message: ChatMessage) => void;
  edit: (message: ChatMessage, text: string, mentions: Mention[]) => Promise<boolean>;
  remove: (message: ChatMessage) => Promise<boolean>;
  markRead: (conversationId: string, upTo: string | null) => void;
  markThreadRead: (rootId: string, upTo: string | null) => void;
};

export function memberIds(body: string) {
  return [...new Set(mentionsIn(body).filter((mention) => mention.kind === "member").map((mention) => mention.id.toLowerCase()))];
}

export function messageBody(text: string, mentions: Mention[]) {
  return encodeMentions(text, mentions).trim();
}

export function useChatActions(
  dispatch: Dispatch<ChatAction>,
  state: ChatState,
  userId: string,
  onError: (message: string) => void,
  onNeedsShare?: (clientKey: string, needs: ChatNeedsShare) => void,
): ChatTimelineActions {
  const latest = useRef(state);
  const errorRef = useRef(onError);
  const needsRef = useRef(onNeedsShare);
  useLayoutEffect(() => {
    latest.current = state;
    errorRef.current = onError;
    needsRef.current = onNeedsShare;
  });
  const inflight = useRef(new Set<string>());
  const reads = useRef(new Map<string, string | null>());

  const repeat = useRef(new Set<string>());
  const once = useCallback((key: string, work: () => Promise<void>) => {
    if (inflight.current.has(key)) {
      if (key.includes(":newer")) repeat.current.add(key);
      return;
    }
    inflight.current.add(key);
    const run = (): Promise<void> =>
      work().finally(() => {
        if (!repeat.current.delete(key)) return;
        return run();
      });
    void run().finally(() => inflight.current.delete(key));
  }, []);

  const loadRoom = useCallback(
    (conversationId: string) =>
      once(`room:${conversationId}`, async () => {
        try {
          dispatch({ type: "room", room: await chatApi.room(conversationId) });
        } catch (error) {
          dispatch({ type: "room-error", conversationId, error: (error as Error).message });
        }
      }),
    [dispatch, once],
  );

  const loadMessages = useCallback(
    (conversationId: string, mode: "latest" | "older" | "newer", around?: string | null) =>
      once(`messages:${conversationId}:${mode}:${mode === "latest" ? (around ?? "") : ""}`, async () => {
        const timeline = latest.current.timelines[conversationId];
        const before = mode === "older" ? oldestServerId(timeline?.messages ?? []) : null;
        const after = mode === "newer" ? newerCursor(timeline) : null;
        if (mode === "older" && !before) return;
        if (mode === "newer" && !after && timeline?.status !== "ready") return;
        const effective = mode === "newer" && !after ? "latest" : mode;
        if (effective === "latest") dispatch({ type: "loading", conversationId });
        try {
          const page = await chatApi.messages(conversationId, { before, after, around: effective === "latest" ? around : null });
          dispatch({ type: "page", conversationId, page, mode: effective === "latest" ? "replace" : effective });
        } catch (error) {
          dispatch({ type: "page-error", conversationId, error: (error as Error).message });
        }
      }),
    [dispatch, once],
  );

  const loadThread = useCallback(
    (rootId: string, mode: "latest" | "older" | "newer") =>
      once(`thread:${rootId}:${mode}`, async () => {
        const thread = latest.current.threads[rootId];
        const messages = thread?.timeline.messages ?? [];
        const before = mode === "older" ? oldestServerId(messages) : null;
        const after = mode === "newer" ? newerCursor(thread?.timeline) : null;
        if (mode === "older" && !before) return;
        const effective = mode === "newer" && (!after || !thread?.root) ? "latest" : mode;
        if (effective === "latest") dispatch({ type: "thread-loading", rootId });
        try {
          const loaded = await chatApi.thread(rootId, effective === "latest" ? {} : { before, after });
          dispatch({ type: "thread", thread: loaded, mode: effective === "latest" ? "replace" : effective });
        } catch (error) {
          dispatch({ type: "thread-error", rootId, error: (error as Error).message });
        }
      }),
    [dispatch, once],
  );

  const deliver = useCallback(
    async (message: ChatMessage) => {
      const clientKey = message.clientKey ?? "";
      const result = await postMessageAction({ conversationId: message.conversationId, parentId: message.parentId, body: message.body, clientKey }).catch(() => ({
        error: SEND_FAILED,
      }));
      if ("ok" in result && result.ok) {
        dispatch({ type: "incoming", message: result.message, root: result.root, unsynced: !chatJoined() });
        const key = draftKey(userId, message.conversationId, message.parentId);
        const draft = readDraft(key);
        if (draft.text && messageBody(draft.text, draft.mentions) === message.body) writeDraft(key, { text: "", mentions: [] });
        return null;
      }
      const error = "error" in result ? result.error : SEND_FAILED;
      if ("needsShare" in result && result.needsShare) needsRef.current?.(clientKey, result.needsShare);
      dispatch({ type: "failed", clientKey, error });
      return error;
    },
    [dispatch, userId],
  );

  const retry = useCallback(
    (message: ChatMessage) => {
      if (!message.clientKey) return;
      dispatch({ type: "retrying", clientKey: message.clientKey });
      void deliver(message);
    },
    [deliver, dispatch],
  );

  const edit = useCallback(
    async (message: ChatMessage, text: string, mentions: Mention[]) => {
      const body = messageBody(text, mentions);
      if (!body || body === message.body) return true;
      dispatch({ type: "edited", message: { ...message, body, mentions: memberIds(body), editedAt: new Date().toISOString() } });
      const result = await editMessageAction(message.id, body).catch(() => ({ error: "Couldn't save the message. Try again." }));
      if ("ok" in result && result.ok) {
        dispatch({ type: "edited", message: result.message });
        return true;
      }
      dispatch({ type: "edited", message });
      errorRef.current("error" in result ? result.error : "Couldn't save the message. Try again.");
      return false;
    },
    [dispatch],
  );

  const remove = useCallback(
    async (message: ChatMessage) => {
      if (isLocal(message)) {
        dispatch({ type: "discard", message });
        return true;
      }
      const thread = message.parentId ? latest.current.threads[message.parentId]?.root : null;
      const root = thread ? { id: thread.id, replyCount: Math.max(0, thread.replyCount - 1), lastReplyAt: thread.lastReplyAt, replyAuthors: thread.replyAuthors } : null;
      dispatch({ type: "deleted", conversationId: message.conversationId, messageId: message.id, parentId: message.parentId, root });
      const result = await deleteMessageAction(message.id).catch(() => ({ error: "Couldn't delete the message. Try again." }));
      if ("ok" in result && result.ok) return true;
      errorRef.current("error" in result ? result.error : "Couldn't delete the message. Try again.");
      if (message.parentId) loadThread(message.parentId, "latest");
      loadMessages(message.conversationId, "latest");
      return false;
    },
    [dispatch, loadMessages, loadThread],
  );

  const markRead = useCallback(
    (conversationId: string, upTo: string | null) => {
      const key = conversationId;
      if (reads.current.has(key) && reads.current.get(key) === upTo) return;
      reads.current.set(key, upTo);
      useCompaniesStore.getState().setChat((current) => (current ? sidebarRead(current, conversationId) : current));
      void chatApi
        .markRead(conversationId, upTo)
        .then((result) => dispatch({ type: "read", conversationId, lastReadAt: result.lastReadAt }))
        .catch(() => {
          reads.current.delete(key);
          refreshChatSidebar();
        });
    },
    [dispatch],
  );

  const markThreadRead = useCallback(
    (rootId: string, upTo: string | null) => {
      const key = `thread:${rootId}`;
      if (reads.current.has(key) && reads.current.get(key) === upTo) return;
      reads.current.set(key, upTo);
      void chatApi
        .markThreadRead(rootId, upTo)
        .then((result) => {
          if (result.lastReadAt) dispatch({ type: "thread-read", rootId, lastReadAt: result.lastReadAt });
          refreshChatSidebar();
        })
        .catch(() => reads.current.delete(key));
    },
    [dispatch],
  );

  return useMemo(
    () => ({ loadRoom, loadMessages, loadThread, deliver, retry, edit, remove, markRead, markThreadRead }),
    [loadRoom, loadMessages, loadThread, deliver, retry, edit, remove, markRead, markThreadRead],
  );
}
