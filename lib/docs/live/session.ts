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

export type LiveStatus = "connecting" | "live" | "offline";

type SyncInput = { update: Uint8Array | null; vector: Uint8Array; title?: string; keepalive?: boolean };
export type SyncReply<Summary = unknown> = { vector: Uint8Array; missing: Uint8Array; revision: number; summary?: Summary };
export type LiveServer<Summary = unknown> = { sync: (input: SyncInput) => Promise<SyncReply<Summary>> };

export type SessionTiming = {
  batchMs: number;
  awarenessMs: number;
  saveMs: number;
  saveMaxMs: number;
  ownMs: number;
  titleMs: number;
  heartbeatMs: number;
  soloHeartbeatMs: number;
  retryMs: number;
  connectMs: number;
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
  retryMs: 2_000,
  connectMs: 8_000,
};

export type RemoteState = { clientId: number; state: LiveAwareness };

type Options<Summary> = {
  pageId: string;
  user: LiveUser;
  doc: Y.Doc;
  serverVector: Uint8Array;
  revision: number;
  title: string;
  transport: LiveTransport | null;
  server: LiveServer<Summary>;
  timing?: Partial<SessionTiming>;
};

type Timer = ReturnType<typeof setTimeout>;

export class LiveSession<Summary = unknown> {
  readonly pageId: string;
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly user: LiveUser;
  status: LiveStatus = "connecting";
  revision: number;
  title: string;
  private readonly timing: SessionTiming;
  private readonly transport: LiveTransport | null;
  private readonly server: LiveServer<Summary>;
  private channel: LiveChannel | null = null;
  private joined = false;
  private reachable = true;
  private settled = false;
  private settleTimer: Timer | null = null;
  private closed = false;
  private serverVector: Uint8Array;
  private pending: Uint8Array[] = [];
  private awarenessDirty = false;
  private flushTimer: Timer | null = null;
  private awarenessTimer: Timer | null = null;
  private saveTimer: Timer | null = null;
  private ownTimer: Timer | null = null;
  private titleTimer: Timer | null = null;
  private heartbeat: Timer | null = null;
  private retryTimer: Timer | null = null;
  private retries = 0;
  private dirtySince: number | null = null;
  private ownSeq = 0;
  private confirmedSeq = 0;
  private seen = new Map<number, number>();
  private titleDirty = false;
  private syncing: Promise<void> | null = null;
  private syncAgain = false;
  private listeners = new Set<() => void>();
  private savedListeners = new Set<(reply: SyncReply<Summary>) => void>();
  private titleListeners = new Set<(title: string) => void>();
  private textListeners = new Set<(origin: unknown) => void>();

  constructor(options: Options<Summary>) {
    this.pageId = options.pageId;
    this.doc = options.doc;
    this.user = options.user;
    this.serverVector = options.serverVector;
    this.revision = options.revision;
    this.title = options.title;
    this.transport = options.transport;
    this.server = options.server;
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.awareness = new Awareness(this.doc);
    this.awareness.setLocalState({ user: this.user, saver: true, cursor: null } satisfies LiveAwareness);
    this.doc.on("update", this.onUpdate);
    this.awareness.on("update", this.onAwareness);
    this.awareness.on("change", this.onPresence);
  }

  get text() {
    return liveText(this.doc);
  }

  get clientId() {
    return this.doc.clientID;
  }

