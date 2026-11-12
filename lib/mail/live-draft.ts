import * as Y from "yjs";
import { chatBackground } from "@/lib/crm/chat";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";
import { appTransaction, type Db } from "@/lib/db/pool";
import { liveTransport, publishLiveBatch } from "@/lib/docs/live/broadcast";
import { draftTopic, type LiveTransportKind } from "@/lib/docs/live/protocol";
import { createLiveDoc, liveText, pendingLiveDoc, plainLiveDoc, setLiveText, stateFromMarkdown } from "@/lib/docs/live/ydoc";
import { DRAFT_NO_ACCESS, draftFailure } from "@/lib/mail/shared-drafts";

export const DRAFT_LIVE_STATE_MAX = 1_000_000;
export const DRAFT_BODY_MAX = 20_000;

const SERVER_ORIGIN = "server";

export type DraftLiveInput = { update?: Uint8Array | null; vector?: Uint8Array | null; generation?: number };

export type DraftLiveReply = {
  vector: Uint8Array;
  missing: Uint8Array;
  state: Uint8Array;
  generation: number;
  rebuilt: boolean;
  version: number;
  locked: string | null;
  transport: LiveTransportKind | null;
};

type LockedRow = { owner_user_id: string; draft_id: string; body: string; ydoc: Buffer | null; generation: number; version: number; refusal: string | null };

type Copy = { doc: Y.Doc; generation: number; stored: boolean };

function checkShare(id: unknown) {
  if (typeof id !== "string" || !isUuid(id)) throw new CrmError("not_found", DRAFT_NO_ACCESS, 404);
  return id.toLowerCase();
}

function unreadable() {
  return new CrmError("live_invalid", "That change wasn't saved. Reload the draft and try again.", 400);
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function freshCopy(body: string, generation: number): Copy {
  return { doc: createLiveDoc(stateFromMarkdown(body)), generation, stored: false };
}

export function liveCopyOf(row: { body: string; ydoc: Buffer | Uint8Array | null; generation: number }): Copy {
  const bytes = row.ydoc?.length ?? 0;
  if (!row.ydoc || bytes === 0) return freshCopy(row.body, row.generation);
  let doc: Y.Doc | null = null;
  try {
    doc = createLiveDoc(new Uint8Array(row.ydoc));
  } catch {
    doc = null;
  }
  if (!doc || bytes > DRAFT_LIVE_STATE_MAX || !plainLiveDoc(doc) || pendingLiveDoc(doc)) {
    doc?.destroy();
    return freshCopy(row.body, row.generation + 1);
  }
  const repaired = setLiveText(doc, row.body, SERVER_ORIGIN) !== null;
  return { doc, generation: row.generation, stored: !repaired };
}

async function lockDraft(db: Db, userId: string, shareId: string) {
  try {
    const result = await db.query<LockedRow>("select * from private.shared_draft_live_lock($1, $2)", [userId, shareId]);
    const row = result.rows[0];
    if (!row) throw new CrmError("not_found", DRAFT_NO_ACCESS, 404);
    return row;
  } catch (error) {
    draftFailure(error);
  }
}

async function storeDraft(db: Db, userId: string, shareId: string, row: LockedRow, body: string | null, copy: Copy) {
  try {
    const result = await db.query<{ version: number; changed: boolean }>(
      "select version, changed from private.shared_draft_live_store($1, $2, $3, $4, $5, $6)",
      [userId, shareId, row.draft_id, body, Buffer.from(Y.encodeStateAsUpdate(copy.doc)), copy.generation],
    );
    return result.rows[0];
  } catch (error) {
    draftFailure(error);
  }
}

function announcePull(shareId: string, generation: number) {
  chatBackground(async () => {
    await publishLiveBatch([{ topic: draftTopic(shareId), event: "pull", payload: { g: generation } }]).catch((error) =>
      console.error("Live draft broadcast failed", error instanceof Error ? error.name : "unknown"),
    );
  });
}

export async function syncLiveDraft(actor: UserActor, shareId: unknown, input: DraftLiveInput = {}): Promise<DraftLiveReply> {
  const id = checkShare(shareId);
  const outcome = await appTransaction(async (db) => {
    const row = await lockDraft(db, actor.userId, id);
    let copy = liveCopyOf(row);
    const rebuiltNow = copy.generation !== row.generation;
    let stale = (input.generation ?? 0) !== copy.generation;
    const before = Y.encodeStateVector(copy.doc);
    if (!stale && input.update && input.update.length > 2) {
      try {
        Y.applyUpdate(copy.doc, input.update, "client");
      } catch {
        throw unreadable();
      }
      if (!plainLiveDoc(copy.doc)) throw unreadable();
      if (pendingLiveDoc(copy.doc)) {
        copy.doc.destroy();
        copy = liveCopyOf(row);
        stale = true;
      } else if (row.refusal && !sameBytes(before, Y.encodeStateVector(copy.doc))) {
        throw new CrmError("conflict", row.refusal, 409, { locked: true });
      }
    }
    const text = liveText(copy.doc).toString();
    if (text.length > DRAFT_BODY_MAX) throw new CrmError("too_long", "Keep the message under 20,000 characters.", 413);
    if (Y.encodeStateAsUpdate(copy.doc).length > DRAFT_LIVE_STATE_MAX) {
      copy.doc.destroy();
      copy = freshCopy(text, copy.generation + 1);
      stale = true;
    }
    let version = row.version;
    const changed = text !== row.body;
    if (changed || !copy.stored || !sameBytes(before, Y.encodeStateVector(copy.doc)) || copy.generation !== row.generation) {
      const stored = await storeDraft(db, actor.userId, id, row, changed ? text : null, copy);
      version = stored.version;
    }
    const state = Y.encodeStateAsUpdate(copy.doc);
    const vector = Y.encodeStateVector(copy.doc);
    const missing = !stale && input.vector && input.vector.length > 0 ? Y.encodeStateAsUpdate(copy.doc, input.vector) : state;
    copy.doc.destroy();
    return {
      vector,
      missing,
      state,
      generation: copy.generation,
      rebuilt: stale,
      version,
      locked: row.refusal,
      rebuiltNow: rebuiltNow || copy.generation !== row.generation,
    };
  });
  if (outcome.rebuiltNow) announcePull(id, outcome.generation);
  return {
    vector: outcome.vector,
    missing: outcome.missing,
    state: outcome.state,
    generation: outcome.generation,
    rebuilt: outcome.rebuilt,
    version: outcome.version,
    locked: outcome.locked,
    transport: liveTransport(),
  };
}

export function openLiveDraft(actor: UserActor, shareId: unknown) {
  return syncLiveDraft(actor, shareId, { update: null, vector: null, generation: undefined });
}
