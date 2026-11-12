import type { EditorView } from "@codemirror/view";
import * as Y from "yjs";
import type { Presence } from "@/lib/docs/client-types";
import { setPresence } from "@/lib/docs/editor/presence";
import { applyToText, bind, unbind } from "@/lib/docs/live/binding";
import { rebase } from "@/lib/docs/live/rebase";
import { draftTopic, type LiveTransportKind, type LiveUser } from "@/lib/docs/live/protocol";
import { relayTransport } from "@/lib/docs/live/relay-transport";
import { KEEPALIVE_MAX, LiveSession, LiveSyncError, type LiveServer, type LiveStatus, type SyncReply } from "@/lib/docs/live/session";
import { supabaseTransport } from "@/lib/docs/live/supabase-transport";
import type { LiveTransport } from "@/lib/docs/live/transport";
import { absoluteFrom, createLiveDoc, decodeBytes, encodeBytes } from "@/lib/docs/live/ydoc";
import { liveParticipant } from "@/lib/docs/participants";

export type LiveDraftSummary = { version: number; locked: string | null };

export type LiveDraftStatus = LiveStatus | "opening";

type Payload = {
  vector?: string;
  missing?: string;
  state?: string;
  generation?: number;
  rebuilt?: boolean;
  version?: number;
  locked?: string | null;
  transport?: LiveTransportKind | null;
  error?: string;
  code?: string;
};

type Options = {
  shareId: string;
  user: LiveUser;
  base: string;
  onLocked?: (message: string | null) => void;
  onStatus?: (status: LiveDraftStatus) => void;
  onFailure?: (message: string) => void;
};

type Opened = { state: Uint8Array; generation: number; version: number; locked: string | null; transport: LiveTransportKind | null };

export const LIVE_SEND_FAILED = "Couldn't send. Try again.";
const UNREACHABLE = "Couldn't reach Orbit. Try again.";
const UNREADABLE = "Couldn't read Orbit's reply. Try again.";
const SIGNED_OUT = "Your session ended. Sign in again.";
const RETRY_OPEN_MS = 3_000;
const RETRY_OPEN_MAX_MS = 30_000;
export const LIVE_NOT_SAVED = "Couldn't save the draft. Try again.";
const EMPTY_UPDATE = new Uint8Array([0, 0]);

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

function liveUrl(shareId: string) {
  return `/api/mail/shared/${encodeURIComponent(shareId)}/live`;
}

async function request(url: string, init: RequestInit) {
  try {
    return await fetch(url, { cache: "no-store", credentials: "same-origin", ...init });
  } catch {
    throw new LiveSyncError(UNREACHABLE, null);
  }
}

async function readPayload(response: Response) {
  const payload = (await response.json().catch(() => null)) as Payload | null;
  if (!response.ok || !payload) throw new LiveSyncError(payload?.error || (response.status === 401 ? SIGNED_OUT : UNREACHABLE), response.status, payload?.code);
  return payload;
}

export function draftPresence(session: LiveSession<LiveDraftSummary>, viewerId: string): Presence[] {
  const out: Presence[] = [];
  for (const { state } of session.remoteStates()) {
    const participant = liveParticipant({ id: state.user.id, name: typeof state.user.name === "string" ? state.user.name.slice(0, 120) : "", kind: "person" }, viewerId);
    const head = state.cursor ? absoluteFrom(session.doc, state.cursor.head) : null;
    const anchor = state.cursor ? absoluteFrom(session.doc, state.cursor.anchor) : null;
    const entry: Presence = { participant, cursor: head, writing: false };
    if (head !== null && anchor !== null && anchor !== head) entry.selection = { from: Math.min(anchor, head), to: Math.max(anchor, head) };
    out.push(entry);
  }
  return out;
}

export function liveDraftCovered(session: LiveSession<LiveDraftSummary>) {
  if (session.unconfirmed()) return false;
  const server = Y.decodeStateVector(session.serverState);
  for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(session.doc))) if ((server.get(client) ?? 0) < clock) return false;
  return true;
}

export class LiveDraft {
  readonly shareId: string;
  version: number | null = null;
  locked: string | null = null;
  status: LiveDraftStatus = "opening";
  private readonly options: Options;
  private view: EditorView | null = null;
  private session: LiveSession<LiveDraftSummary> | null = null;
  private stopWatching: (() => void) | null = null;
  private token = 0;
  private saved = 0;
  private closed = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private waiters = new Set<() => void>();
  private kind: LiveTransportKind | null = null;
  private retained = 0;
  private headless = false;
  private readOnly = false;
  private kept: string | null = null;
  private openDelay = RETRY_OPEN_MS;

  constructor(options: Options) {
    this.shareId = options.shareId;
    this.options = options;
  }

  get current() {
    return this.session;
  }

  get base() {
    return this.options.base;
  }