  start() {
    if (this.transport) {
      this.channel = this.transport.open(docTopic(this.pageId), {
        message: (event, payload) => this.receive(event, payload),
        status: (status) => {
          if (status === "joined") this.onJoined();
          else if (status === "closed") {
            this.joined = false;
            this.settled = true;
            this.refreshStatus();
            this.armHeartbeat();
          }
        },
      });
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

  remoteStates(): RemoteState[] {
    const out: RemoteState[] = [];
    for (const [clientId, state] of this.awareness.getStates()) {
      if (clientId === this.clientId || !state || typeof state !== "object" || !("user" in state)) continue;
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
    return this.ownSeq > this.confirmedSeq || this.titleDirty;
  }

  setCursor(selection: { anchor: number; head: number } | null) {
    if (this.closed) return;
    const cursor = selection ? { anchor: relativeAt(this.doc, selection.anchor, 0), head: relativeAt(this.doc, selection.head, 0) } : null;
    this.awareness.setLocalStateField("cursor", cursor);
  }

  setTitle(title: string) {
    if (this.closed || title === this.title) return;
    this.title = title;
    this.titleDirty = true;
    if (this.titleTimer) clearTimeout(this.titleTimer);
    this.titleTimer = setTimeout(() => {
      this.titleTimer = null;
      void this.sync();
    }, this.timing.titleMs);
    this.emit();
  }

  wake() {
    if (this.closed) return;
    if (this.joined) this.sendHello();
    void this.sync();
  }

  pull() {
    return this.sync();
  }

  flush(keepalive = false) {
    this.flushBroadcast();
    return this.runSync(keepalive);
  }

  get serverState() {
    return this.serverVector;
  }

  pendingDelta() {
    return Y.encodeStateAsUpdate(this.doc, this.serverVector);
  }

  async close(options: { keepalive?: boolean } = {}) {
    if (this.closed) return;
    this.flushBroadcast();
    const needsSave = this.unconfirmed() || (this.isSaver() && this.dirtySince !== null);
    this.closed = true;
    for (const timer of [this.flushTimer, this.awarenessTimer, this.saveTimer, this.ownTimer, this.titleTimer, this.heartbeat, this.retryTimer, this.settleTimer]) {
      if (timer) clearTimeout(timer);
    }
    removeAwarenessStates(this.awareness, [this.clientId], "local");
    if (this.joined) this.channel?.send("awareness", { a: encodeBytes(encodeAwarenessUpdate(this.awareness, [this.clientId])) } satisfies AwarenessMessage);
    this.channel?.close();
    this.channel = null;
    this.joined = false;
    this.doc.off("update", this.onUpdate);
    this.awareness.off("update", this.onAwareness);
    this.awareness.off("change", this.onPresence);
    this.awareness.destroy();
    if (needsSave) await this.runSync(options.keepalive === true).catch(() => {});
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  private refreshStatus() {
    const next: LiveStatus = this.joined && this.reachable ? "live" : this.reachable && !this.settled ? "connecting" : "offline";
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
      this.markDirty();
      for (const listener of this.textListeners) listener(origin);
      return;
    }
    this.ownSeq += 1;
    this.pending.push(update);
    this.scheduleFlush();
    this.markDirty();
    this.watchOwn();
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
    if (!this.joined || !this.channel || this.closed) return;
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
    this.channel.send("update", { u, a, c: this.clientId, s: this.ownSeq } satisfies UpdateMessage);
  }

  private markDirty() {
    if (this.closed) return;
    const now = Date.now();
    this.dirtySince ??= now;
    if (!this.isSaver()) return;
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
      if (this.ownSeq > this.confirmedSeq) void this.sync();
    }, this.timing.ownMs);
  }

  private armHeartbeat() {
    if (this.heartbeat) clearTimeout(this.heartbeat);
    if (this.closed) return;
    const solo = !this.joined;
    this.heartbeat = setTimeout(() => {
      this.heartbeat = null;
      if (typeof document === "undefined" || document.visibilityState !== "hidden") void this.sync();
      this.armHeartbeat();
    }, solo ? this.timing.soloHeartbeatMs : this.timing.heartbeatMs);
  }

  private onJoined() {
    this.joined = true;
    this.settled = true;
    this.refreshStatus();
    this.sendHello();
    this.awarenessDirty = true;
    if (this.ownSeq > this.confirmedSeq) {
      const delta = Y.encodeStateAsUpdate(this.doc, this.serverVector);
      this.pending = [delta];
    }
    this.flushBroadcast();
    this.armHeartbeat();
    void this.sync();
  }

  private sendHello() {
    this.channel?.send("hello", { c: this.clientId, sv: encodeBytes(Y.encodeStateVector(this.doc)) } satisfies HelloMessage);
  }

  private receive(event: LiveEvent, payload: unknown) {
    if (this.closed || !payload || typeof payload !== "object") return;
    switch (event) {
      case "hello": {
        const hello = payload as HelloMessage;
        const vector = decodeBytes(hello.sv);
        if (this.isSaver() && vector) {
          const diff = Y.encodeStateAsUpdate(this.doc, vector);
          const u = encodeBytes(diff);
          if (!isEmptyUpdate(diff) && u.length <= LIVE_MESSAGE_MAX) this.channel?.send("state", { to: hello.c, u } satisfies StateMessage);
        }
        this.awarenessDirty = true;
        this.flushBroadcast();
        return;
      }
      case "state": {
        const state = payload as StateMessage;
        if (state.to !== this.clientId) return;
        this.applyRemote(decodeBytes(state.u), REMOTE);
        return;
      }
      case "update": {
        const message = payload as UpdateMessage;
        this.applyRemote(decodeBytes(message.u), message.server ? SERVER : REMOTE);
        if (typeof message.c === "number" && typeof message.s === "number") this.seen.set(message.c, Math.max(this.seen.get(message.c) ?? 0, message.s));
        const awareness = decodeBytes(message.a);
        if (awareness) applyAwarenessUpdate(this.awareness, awareness, REMOTE);
        return;
      }
      case "awareness": {
        const awareness = decodeBytes((payload as AwarenessMessage).a);
        if (awareness) applyAwarenessUpdate(this.awareness, awareness, REMOTE);
        return;
      }
      case "saved": {
        const saved = payload as SavedMessage;
        const vector = decodeBytes(saved.sv);
        if (vector && typeof saved.r === "number" && saved.r >= this.revision) {
          this.serverVector = vector;
          this.revision = saved.r;
        }
        const mine = saved.seqs?.[String(this.clientId)];
        if (typeof mine === "number") this.confirmedSeq = Math.max(this.confirmedSeq, mine);
        if (!this.isSaver()) this.dirtySince = null;
        if (vector && this.behind(vector)) void this.sync();
        this.emit();
        return;
      }
      case "pull":
        void this.sync();
        return;
      case "title": {
        const title = (payload as TitleMessage).t;
        if (typeof title !== "string" || title === this.title) return;
        this.title = title;
        for (const listener of this.titleListeners) listener(title);
        return;
      }
      default:
        return;
    }
  }

  private behind(vector: Uint8Array) {
    try {
      const local = Y.decodeStateVector(Y.encodeStateVector(this.doc));
      for (const [clientId, clock] of Y.decodeStateVector(vector)) if ((local.get(clientId) ?? 0) < clock) return true;
    } catch {}
    return false;
  }

  private applyRemote(update: Uint8Array | null, origin: string) {
    if (!update) return;
    try {
      Y.applyUpdate(this.doc, update, origin);
    } catch {
      void this.sync();
    }
  }

  sync(): Promise<void> {
    return this.runSync(false);
  }

  private runSync(keepalive: boolean): Promise<void> {
    if (this.syncing) {
      this.syncAgain = true;
      return this.syncing;
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const seqAtStart = this.ownSeq;
    const seenAtStart = new Map(this.seen);
    const update = Y.encodeStateAsUpdate(this.doc, this.serverVector);
    const vector = Y.encodeStateVector(this.doc);
    const title = this.titleDirty ? this.title : undefined;
    this.titleDirty = false;
    const wasDirty = this.dirtySince;
    this.dirtySince = null;
    const run = this.server
      .sync({ update: isEmptyUpdate(update) ? null : update, vector, ...(title !== undefined ? { title } : {}), keepalive })
      .then((reply) => {
        this.serverVector = reply.vector;
        this.revision = Math.max(this.revision, reply.revision);
        if (reply.missing && !isEmptyUpdate(reply.missing) && !this.closed) this.applyRemote(reply.missing, SERVER);
        this.confirmedSeq = Math.max(this.confirmedSeq, seqAtStart);
        this.retries = 0;
        this.reachable = true;
        if (!this.closed && this.joined && this.channel) {
          if (this.isSaver() || seqAtStart > 0) {
            const seqs: Record<string, number> = { [String(this.clientId)]: seqAtStart };
            for (const [clientId, seq] of seenAtStart) seqs[String(clientId)] = seq;
            this.channel.send("saved", { sv: encodeBytes(reply.vector), r: reply.revision, seqs } satisfies SavedMessage);
          }
          if (title !== undefined) this.channel.send("title", { t: title } satisfies TitleMessage);
        }
        for (const listener of this.savedListeners) listener(reply);
        this.refreshStatus();
        this.emit();
      })
      .catch(() => {
        if (title !== undefined && this.title === title) this.titleDirty = true;
        this.dirtySince ??= wasDirty ?? Date.now();
        this.reachable = false;
        this.refreshStatus();
        this.emit();
        if (this.closed) return;
        this.retries += 1;
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.sync();
        }, Math.min(30_000, this.timing.retryMs * 2 ** Math.min(this.retries - 1, 4)));
      })
      .finally(() => {
        this.syncing = null;
        if (this.syncAgain && !this.closed) {
          this.syncAgain = false;
          void this.sync();
        }
      });
    this.syncing = run;
    return run;
  }
}
