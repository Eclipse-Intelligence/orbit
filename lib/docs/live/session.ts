import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";
import {
  docTopic,
  LIVE_MESSAGE_MAX,
  type AwarenessMessage,
  type HelloMessage,
  type LiveAwareness,
  type LiveEvent,
  type LiveUser,
  type SavedMessage,
  type StateMessage,
  type TitleMessage,
  type UpdateMessage,
} from "@/lib/docs/live/protocol";
import type { LiveChannel, LiveTransport } from "@/lib/docs/live/transport";
import { decodeBytes, encodeBytes, isEmptyUpdate, liveText, relativeAt } from "@/lib/docs/live/ydoc";

export const REMOTE = "remote";
export const SERVER = "server-sync";
export const RECONCILE = "reconcile";
export const TOO_LONG = "too_long";
export const LIVE_TOO_LARGE = "live_too_large";
export const LIVE_INVALID = "live_invalid";
export const KEEPALIVE_MAX = 60_000;

const LEAVE = "leave";
const TERMINAL_STATUSES = new Set([400, 401, 403, 404, 409, 413]);

export type LiveStatus = "connecting" | "live" | "solo" | "offline" | "stopped";

type SyncInput = { update: Uint8Array | null; vector: Uint8Array; title?: string; generation?: number; keepalive?: boolean };
export type SyncReply<Summary = unknown> = {
  vector: Uint8Array;
  missing: Uint8Array;
  revision: number;
  title?: string;
  generation?: number;
  rebuilt?: boolean;
  summary?: Summary;
};
export type LiveServer<Summary = unknown> = { sync: (input: SyncInput) => Promise<SyncReply<Summary>> };

export type LiveFailure = { status: number | null; code: string; message: string; final: boolean; fallback: boolean };
export type Replacement = { state: Uint8Array | null; revision: number; generation: number | null; title: string | null; pendingTitle: string | null };

export class LiveSyncError extends Error {
  readonly status: number | null;
  readonly code: string;

  constructor(message: string, status: number | null, code?: string) {
    super(message);
    this.name = "LiveSyncError";
    this.status = status;
    this.code = code ?? (status === null ? "offline" : String(status));
  }
}

export function failureOf(error: unknown): LiveFailure | null {
  if (!error || typeof error !== "object") return null;
  const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : null;
  const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : status === null ? "offline" : String(status);
  if (code !== TOO_LONG && (status === null || !TERMINAL_STATUSES.has(status))) return null;
  const message = error instanceof Error && error.message ? error.message : "Couldn't save.";
  return { status, code, message, final: status === 403 || status === 404, fallback: code === LIVE_TOO_LARGE || code === LIVE_INVALID };
}

export async function openSettled<Opened extends { revision: number }>(
  settle: () => Promise<{ base: string; revision: number } | null>,
  open: () => Promise<Opened>,
  isCurrent: () => boolean,
  tries = 3,
): Promise<(Opened & { base: string }) | null> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const before = await settle();
    if (!before || !isCurrent()) return null;
    const opened = await open();
    if (!isCurrent()) return null;
    const after = await settle();
    if (!after || !isCurrent()) return null;
    if (after.revision === before.revision && opened.revision >= after.revision) return { ...opened, base: after.base };
  }
  return null;
}

export type SessionTiming = {
  batchMs: number;
  awarenessMs: number;
  saveMs: number;
  saveMaxMs: number;
  ownMs: number;
  titleMs: number;
  heartbeatMs: number;
  soloHeartbeatMs: number;
  soloMaxMs: number;
  retryMs: number;
  connectMs: number;
  hintMs: number;
  hintGapMs: number;
};

const DEFAULT_TIMING: SessionTiming = {
  batchMs: 80,
  awarenessMs: 120,
  saveMs: 1_200,
  saveMaxMs: 4_000,
  ownMs: 6_000,
  titleMs: 800,
  heartbeatMs: 30_000,
  soloHeartbeatMs: 8_000,
  soloMaxMs: 60_000,
  retryMs: 2_000,
  connectMs: 8_000,
  hintMs: 250,
  hintGapMs: 1_000,
};

export type RemoteState = { clientId: number; state: LiveAwareness };

