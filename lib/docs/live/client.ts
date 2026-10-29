import type { EditorView } from "@codemirror/view";
import * as Y from "yjs";
import { DocsError, type Page, type PageSummary, type Participant, type Presence } from "@/lib/docs/client-types";
import { clearLiveDraft, readLiveDraft, writeLiveDraft } from "@/lib/docs/drafts";
import { setPresence } from "@/lib/docs/editor/presence";
import { bind, unbind } from "@/lib/docs/live/binding";
import { personTopic, workspaceTopic, type LiveTransportKind, type LiveUser, type WritingMessage } from "@/lib/docs/live/protocol";
import { publishPresence } from "@/lib/docs/live/registry";
import { relayTransport } from "@/lib/docs/live/relay-transport";
import { LiveSession, RECONCILE, type LiveServer, type SyncReply } from "@/lib/docs/live/session";
import { supabaseTransport } from "@/lib/docs/live/supabase-transport";
import type { LiveTransport } from "@/lib/docs/live/transport";
import { absoluteFrom, createLiveDoc, decodeBytes, encodeBytes } from "@/lib/docs/live/ydoc";
import { liveParticipant } from "@/lib/docs/participants";
import { registerLiveNote, settleForLive, useDocsStore } from "@/stores/docs-store";

export type CachedLive = { doc: Y.Doc; serverVector: Uint8Array; revision: number; base: string };

type Current = { pageId: string; view: EditorView; session: LiveSession<PageSummary>; stop: () => void };

const SUMMARY_EVERY_MS = 400;
const DRAFT_EVERY_MS = 800;

let current: Current | null = null;
const transports = new Map<LiveTransportKind, Promise<LiveTransport | null>>();

function transportFor(kind: LiveTransportKind) {
  let found = transports.get(kind);
  if (!found) {
    found = kind === "supabase" ? supabaseTransport() : Promise.resolve(relayTransport());
    transports.set(kind, found);
    void found.then((transport) => {
      if (!transport) transports.delete(kind);
    });
  }
  return found;
}

function failure(status: number, payload: { error?: string; code?: string } | null) {
  return new DocsError(payload?.error || (status === 401 ? "Your session ended. Sign in again." : "Docs couldn't reach Orbit."), payload?.code ?? String(status));
}

function httpServer(pageId: string): LiveServer<PageSummary> {
  return {
    async sync(input) {
      const body = JSON.stringify({ update: input.update ? encodeBytes(input.update) : undefined, vector: encodeBytes(input.vector), title: input.title });
      const response = await fetch(`/api/docs/pages/${encodeURIComponent(pageId)}/live`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        credentials: "same-origin",
        keepalive: input.keepalive === true && body.length < 60_000,
      });
      const payload = (await response.json().catch(() => null)) as { vector?: string; missing?: string; revision?: number; summary?: PageSummary; error?: string; code?: string } | null;
      if (!response.ok || !payload) throw failure(response.status, payload);
      return {
        vector: decodeBytes(payload.vector) ?? new Uint8Array([0]),
        missing: decodeBytes(payload.missing) ?? new Uint8Array([0, 0]),
        revision: payload.revision ?? 0,
        summary: payload.summary,
      };
    },
  };
}

async function openState(pageId: string) {
  const response = await fetch(`/api/docs/pages/${encodeURIComponent(pageId)}/live`, { cache: "no-store", credentials: "same-origin" });
  const payload = (await response.json().catch(() => null)) as { state?: string; revision?: number; title?: string; error?: string; code?: string } | null;
  if (!response.ok || !payload) throw failure(response.status, payload);
  const state = decodeBytes(payload.state);
  if (!state) throw new DocsError("Docs couldn't read this note's live copy.", "invalid");
  return { state, revision: payload.revision ?? 0 };
}

function viewerUser(): LiveUser | null {
  const viewer = useDocsStore.getState().viewer;
  return viewer ? { id: viewer.id, name: viewer.name, kind: "person" } : null;
}

function presenceOf(session: LiveSession<PageSummary>): Presence[] {
  const viewerId = useDocsStore.getState().viewer?.id ?? null;
  const out: Presence[] = [];
  for (const { state } of session.remoteStates()) {
    if (!state.user || typeof state.user.id !== "string") continue;
    const participant = liveParticipant(state.user, viewerId);
    const head = state.cursor ? absoluteFrom(session.doc, state.cursor.head) : null;
    const anchor = state.cursor ? absoluteFrom(session.doc, state.cursor.anchor) : null;
    const entry: Presence = { participant, cursor: head, writing: state.writing === true };
    if (participant.kind === "person") {
      if (head !== null && anchor !== null && anchor !== head) entry.selection = { from: Math.min(anchor, head), to: Math.max(anchor, head) };
    } else {
      const from = absoluteFrom(session.doc, state.from);
      if (from !== null && head !== null && from < head) entry.insertFrom = from;
    }
    out.push(entry);
  }
  return out;
}

export function isLive(pageId: string) {
  return current?.pageId === pageId;
}

export function liveTitle(pageId: string, title: string) {
  if (current?.pageId === pageId) current.session.setTitle(title);
}

export function pullLive(pageId: string) {
  if (current?.pageId === pageId) void current.session.pull();
}

