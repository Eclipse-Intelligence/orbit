import type { EditorView } from "@codemirror/view";
import * as Y from "yjs";
import type { Page, PageSummary, Participant, Presence } from "@/lib/docs/client-types";
import { clearLiveDraft, readDraft, readLiveDraft, writeLiveDraft } from "@/lib/docs/drafts";
import { setPresence } from "@/lib/docs/editor/presence";
import { bind, lock, unbind } from "@/lib/docs/live/binding";
import { personTopic, workspaceTopic, type LiveTransportKind, type LiveUser, type WritingMessage } from "@/lib/docs/live/protocol";
import { onTrustChange, publishPresence, trustedUser, trustWriter } from "@/lib/docs/live/registry";
import { relayTransport } from "@/lib/docs/live/relay-transport";
import {
  KEEPALIVE_MAX,
  LiveSession,
  LiveSyncError,
  openSettled,
  RECONCILE,
  REMOTE,
  SERVER,
  type LiveFailure,
  type LiveServer,
  type Replacement,
  type SyncReply,
} from "@/lib/docs/live/session";
import { supabaseTransport } from "@/lib/docs/live/supabase-transport";
import type { LiveTransport } from "@/lib/docs/live/transport";
import { absoluteFrom, createLiveDoc, decodeBytes, encodeBytes, liveText } from "@/lib/docs/live/ydoc";
import { liveParticipant } from "@/lib/docs/participants";
import { adoptLiveBase, registerLiveNote, settleForLive, useDocsStore } from "@/stores/docs-store";

export type CachedLive = {
  doc: Y.Doc;
  serverVector: Uint8Array;
  serverText: string;
  revision: number;
  generation: number | null;
  title: string;
  base: string;
  own: [number, number][];
};

type AttachOptions = {
  view: EditorView;
  page: Page;
  title: () => string;
  cached: CachedLive | null;
  isCurrent: () => boolean;
  base?: string;
  replacement?: Replacement;
  onLost?: () => void;
};

type Current = { pageId: string; view: EditorView; session: LiveSession<PageSummary>; stop: () => void; options: AttachOptions };

type LivePayload = {
  vector?: string;
  missing?: string;
  revision?: number;
  generation?: number;
  rebuilt?: boolean;
  summary?: PageSummary;
  state?: string;
  title?: string;
  error?: string;
  code?: string;
};

const SUMMARY_EVERY_MS = 400;
const DRAFT_EVERY_MS = 800;
const DRAFT_MAX_BYTES = 750_000;
const EMPTY_UPDATE = new Uint8Array([0, 0]);
export const UNAVAILABLE = "This note isn't available. It may have been archived, or it isn't shared with you.";
const SIGNED_OUT = "Your session ended. Sign in again.";
const UNREACHABLE = "Docs couldn't reach Orbit.";
const NOT_KEPT = "Not kept on this device. Keep this tab open until it saves.";
const WILL_SYNC = "Offline, changes will sync";

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

function liveError(status: number, payload: LivePayload | null) {
  return new LiveSyncError(payload?.error || (status === 401 ? SIGNED_OUT : UNREACHABLE), status, payload?.code);
}

async function request(url: string, init: RequestInit) {
  try {
    return await fetch(url, init);
  } catch {
    throw new LiveSyncError(UNREACHABLE, null);
  }
}

function liveUrl(pageId: string) {
  return `/api/docs/pages/${encodeURIComponent(pageId)}/live`;
}

function httpServer(pageId: string): LiveServer<PageSummary> {
  return {
    async sync(input) {
      const body = JSON.stringify({
        update: input.update ? encodeBytes(input.update) : undefined,
        vector: encodeBytes(input.vector),
        title: input.title,
        generation: input.generation,
      });
      const response = await request(liveUrl(pageId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        credentials: "same-origin",
        keepalive: input.keepalive === true && body.length < KEEPALIVE_MAX,
      });
      const payload = (await response.json().catch(() => null)) as LivePayload | null;
      if (!response.ok || !payload) throw liveError(response.status, payload);
      const vector = decodeBytes(payload.vector);
      if (!vector) throw new LiveSyncError("Docs couldn't read Orbit's reply.", 502, "invalid_reply");
      return {
        vector,
        missing: decodeBytes(payload.missing) ?? EMPTY_UPDATE,
        revision: payload.revision ?? 0,
        title: payload.summary?.title,
        generation: typeof payload.generation === "number" ? payload.generation : undefined,
        rebuilt: payload.rebuilt === true,
        summary: payload.summary,
      };
    },
  };
}