type Options<Summary> = {
  pageId: string;
  user: LiveUser;
  doc: Y.Doc;
  serverVector: Uint8Array;
  serverText?: string;
  revision: number;
  generation?: number | null;
  title: string;
  own?: Iterable<[number, number]>;
  transport: LiveTransport | null;
  server: LiveServer<Summary>;
  timing?: Partial<SessionTiming>;
};

type Timer = ReturnType<typeof setTimeout>;

type SyncContext = { seqAtStart: number; remoteAtStart: number; title: string | undefined; sent: boolean };

export class LiveSession<Summary = unknown> {
  readonly pageId: string;
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly user: LiveUser;
  status: LiveStatus = "connecting";
  revision: number;
  title: string;
  generation: number | null;
  failure: LiveFailure | null = null;
  rebuilt = false;
  replacement: Replacement | null = null;
  private readonly timing: SessionTiming;
  private readonly transport: LiveTransport | null;
  private readonly server: LiveServer<Summary>;
  private channel: LiveChannel | null = null;
  private channelToken: symbol | null = null;
  private joined = false;
  private reachable = true;
  private settled = false;
  private settleTimer: Timer | null = null;
  private closed = false;
  private serverVector: Uint8Array;
  private confirmedText: string;
  private confirmedRevision: number;
  private pending: Uint8Array[] = [];
  private awarenessDirty = false;
  private flushTimer: Timer | null = null;
  private awarenessTimer: Timer | null = null;
  private saveTimer: Timer | null = null;
  private ownTimer: Timer | null = null;
  private titleTimer: Timer | null = null;
  private heartbeat: Timer | null = null;
  private heartbeatWait = 0;
  private retryTimer: Timer | null = null;
  private hintTimer: Timer | null = null;
  private resumeTimer: Timer | null = null;
  private lastHint = 0;
  private retries = 0;
  private quietBeats = 0;
  private dirtySince: number | null = null;
  private ownSeq = 0;
  private confirmedSeq = 0;
  private remoteSeq = 0;
  private keptAlive: number | null = null;
  private own = new Map<number, number>();
  private titleDirty = false;
  private syncing: Promise<void> | null = null;
  private syncAgain = false;
  private listeners = new Set<() => void>();
  private savedListeners = new Set<(reply: SyncReply<Summary>) => void>();
  private titleListeners = new Set<(title: string) => void>();
  private textListeners = new Set<(origin: unknown) => void>();
  private rebuiltListeners = new Set<() => void>();

  constructor(options: Options<Summary>) {
    this.pageId = options.pageId;
    this.doc = options.doc;
    this.user = options.user;
    this.serverVector = options.serverVector;
    this.confirmedText = options.serverText ?? liveText(options.doc).toString();
    this.revision = options.revision;
    this.confirmedRevision = options.revision;
    this.generation = options.generation ?? null;
    this.title = options.title;
    this.transport = options.transport;
    this.server = options.server;
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    for (const [client, clock] of options.own ?? []) this.own.set(client, clock);
    this.awareness = new Awareness(this.doc);
    this.awareness.setLocalState(this.localState());
    this.doc.on("update", this.onUpdate);
    this.awareness.on("update", this.onAwareness);
    this.awareness.on("change", this.onPresence);
  }

  get text() {
    return liveText(this.doc);
  }

  get clientId() {
    return this.awareness.clientID;
  }

  get serverState() {
    return this.serverVector;
  }

  get serverText() {
    return this.confirmedText;
  }

  get serverRevision() {
    return this.confirmedRevision;
  }

  ownClocks(): [number, number][] {
    return [...this.own];
  }