export async function attachLive(options: { view: EditorView; page: Page; title: string; cached: CachedLive | null; isCurrent: () => boolean }) {
  const store = useDocsStore.getState();
  const kind = store.liveKind;
  const user = viewerUser();
  if (!kind || !user || current?.pageId === options.page.id) return false;
  const pageId = options.page.id;
  const transportPromise = transportFor(kind);
  let base: string;
  let doc: Y.Doc;
  let serverVector: Uint8Array;
  let revision: number;
  if (options.cached) {
    ({ doc, serverVector, revision, base } = options.cached);
  } else {
    const settled = await settleForLive(pageId);
    if (!settled || !options.isCurrent()) return false;
    const opened = await openState(pageId).catch(() => null);
    if (!opened || !options.isCurrent()) return false;
    base = settled.base;
    doc = createLiveDoc(opened.state);
    serverVector = Y.encodeStateVector(doc);
    revision = opened.revision;
  }
  const transport = await transportPromise.catch(() => null);
  if (!options.isCurrent() || current) return false;
  const session = new LiveSession<PageSummary>({ pageId, user, doc, serverVector, revision, title: options.title, transport, server: httpServer(pageId) });
  if (!options.cached) {
    const draft = decodeBytes(readLiveDraft(pageId));
    if (draft) {
      try {
        Y.applyUpdate(doc, draft, RECONCILE);
      } catch {
        clearLiveDraft(pageId);
      }
    }
  }
  bind(options.view, session, base);
  const stop = watch(pageId, options.view, session);
  current = { pageId, view: options.view, session, stop };
  session.start();
  return true;
}

function watch(pageId: string, view: EditorView, session: LiveSession<PageSummary>) {
  const store = () => useDocsStore.getState();
  let summaryTimer: ReturnType<typeof setTimeout> | null = null;
  let draftTimer: ReturnType<typeof setTimeout> | null = null;
  let lastStatus: string | null = null;
  let presenceQueued = false;
  let stopped = false;
  const pushPresence = () => {
    if (presenceQueued) return;
    presenceQueued = true;
    queueMicrotask(() => {
      presenceQueued = false;
      if (stopped) return;
      const list = presenceOf(session);
      publishPresence(pageId, list);
      view.dispatch({ effects: setPresence.of(list) });
    });
  };
  const offStatus = session.subscribe(() => {
    if (session.status !== lastStatus) {
      lastStatus = session.status;
      store().setLive(pageId, session.status);
      if (session.status === "offline" && session.unconfirmed()) store().setSave(pageId, "offline", "Offline, changes will sync");
    }
    pushPresence();
  });
  const offSaved = session.onSaved((reply: SyncReply<PageSummary>) => {
    if (reply.summary) store().liveSaved(pageId, reply.summary, reply.revision);
    if (!session.unconfirmed()) {
      store().setSave(pageId, "saved");
      clearLiveDraft(pageId);
    }
  });
  const offTitle = session.onTitle((title) => store().remoteTitle(pageId, title));
  const offText = session.onText((origin) => {
    const local = origin !== "remote" && origin !== "server-sync";
    if (local) store().setSave(pageId, "pending");
    if (!summaryTimer) {
      summaryTimer = setTimeout(() => {
        summaryTimer = null;
        store().editLocal(pageId, session.title, session.text.toString(), local ? undefined : null);
      }, SUMMARY_EVERY_MS);
    }
    if (session.unconfirmed() && !draftTimer) {
      draftTimer = setTimeout(() => {
        draftTimer = null;
        if (session.unconfirmed()) writeLiveDraft(pageId, encodeBytes(session.pendingDelta()));
      }, DRAFT_EVERY_MS);
    }
  });
  const onVisible = () => {
    if (document.visibilityState === "visible") session.wake();
    else void session.flush(true);
  };
  const onOnline = () => session.wake();
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", onOnline);
  const unregister = registerLiveNote(pageId, { flush: (keepalive) => session.flush(keepalive) });
  store().setLive(pageId, session.status);
  return () => {
    stopped = true;
    if (summaryTimer) clearTimeout(summaryTimer);
    if (draftTimer) clearTimeout(draftTimer);
    offStatus();
    offSaved();
    offTitle();
    offText();
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", onOnline);
    unregister();
    publishPresence(pageId, null);
    store().setLive(pageId, null);
  };
}

export function detachLive(pageId: string): CachedLive | null {
  if (!current || current.pageId !== pageId) return null;
  const { view, session, stop } = current;
  current = null;
  unbind(view);
  stop();
  const cached: CachedLive = { doc: session.doc, serverVector: session.serverState, revision: session.revision, base: session.text.toString() };
  void session.close().then(() => {
    if (session.unconfirmed()) {
      writeLiveDraft(pageId, encodeBytes(session.pendingDelta()));
      useDocsStore.getState().setSave(pageId, "offline", "Offline, changes will sync");
    } else {
      clearLiveDraft(pageId);
      useDocsStore.getState().setSave(pageId, "saved");
    }
  });
  return cached;
}

export async function watchLiveActivity(
  kind: LiveTransportKind,
  scope: { workspaceId: string; userId: string },
  listener: (pageId: string, writer: Participant, writing: boolean, revision?: number) => void,
  onJoined: (joined: boolean) => void,
) {
  const transport = await transportFor(kind).catch(() => null);
  if (!transport) {
    onJoined(false);
    return () => {};
  }
  const joined = new Set<string>();
  const topics = [workspaceTopic(scope.workspaceId), personTopic(scope.userId)];
  const channels = topics.map((topic) =>
    transport.open(topic, {
      message: (event, payload) => {
        if (event !== "writing" || !payload || typeof payload !== "object") return;
        const message = payload as WritingMessage;
        if (typeof message.pageId !== "string" || !message.user) return;
        listener(message.pageId, liveParticipant(message.user, scope.userId), message.writing === true, message.revision);
      },
      status: (status) => {
        if (status === "joined") joined.add(topic);
        else joined.delete(topic);
        onJoined(joined.size === topics.length);
      },
    }),
  );
  return () => {
    for (const channel of channels) channel.close();
  };
}