async function openState(pageId: string) {
  const response = await request(liveUrl(pageId), { cache: "no-store", credentials: "same-origin" });
  const payload = (await response.json().catch(() => null)) as LivePayload | null;
  if (!response.ok || !payload) throw liveError(response.status, payload);
  const state = decodeBytes(payload.state);
  if (!state) throw new LiveSyncError("Docs couldn't read this note's live copy.", 502, "invalid_reply");
  return {
    state,
    revision: payload.revision ?? 0,
    title: typeof payload.title === "string" ? payload.title : null,
    generation: typeof payload.generation === "number" ? payload.generation : 0,
  };
}

function draftValue(session: LiveSession<PageSummary>, bytes: Uint8Array) {
  const encoded = encodeBytes(bytes);
  return session.generation === null ? encoded : `${session.generation}.${encoded}`;
}

function parseDraft(value: string | null, generation: number | null) {
  if (!value) return null;
  const dot = value.indexOf(".");
  const stored = dot === -1 ? null : Number(value.slice(0, dot));
  if (stored !== null && stored !== generation) return null;
  return decodeBytes(dot === -1 ? value : value.slice(dot + 1));
}

function keepDraft(pageId: string, session: LiveSession<PageSummary>) {
  if (!session.unconfirmed()) {
    clearLiveDraft(pageId);
    return true;
  }
  const bytes = session.draftDelta(DRAFT_MAX_BYTES);
  return bytes !== null && writeLiveDraft(pageId, draftValue(session, bytes));
}

function viewerUser(): LiveUser | null {
  const viewer = useDocsStore.getState().viewer;
  return viewer ? { id: viewer.id, name: viewer.name, kind: "person" } : null;
}