  start() {
    if (this.closed) return;
    if (this.transport) {
      this.openChannel();
      this.settleTimer = setTimeout(() => {
        this.settleTimer = null;
        this.settled = true;
        this.refreshStatus();
      }, this.timing.connectMs);
    } else {
      this.settled = true;
      this.refreshStatus();
    }
    this.armHeartbeat();
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onSaved(listener: (reply: SyncReply<Summary>) => void) {
    this.savedListeners.add(listener);
    return () => {
      this.savedListeners.delete(listener);
    };
  }

  onTitle(listener: (title: string) => void) {
    this.titleListeners.add(listener);
    return () => {
      this.titleListeners.delete(listener);
    };
  }

  onText(listener: (origin: unknown) => void) {
    this.textListeners.add(listener);
    return () => {
      this.textListeners.delete(listener);
    };
  }

  onRebuilt(listener: () => void) {
    this.rebuiltListeners.add(listener);
    return () => {
      this.rebuiltListeners.delete(listener);
    };
  }

  remoteStates(): RemoteState[] {
    const out: RemoteState[] = [];
    for (const [clientId, state] of this.awareness.getStates()) {
      if (clientId === this.clientId || !state || typeof state !== "object" || !("user" in state)) continue;
      const user = (state as LiveAwareness).user;
      if (!user || typeof user !== "object" || typeof user.id !== "string") continue;
      out.push({ clientId, state: state as LiveAwareness });
    }
    return out;
  }

  isSaver() {
    let lowest = this.clientId;
    for (const [clientId, state] of this.awareness.getStates()) {
      if (state && (state as LiveAwareness).saver && clientId < lowest) lowest = clientId;
    }
    return lowest === this.clientId;
  }

  unconfirmed() {
    return this.ownSeq > this.confirmedSeq || this.titleDirty || this.ownBeyond(this.serverVector);
  }

  titlePending() {
    return this.titleDirty || this.titleTimer !== null;
  }

  setCursor(selection: { anchor: number; head: number } | null) {
    if (this.closed) return;
    const cursor = selection ? { anchor: relativeAt(this.doc, selection.anchor, 0), head: relativeAt(this.doc, selection.head, 0) } : null;
    this.awareness.setLocalStateField("cursor", cursor);
  }

  setTitle(title: string, force = false) {
    if (this.closed || (title === this.title && !force)) return;
    this.title = title;
    this.titleDirty = true;
    if (this.titleTimer) clearTimeout(this.titleTimer);
    this.titleTimer = setTimeout(() => {
      this.titleTimer = null;
      if (this.failure) this.scheduleResume();
      else void this.sync();
    }, this.timing.titleMs);
    this.emit();
  }

  checkStatus() {
    this.refreshStatus();
  }

  wake() {
    if (this.closed || this.failure || this.rebuilt) return;
    if (this.joined) this.sendHello();
    void this.sync();
  }

  pull() {
    if (this.failure || this.rebuilt) return Promise.resolve();
    return this.sync();
  }

  flush(keepalive = false) {
    this.flushBroadcast();
    if (this.failure || this.rebuilt) return Promise.resolve();
    if (keepalive && this.lastChance()) return Promise.resolve();
    return this.runSync(keepalive);
  }

  needsSave() {
    return this.unconfirmed() || (this.isSaver() && this.dirtySince !== null);
  }

  lastChance() {
    if (this.closed || this.rebuilt || this.failure?.final) return false;
    this.flushBroadcast();
    if (!this.needsSave()) return false;
    if (this.keptAlive === this.ownSeq && !this.titleDirty) return true;
    const update = Y.encodeStateAsUpdate(this.doc, this.serverVector);
    const vector = Y.encodeStateVector(this.doc);
    const title = this.titleDirty ? this.title : undefined;
    if (encodeBytes(update).length + encodeBytes(vector).length + (title?.length ?? 0) > KEEPALIVE_MAX) return false;
    const context: SyncContext = { seqAtStart: this.ownSeq, remoteAtStart: this.remoteSeq, title, sent: !isEmptyUpdate(update) };
    const seq = this.ownSeq;
    this.keptAlive = seq;
    void this.server
      .sync({ update: context.sent ? update : null, vector, ...(title !== undefined ? { title } : {}), ...this.generationField(), keepalive: true })
      .then((reply) => this.adopt(reply, context))
      .catch(() => {
        if (this.keptAlive === seq) this.keptAlive = null;
      });
    return true;
  }

  hide() {
    if (this.closed) return;
    this.flushBroadcast();
    this.announceLeave();
  }

  show() {
    if (this.closed || this.failure || this.rebuilt) return;
    if (this.awareness.getLocalState() === null) this.awareness.setLocalState(this.localState());
    this.wake();
  }

  draftDelta(maxBytes: number): Uint8Array | null {
    const full = Y.encodeStateAsUpdate(this.doc, this.serverVector);
    if (full.length <= maxBytes) return full;
    try {
      const vector = Y.decodeStateVector(Y.encodeStateVector(this.doc));
      const server = Y.decodeStateVector(this.serverVector);
      for (const client of this.own.keys()) vector.set(client, server.get(client) ?? 0);
      const mine = Y.encodeStateAsUpdate(this.doc, Y.encodeStateVector(vector));
      return mine.length <= maxBytes ? mine : null;
    } catch {
      return null;
    }
  }

  async close(options: { save?: boolean } = {}) {
    if (this.closed) return;
    this.flushBroadcast();
    const save = options.save !== false && !this.rebuilt && !this.failure;
    this.closed = true;
    this.clearTimers();
    this.announceLeave();
    if (save) {
      if (this.syncing) await this.syncing.catch(() => {});
      if (this.needsSave() && !this.failure) await this.runSync(false).catch(() => {});
    }
    this.leaveChannel();
    this.doc.off("update", this.onUpdate);
    this.awareness.off("update", this.onAwareness);
    this.awareness.off("change", this.onPresence);
    this.awareness.destroy();
  }

  sync(): Promise<void> {
    return this.runSync(false);
  }

  private localState(): LiveAwareness {
    return { user: this.user, saver: true, cursor: null };
  }

  private generationField() {
    return this.generation === null ? {} : { generation: this.generation };
  }

  private clearTimers() {
    for (const timer of [
      this.flushTimer,
      this.awarenessTimer,
      this.saveTimer,
      this.ownTimer,
      this.titleTimer,
      this.heartbeat,
      this.retryTimer,
      this.settleTimer,
      this.hintTimer,
      this.resumeTimer,
    ]) {
      if (timer) clearTimeout(timer);
    }
    this.flushTimer = this.awarenessTimer = this.saveTimer = this.ownTimer = this.titleTimer = null;
    this.heartbeat = this.retryTimer = this.settleTimer = this.hintTimer = this.resumeTimer = null;
  }

  private openChannel() {
    if (!this.transport || this.channel) return;
    const token = Symbol("channel");
    this.channelToken = token;
    this.channel = this.transport.open(docTopic(this.pageId), {
      message: (event, payload) => {
        if (this.channelToken === token) this.receive(event, payload);
      },
      status: (status) => {
        if (this.channelToken !== token) return;
        if (status === "joined") this.onJoined();
        else if (status === "closed") {
          this.joined = false;
          this.settled = true;
          this.refreshStatus();
          this.armHeartbeat();
        }
      },
    });
  }

  private announceLeave() {
    if (!this.joined || !this.channel || this.awareness.getLocalState() === null) return;
    removeAwarenessStates(this.awareness, [this.clientId], LEAVE);
    this.channel.send("awareness", { a: encodeBytes(encodeAwarenessUpdate(this.awareness, [this.clientId])) } satisfies AwarenessMessage);
  }

  private leaveChannel() {
    this.announceLeave();
    const channel = this.channel;
    this.channel = null;
    this.channelToken = null;
    this.joined = false;
    channel?.close();
  }

  private ownBeyond(vector: Uint8Array) {
    if (this.own.size === 0) return false;
    try {
      const server = Y.decodeStateVector(vector);
      for (const [client, clock] of this.own) if ((server.get(client) ?? 0) < clock) return true;
    } catch {
      return true;
    }
    return false;
  }

  private noteOwn(update: Uint8Array) {
    try {
      for (const [client, clock] of Y.parseUpdateMeta(update).to) if (clock > (this.own.get(client) ?? 0)) this.own.set(client, clock);
    } catch {}
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  private refreshStatus() {
    const browserOffline = typeof navigator !== "undefined" && navigator.onLine === false;
    const next: LiveStatus = this.failure
      ? "stopped"
      : !this.reachable || browserOffline
        ? "offline"
        : this.joined
          ? "live"
          : this.transport && !this.settled
            ? "connecting"
            : "solo";
    if (next !== this.status) {
      this.status = next;
      this.emit();
    }
  }

  private onUpdate = (update: Uint8Array, origin: unknown) => {
    if (this.closed) return;
    if (origin === SERVER) {
      for (const listener of this.textListeners) listener(origin);
      return;
    }
    if (origin === REMOTE) {
      this.remoteSeq += 1;
      this.markDirty();
      for (const listener of this.textListeners) listener(origin);
      return;
    }
    this.ownSeq += 1;
    this.noteOwn(update);
    this.quietBeats = 0;
    if (this.failure || this.rebuilt) {
      this.scheduleResume();
    } else {
      this.pending.push(update);
      this.scheduleFlush();
      this.markDirty();
      this.watchOwn();
      if (!this.joined && this.heartbeatWait > this.timing.soloHeartbeatMs) this.armHeartbeat();
    }
    for (const listener of this.textListeners) listener(origin);
  };

  private onAwareness = (_changes: unknown, origin: unknown) => {
    if (origin !== "local" || this.closed) return;
    this.awarenessDirty = true;
    if (this.awarenessTimer) return;
    this.awarenessTimer = setTimeout(() => {
      this.awarenessTimer = null;
      this.flushBroadcast();
    }, this.timing.awarenessMs);
  };

  private onPresence = () => {
    if (this.isSaver() && this.dirtySince !== null && !this.saveTimer) this.markDirty();
    this.emit();
  };

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushBroadcast();
    }, this.timing.batchMs);
  }

  private flushBroadcast() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.awarenessTimer) {
      clearTimeout(this.awarenessTimer);
      this.awarenessTimer = null;
    }
    const updates = this.pending;
    this.pending = [];
    const sendAwareness = this.awarenessDirty;
    this.awarenessDirty = false;
    if (!this.joined || !this.channel || this.closed || this.failure) return;
    const a = sendAwareness ? encodeBytes(encodeAwarenessUpdate(this.awareness, [this.clientId])) : undefined;
    if (updates.length === 0) {
      if (a) this.channel.send("awareness", { a } satisfies AwarenessMessage);
      return;
    }
    const u = encodeBytes(updates.length === 1 ? updates[0] : Y.mergeUpdates(updates));
    if (u.length > LIVE_MESSAGE_MAX) {
      if (a) this.channel.send("awareness", { a } satisfies AwarenessMessage);
      void this.sync().then(() => {
        if (this.joined && this.channel) this.channel.send("pull", {});
      });
      return;
    }
    this.channel.send("update", { u, a, c: this.clientId, s: this.ownSeq, ...this.generationTag() } satisfies UpdateMessage);
  }

  private generationTag() {
    return this.generation === null ? {} : { g: this.generation };
  }

  private markDirty() {
    if (this.closed) return;
    const now = Date.now();
    this.dirtySince ??= now;
    if (!this.isSaver() || this.failure || this.rebuilt) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    const wait = Math.max(0, Math.min(this.timing.saveMs, this.timing.saveMaxMs - (now - this.dirtySince)));
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.sync();
    }, wait);
  }

  private watchOwn() {
    if (this.ownTimer || this.closed) return;
    this.ownTimer = setTimeout(() => {
      this.ownTimer = null;
      if (this.unconfirmed()) void this.sync();
    }, this.timing.ownMs);
  }

  private scheduleResume() {
    if (this.closed || this.rebuilt || this.failure?.final || this.failure?.fallback || this.resumeTimer) return;
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      void this.runSync(false);
    }, this.timing.saveMs);
  }

  private armHeartbeat() {
    if (this.heartbeat) clearTimeout(this.heartbeat);
    this.heartbeat = null;
    if (this.closed || this.failure || this.rebuilt) return;
    const busy = this.unconfirmed() || this.dirtySince !== null;
    const wait = this.joined
      ? this.timing.heartbeatMs
      : busy
        ? this.timing.soloHeartbeatMs
        : Math.min(this.timing.soloMaxMs, this.timing.soloHeartbeatMs * 2 ** Math.min(this.quietBeats, 6));
    this.heartbeatWait = wait;
    this.heartbeat = setTimeout(() => {
      this.heartbeat = null;
      if (typeof document === "undefined" || document.visibilityState !== "hidden") void this.sync();
      this.armHeartbeat();
    }, wait);
  }

  private onJoined() {
    this.joined = true;
    this.settled = true;
    this.refreshStatus();
    this.sendHello();
    this.awarenessDirty = true;
    if (this.unconfirmed()) {
      const delta = Y.encodeStateAsUpdate(this.doc, this.serverVector);
      this.pending = [delta];
    }
    this.flushBroadcast();
    this.armHeartbeat();
    void this.sync();
  }

  private sendHello() {
    this.channel?.send("hello", { c: this.clientId, sv: encodeBytes(Y.encodeStateVector(this.doc)), ...this.generationTag() } satisfies HelloMessage);
  }

  private foreign(generation: unknown) {
    if (typeof generation !== "number" || this.generation === null || generation === this.generation) return false;
    this.hint(true);
    return true;
  }

  private receive(event: LiveEvent, payload: unknown) {
    if (this.closed || this.failure || this.rebuilt || !payload || typeof payload !== "object") return;
    try {
      this.handle(event, payload);
    } catch {}
  }

  private handle(event: LiveEvent, payload: object) {
    switch (event) {
      case "hello": {
        const hello = payload as HelloMessage;
        if (this.foreign(hello.g)) return;
        const vector = decodeBytes(hello.sv);
        if (this.isSaver() && vector && typeof hello.c === "number") {
          const diff = Y.encodeStateAsUpdate(this.doc, vector);
          const u = encodeBytes(diff);
          if (!isEmptyUpdate(diff) && u.length <= LIVE_MESSAGE_MAX) this.channel?.send("state", { to: hello.c, u, ...this.generationTag() } satisfies StateMessage);
        }
        this.awarenessDirty = true;
        this.flushBroadcast();
        return;
      }
      case "state": {
        const state = payload as StateMessage;
        if (state.to !== this.clientId || this.foreign(state.g)) return;
        this.applyRemote(decodeBytes(state.u));
        return;
      }
      case "update": {
        const message = payload as UpdateMessage;
        if (this.foreign(message.g)) return;
        this.applyRemote(decodeBytes(message.u));
        this.applyAwareness(decodeBytes(message.a));
        return;
      }
      case "awareness":
        this.applyAwareness(decodeBytes((payload as AwarenessMessage).a));
        return;
      case "saved": {
        const saved = payload as SavedMessage;
        if (this.foreign(saved.g)) return;
        const vector = decodeBytes(saved.sv);
        this.hint(false, vector);
        return;
      }
      case "pull":
      case "title":
        this.hint(true);
        return;
      default:
        return;
    }
  }

  private applyAwareness(update: Uint8Array | null) {
    if (!update) return;
    try {
      applyAwarenessUpdate(this.awareness, update, REMOTE);
    } catch {}
  }

  private hint(always: boolean, vector: Uint8Array | null = null) {
    if (always || this.unconfirmed() || (vector && this.behind(vector))) {
      this.hintSync();
      return;
    }
    if (!this.isSaver()) this.dirtySince = null;
    this.emit();
  }

  private hintSync() {
    if (this.hintTimer || this.closed || this.failure || this.rebuilt) return;
    const wait = Math.max(this.timing.hintMs, this.lastHint + this.timing.hintGapMs - Date.now());
    this.hintTimer = setTimeout(() => {
      this.hintTimer = null;
      this.lastHint = Date.now();
      void this.sync();
    }, wait);
  }

  private behind(vector: Uint8Array) {
    try {
      const local = Y.decodeStateVector(Y.encodeStateVector(this.doc));
      for (const [clientId, clock] of Y.decodeStateVector(vector)) if ((local.get(clientId) ?? 0) < clock) return true;
    } catch {}
    return false;
  }

  private applyRemote(update: Uint8Array | null, origin: string = REMOTE) {
    if (!update) return;
    try {
      Y.applyUpdate(this.doc, update, origin);
    } catch {
      this.hint(true);
    }
  }

  private isRebuilt(reply: SyncReply<Summary>) {
    if (reply.rebuilt === true) return true;
    return typeof reply.generation === "number" && this.generation !== null && reply.generation !== this.generation;
  }

  private markRebuilt(reply: SyncReply<Summary>, context: SyncContext) {
    if (this.rebuilt) return;
    this.rebuilt = true;
    this.replacement = {
      state: reply.rebuilt === true && reply.missing && !isEmptyUpdate(reply.missing) ? reply.missing : null,
      revision: reply.revision,
      generation: typeof reply.generation === "number" ? reply.generation : null,
      title: reply.title ?? null,
      pendingTitle: context.title ?? (this.titleDirty ? this.title : null),
    };
    this.clearTimers();
    this.leaveChannel();
    this.emit();
    for (const listener of this.rebuiltListeners) listener();
  }

  private adopt(reply: SyncReply<Summary>, context: SyncContext) {
    if (this.rebuilt) return;
    if (this.isRebuilt(reply)) {
      this.markRebuilt(reply, context);
      return;
    }
    if (typeof reply.generation === "number") this.generation = reply.generation;
    this.serverVector = reply.vector;
    this.revision = Math.max(this.revision, reply.revision);
    if (reply.missing && !isEmptyUpdate(reply.missing) && !this.closed) {
      this.applyRemote(reply.missing, SERVER);
      this.quietBeats = 0;
    } else {
      this.quietBeats += 1;
    }
    this.confirmedSeq = Math.max(this.confirmedSeq, context.seqAtStart);
    if (context.title !== undefined && this.title === context.title) this.titleDirty = false;
    if (this.ownSeq === context.seqAtStart && this.remoteSeq === context.remoteAtStart && reply.revision >= this.confirmedRevision) {
      this.confirmedText = this.text.toString();
      this.confirmedRevision = reply.revision;
    }
    this.retries = 0;
    this.reachable = true;
    if (this.failure) {
      this.failure = null;
      if (!this.closed) {
        if (this.awareness.getLocalState() === null) this.awareness.setLocalState(this.localState());
        this.openChannel();
        this.armHeartbeat();
      }
    }
    if (
      reply.title !== undefined &&
      context.title === undefined &&
      !this.titleDirty &&
      !this.titleTimer &&
      reply.title !== this.title
    ) {
      this.title = reply.title;
      for (const listener of this.titleListeners) listener(reply.title);
    }
    if (this.joined && this.channel) {
      if (this.isSaver() || context.sent) this.channel.send("saved", { sv: encodeBytes(reply.vector), r: reply.revision, ...this.generationTag() } satisfies SavedMessage);
      if (context.title !== undefined) this.channel.send("title", { t: context.title } satisfies TitleMessage);
    }
    for (const listener of this.savedListeners) listener(reply);
    this.refreshStatus();
    if (!this.joined && !this.closed) this.armHeartbeat();
    this.emit();
  }

  private stop(failure: LiveFailure) {
    this.failure = failure;
    this.clearTimers();
    this.leaveChannel();
    this.refreshStatus();
    this.emit();
  }

  private runSync(keepalive: boolean): Promise<void> {
    if (this.rebuilt || this.failure?.final || this.failure?.fallback) return Promise.resolve();
    if (this.syncing) {
      this.syncAgain = true;
      return this.syncing;
    }
    for (const timer of [this.saveTimer, this.retryTimer, this.resumeTimer]) if (timer) clearTimeout(timer);
    this.saveTimer = this.retryTimer = this.resumeTimer = null;
    const update = Y.encodeStateAsUpdate(this.doc, this.serverVector);
    const vector = Y.encodeStateVector(this.doc);
    const title = this.titleDirty ? this.title : undefined;
    const context: SyncContext = { seqAtStart: this.ownSeq, remoteAtStart: this.remoteSeq, title, sent: !isEmptyUpdate(update) };
    this.titleDirty = false;
    const wasDirty = this.dirtySince;
    this.dirtySince = null;
    const run = this.server
      .sync({ update: context.sent ? update : null, vector, ...(title !== undefined ? { title } : {}), ...this.generationField(), keepalive })
      .then((reply) => this.adopt(reply, context))
      .catch((error: unknown) => {
        if (title !== undefined && this.title === title) this.titleDirty = true;
        this.dirtySince ??= wasDirty ?? Date.now();
        const failure = failureOf(error);
        if (failure) {
          this.stop(failure);
          return;
        }
        this.reachable = false;
        this.refreshStatus();
        this.emit();
        if (this.closed) return;
        this.retries += 1;
        this.retryTimer = setTimeout(
          () => {
            this.retryTimer = null;
            void this.sync();
          },
          Math.min(30_000, this.timing.retryMs * 2 ** Math.min(this.retries - 1, 4)),
        );
      })
      .finally(() => {
        this.syncing = null;
        if (this.syncAgain && !this.closed && !this.failure) {
          this.syncAgain = false;
          void this.sync();
        }
        this.syncAgain = false;
      });
    this.syncing = run;
    return run;
  }
}