  attach(view: EditorView) {
    if (this.closed) return;
    this.view = view;
    this.headless = false;
    this.kept = null;
    if (this.session) {
      bind(view, this.session, this.session.text.toString());
      return;
    }
    void this.open(this.options.base, null);
  }

  retain() {
    this.retained += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.retained -= 1;
      if (this.retained === 0 && this.headless) {
        this.headless = false;
        this.detach(false);
      }
    };
  }

  setReadOnly(readOnly: boolean) {
    this.readOnly = readOnly;
    this.applyPause();
  }

  detach(save = true) {
    if (this.retained > 0 && !this.closed) {
      const view = this.view;
      this.view = null;
      this.headless = true;
      if (view && this.session) unbind(view);
      else if (view) this.kept = view.state.doc.toString();
      return;
    }
    this.kept = null;
    this.token += 1;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const view = this.view;
    const session = this.session;
    this.view = null;
    this.session = null;
    this.stopWatching?.();
    this.stopWatching = null;
    if (view && session) unbind(view);
    if (session) void session.close({ save });
    this.wakeWaiters();
  }

  close() {
    this.closed = true;
    this.detach();
    this.setStatus("stopped");
  }

  refresh() {
    void this.session?.pull();
  }

  text() {
    return this.session?.text.toString() ?? null;
  }

  confirmedText() {
    return this.session?.serverText ?? null;
  }

  async flush() {
    const session = this.session;
    if (!session) return;
    const typed = session.typed;
    await session.sync();
    if (!session.failure && !session.confirmedThrough(typed)) await session.sync();
    if (session.failure) throw new Error(session.failure.message);
    if (!session.confirmedThrough(typed)) throw new Error(LIVE_NOT_SAVED);
  }

  async settle(waitMs = 8_000): Promise<number> {
    const session = await this.ready(waitMs);
    if (!session) throw new Error(LIVE_SEND_FAILED);
    const before = this.saved;
    await session.sync();
    await session.sync();
    if (this.session !== session || session.failure || session.rebuilt || this.saved === before || !liveDraftCovered(session) || this.version === null) {
      throw new Error(LIVE_SEND_FAILED);
    }
    return this.version;
  }

  private ready(waitMs: number) {
    if (this.session || this.closed) return Promise.resolve(this.session);
    return new Promise<LiveSession<LiveDraftSummary> | null>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve(this.session);
      };
      const timer = setTimeout(done, waitMs);
      this.waiters.add(done);
    });
  }

  private wakeWaiters() {
    for (const waiter of [...this.waiters]) waiter();
  }

  private setStatus(status: LiveDraftStatus) {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatus?.(status);
  }

  private applyPause() {
    this.session?.pauseUpdates(this.readOnly || this.locked !== null);
  }

  private setLocked(locked: string | null) {
    const was = this.locked;
    this.locked = locked;
    if (was === locked) return;
    this.applyPause();
    this.options.onLocked?.(locked);
  }

  private server(): LiveServer<LiveDraftSummary> {
    const url = liveUrl(this.shareId);
    const post = async (input: Parameters<LiveServer<LiveDraftSummary>["sync"]>[0], strip: boolean): Promise<SyncReply<LiveDraftSummary>> => {
      const body = JSON.stringify({
        update: input.update && !strip ? encodeBytes(input.update) : undefined,
        vector: encodeBytes(input.vector),
        generation: input.generation,
      });
      const response = await request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: input.keepalive === true && body.length < KEEPALIVE_MAX,
      });
      if (response.status === 409 && !strip) {
        const refused = (await response.clone().json().catch(() => null)) as { locked?: unknown; error?: string } | null;
        if (refused?.locked === true) {
          this.setLocked(refused.error ?? "Read only.");
          return post(input, true);
        }
      }
      const payload = await readPayload(response);
      const vector = decodeBytes(payload.vector);
      if (!vector) throw new LiveSyncError(UNREADABLE, 502, "invalid_reply");
      const version = typeof payload.version === "number" ? payload.version : 0;
      const locked = typeof payload.locked === "string" ? payload.locked : null;
      return {
        vector,
        missing: decodeBytes(payload.missing) ?? EMPTY_UPDATE,
        revision: version,
        generation: typeof payload.generation === "number" ? payload.generation : undefined,
        rebuilt: payload.rebuilt === true,
        held: strip && input.update !== null && input.update.length > 2,
        summary: { version, locked },
      };
    };
    return { sync: (input) => post(input, this.locked !== null) };
  }

  private async fetchOpen(): Promise<Opened> {
    const payload = await readPayload(await request(liveUrl(this.shareId), {}));
    const state = decodeBytes(payload.state);
    if (!state) throw new LiveSyncError(UNREADABLE, 502, "invalid_reply");
    return {
      state,
      generation: typeof payload.generation === "number" ? payload.generation : 0,
      version: typeof payload.version === "number" ? payload.version : 0,
      locked: typeof payload.locked === "string" ? payload.locked : null,
      transport: payload.transport ?? null,
    };
  }

  private async open(base: string, replacement: { state: Uint8Array; generation: number; version: number } | null) {
    const token = ++this.token;
    this.setStatus("opening");
    let opened: Opened;
    try {
      opened = replacement ? { ...replacement, locked: this.locked, transport: null } : await this.fetchOpen();
    } catch (error) {
      if (token !== this.token || this.closed) return;
      const status = error instanceof LiveSyncError ? error.status : null;
      if (status === 403 || status === 404 || status === 401) {
        this.options.onFailure?.(error instanceof Error ? error.message : UNREACHABLE);
        this.setStatus("stopped");
        this.wakeWaiters();
        return;
      }
      this.setStatus("offline");
      const delay = this.openDelay;
      this.openDelay = Math.min(RETRY_OPEN_MAX_MS, delay * 2);
      this.retry = setTimeout(() => {
        this.retry = null;
        if (token === this.token && (this.view || this.headless)) void this.open(base, null);
      }, delay);
      return;
    }
    this.openDelay = RETRY_OPEN_MS;
    const kind = opened.transport ?? this.kind;
    this.kind = kind;
    const transport = kind ? await transportFor(kind).catch(() => null) : null;
    const view = this.view;
    if (token !== this.token || this.closed || (!view && !this.headless)) return;
    this.version = opened.version;
    this.setLocked(opened.locked);
    const doc = createLiveDoc(opened.state);
    const session = new LiveSession<LiveDraftSummary>({
      pageId: this.shareId,
      topic: draftTopic(this.shareId),
      user: this.options.user,
      doc,
      serverVector: Y.encodeStateVector(doc),
      revision: opened.version,
      generation: opened.generation,
      title: "",
      transport,
      server: this.server(),
    });
    this.session = session;
    this.applyPause();
    if (view) bind(view, session, base);
    else if (this.kept !== null) {
      const kept = this.kept;
      this.kept = null;
      const shared = session.text.toString();
      if (kept !== shared) {
        const { toShared } = rebase(base, kept, shared);
        if (!toShared.empty) applyToText(doc, session.text, toShared);
      }
    }
    this.stopWatching = this.watch(session);
    session.start();
    if (replacement) void session.sync();
    this.wakeWaiters();
  }

  private watch(session: LiveSession<LiveDraftSummary>) {
    let queued = false;
    let stopped = false;
    const viewerId = this.options.user.id;
    const pushPresence = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (!stopped) this.view?.dispatch({ effects: setPresence.of(draftPresence(session, viewerId)) });
      });
    };
    const offStatus = session.subscribe(() => {
      this.setStatus(session.status);
      if (session.status === "stopped" && session.failure) this.options.onFailure?.(session.failure.message);
      pushPresence();
    });
    const offSaved = session.onSaved((reply) => {
      this.saved += 1;
      if (reply.summary) {
        this.version = reply.summary.version;
        this.setLocked(reply.summary.locked);
      }
    });
    const offRebuilt = session.onRebuilt(() => {
      if (this.session !== session) return;
      const replacement = session.replacement;
      const newDraft = typeof replacement?.generation === "number" && replacement.generation !== session.generation;
      const base = newDraft ? (this.view?.state.doc.toString() ?? session.text.toString()) : session.serverText;
      this.kept = !this.view && !newDraft ? session.text.toString() : null;
      this.stopWatching?.();
      this.stopWatching = null;
      this.session = null;
      if (this.view) unbind(this.view);
      void session.close({ save: false });
      void this.open(base, replacement?.state ? { state: replacement.state, generation: replacement.generation ?? 0, version: replacement.revision } : null);
    });
    const onVisible = () => {
      if (document.visibilityState === "visible") session.wake();
      else void session.flush(true);
    };
    const onOnline = () => {
      session.checkStatus();
      session.wake();
    };
    const onOffline = () => session.checkStatus();
    const onHide = () => {
      session.hide();
      session.lastChance();
    };
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) session.show();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
    return () => {
      stopped = true;
      offStatus();
      offSaved();
      offRebuilt();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
    };
  }
}

export type StoredDraftText = { subject: string; body: string; version: number };

function sameSubject(left: string, right: string) {
  return left.replace(/\s+/g, " ").trim() === right.replace(/\s+/g, " ").trim();
}

export async function settleForSend(live: LiveDraft, shown: { subject: string; body: string }, stored: () => Promise<StoredDraftText>, changed: string): Promise<StoredDraftText> {
  const version = await live.settle();
  const body = live.text();
  const fresh = await stored();
  if (body === null || body !== shown.body || fresh.body !== body || !sameSubject(fresh.subject, shown.subject) || fresh.version < version) throw new Error(changed);
  return { subject: fresh.subject, body, version: fresh.version };
}

export function liveHandBack(live: LiveDraft, shownBody: string) {
  const confirmed = live.confirmedText();
  return { body: live.text() ?? shownBody, base: confirmed ?? live.base, confirmed: confirmed !== null };
}