export function presenceOf<Summary>(session: LiveSession<Summary>, viewerId: string | null = useDocsStore.getState().viewer?.id ?? null): Presence[] {
  const out: Presence[] = [];
  for (const { state } of session.remoteStates()) {
    const user = trustedUser(session.pageId, { id: state.user.id, name: typeof state.user.name === "string" ? state.user.name : "", kind: String(state.user.kind) });
    const participant = liveParticipant(user, viewerId);
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

function knownTitle(page: Page) {
  return useDocsStore.getState().pages[page.id]?.title ?? page.title;
}

export async function attachLive(options: AttachOptions) {
  const store = useDocsStore.getState();
  const kind = store.liveKind;
  const user = viewerUser();
  if (!kind || !user || current?.pageId === options.page.id) return false;
  const pageId = options.page.id;
  const transportPromise = transportFor(kind);
  let base: string;
  let doc: Y.Doc;
  let serverVector: Uint8Array;
  let serverText: string;
  let revision: number;
  let generation: number | null;
  let title: string;
  let own: [number, number][] = [];
  let draft: Uint8Array | null = null;
  if (options.cached) {
    ({ doc, serverVector, serverText, revision, generation, title, base, own } = options.cached);
  } else if (options.replacement?.state && options.base !== undefined) {
    base = options.base;
    doc = createLiveDoc(options.replacement.state);
    serverVector = Y.encodeStateVector(doc);
    serverText = liveText(doc).toString();
    revision = options.replacement.revision;
    generation = options.replacement.generation ?? 0;
    title = options.replacement.title ?? knownTitle(options.page);
    clearLiveDraft(pageId);
  } else {
    const classicDraft = readDraft(pageId) !== null;
    const opened = await openSettled(() => settleForLive(pageId), () => openState(pageId), options.isCurrent).catch(() => null);
    if (!opened || !options.isCurrent()) return false;
    base = options.base ?? opened.base;
    doc = createLiveDoc(opened.state);
    serverVector = Y.encodeStateVector(doc);
    serverText = liveText(doc).toString();
    revision = opened.revision;
    generation = opened.generation;
    title = opened.title ?? knownTitle(options.page);
    if (classicDraft || options.base !== undefined) clearLiveDraft(pageId);
    else draft = parseDraft(readLiveDraft(pageId), generation);
  }
  const transport = await transportPromise.catch(() => null);
  if (!options.isCurrent() || current) return false;
  const session = new LiveSession<PageSummary>({ pageId, user, doc, serverVector, serverText, revision, generation, title, own, transport, server: httpServer(pageId) });
  if (draft) {
    try {
      Y.applyUpdate(doc, draft, RECONCILE);
    } catch {
      clearLiveDraft(pageId);
    }
  }
  bind(options.view, session, base);
  const local = options.title();
  const pendingTitle = options.replacement?.pendingTitle ?? null;
  if (pendingTitle !== null && pendingTitle === local) session.setTitle(local, true);
  else if (local !== knownTitle(options.page)) session.setTitle(local);
  const stop = watch(pageId, options.view, session);
  current = { pageId, view: options.view, session, stop, options: { ...options, base: undefined, replacement: undefined } };
  useDocsStore.getState().setUnavailable(pageId, false);
  session.start();
  if (options.replacement) void session.sync();
  return true;
}

function fallBack(session: LiveSession<PageSummary>) {
  const found = current;
  if (!found || found.session !== session) return;
  const store = useDocsStore.getState();
  adoptLiveBase(found.pageId, { revision: session.serverRevision, title: store.summaries[found.pageId]?.title ?? found.options.page.title, body: session.serverText });
  current = null;
  unbind(found.view);
  found.stop();
  void session.close({ save: false });
  found.options.onLost?.();
  clearLiveDraft(found.pageId);
}

function rebuild(session: LiveSession<PageSummary>) {
  const found = current;
  if (!found || found.session !== session) return;
  const base = session.serverText;
  const replacement = session.replacement ?? undefined;
  current = null;
  unbind(found.view);
  found.stop();
  clearLiveDraft(found.pageId);
  void session.close({ save: false });
  const lost = () => {
    if (!found.options.isCurrent()) return;
    adoptLiveBase(found.pageId, { revision: session.serverRevision, title: useDocsStore.getState().summaries[found.pageId]?.title ?? found.options.page.title, body: base });
    found.options.onLost?.();
  };
  void attachLive({ ...found.options, cached: null, base, replacement })
    .then((attached) => {
      if (!attached) lost();
    })
    .catch(lost);
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
  const protect = () => {
    if (!keepDraft(pageId, session)) store().setSave(pageId, "warning", NOT_KEPT);
  };
  const failed = (failure: LiveFailure) => {
    if (failure.fallback) {
      fallBack(session);
      return;
    }
    protect();
    if (failure.final) {
      store().setUnavailable(pageId, true);
      store().setSave(pageId, "error", UNAVAILABLE);
      lock(view);
      return;
    }
    store().setSave(pageId, "error", failure.status === 401 ? SIGNED_OUT : failure.message);
  };
  const offStatus = session.subscribe(() => {
    if (session.status !== lastStatus) {
      lastStatus = session.status;
      store().setLive(pageId, session.status);
      if (session.status === "stopped" && session.failure) failed(session.failure);
      else if (session.status === "offline" && session.unconfirmed()) store().setSave(pageId, "offline", WILL_SYNC);
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
  const offRebuilt = session.onRebuilt(() => rebuild(session));
  const offTrust = onTrustChange((id) => {
    if (id === pageId) pushPresence();
  });
  const offText = session.onText((origin) => {
    const local = origin !== REMOTE && origin !== SERVER;
    if (local && !session.failure) store().setSave(pageId, "pending");
    if (!summaryTimer) {
      summaryTimer = setTimeout(() => {
        summaryTimer = null;
        store().editLocal(pageId, session.title, session.text.toString(), local ? undefined : null);
      }, SUMMARY_EVERY_MS);
    }
    if (session.unconfirmed() && !draftTimer) {
      draftTimer = setTimeout(() => {
        draftTimer = null;
        if (session.unconfirmed()) protect();
      }, DRAFT_EVERY_MS);
    }
  });
  const onVisible = () => {
    if (document.visibilityState === "visible") {
      session.wake();
      return;
    }
    if (session.unconfirmed()) protect();
    void session.flush(true);
  };
  const onOnline = () => {
    session.checkStatus();
    session.wake();
  };
  const onOffline = () => session.checkStatus();
  const onShow = (event: PageTransitionEvent) => {
    if (event.persisted) session.show();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  window.addEventListener("pageshow", onShow);
  const unregister = registerLiveNote(pageId, {
    flush: (keepalive) => session.flush(keepalive),
    leave: () => {
      session.hide();
      if (session.unconfirmed()) protect();
      session.lastChance();
    },
  });
  store().setLive(pageId, session.status);
  return () => {
    stopped = true;
    if (summaryTimer) clearTimeout(summaryTimer);
    if (draftTimer) clearTimeout(draftTimer);
    offStatus();
    offSaved();
    offTitle();
    offRebuilt();
    offTrust();
    offText();
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("pageshow", onShow);
    unregister();
    publishPresence(pageId, null);
    store().setLive(pageId, null);
  };
}

export function detachLive(pageId: string, options: { save?: boolean } = {}): CachedLive | null {
  if (!current || current.pageId !== pageId) return null;
  const { view, session, stop } = current;
  current = null;
  unbind(view);
  stop();
  keepDraft(pageId, session);
  const reusable = !session.failure?.final && !session.rebuilt;
  const cached: CachedLive | null = reusable
    ? {
        doc: session.doc,
        serverVector: session.serverState,
        serverText: session.serverText,
        revision: session.revision,
        generation: session.generation,
        title: session.title,
        base: session.text.toString(),
        own: session.ownClocks(),
      }
    : null;
  if (options.save === false) {
    void session.close({ save: false });
    return cached;
  }
  void session.close().then(() => {
    const store = useDocsStore.getState();
    if (session.unconfirmed()) {
      if (!keepDraft(pageId, session)) store.setSave(pageId, "warning", NOT_KEPT);
      else if (!session.failure) store.setSave(pageId, "offline", WILL_SYNC);
    } else {
      clearLiveDraft(pageId);
      if (!session.failure) store.setSave(pageId, "saved");
    }
  });
  return cached;
}

export async function watchLiveActivity(
  source: LiveTransportKind | LiveTransport,
  scope: { workspaceId: string; userId: string },
  listener: (pageId: string, writer: Participant, writing: boolean, revision?: number) => void,
  onJoined: (joined: boolean) => void,
) {
  const transport = typeof source === "string" ? await transportFor(source).catch(() => null) : source;
  if (!transport) {
    onJoined(false);
    return () => {};
  }
  let closed = false;
  const joined = new Set<string>();
  const topics = [workspaceTopic(scope.workspaceId), personTopic(scope.userId)];
  const channels = topics.map((topic) =>
    transport.open(topic, {
      message: (event, payload) => {
        if (closed || event !== "writing" || !payload || typeof payload !== "object") return;
        const message = payload as WritingMessage;
        if (typeof message.pageId !== "string" || !message.user || typeof message.user.id !== "string") return;
        const writing = message.writing === true;
        trustWriter(message.pageId, message.user.id, writing);
        if (!writing && typeof message.revision === "number" && current?.pageId === message.pageId && message.revision > current.session.revision) void current.session.pull();
        listener(message.pageId, liveParticipant(message.user, scope.userId), writing, message.revision);
      },
      status: (status) => {
        if (closed) return;
        if (status === "joined") joined.add(topic);
        else joined.delete(topic);
        onJoined(joined.size === topics.length);
      },
    }),
  );
  return () => {
    closed = true;
    for (const channel of channels) channel.close();
  };
}
