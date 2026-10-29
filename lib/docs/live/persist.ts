import * as Y from "yjs";
import type { Actor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import type { LiveChange, LiveStep } from "@/lib/docs/live/broadcast";
import { LIVE_MESSAGE_MAX, type LiveUser } from "@/lib/docs/live/protocol";
import { createLiveDoc, encodeBytes, pendingLiveDoc, plainLiveDoc, relativeAt, setLiveText, stateFromMarkdown, typeLiveText } from "@/lib/docs/live/ydoc";
import { DOC_CONTENT_MAX, type DocEditor } from "@/lib/docs/types";

export const SERVER_ORIGIN = "server";

export const LIVE_UPDATE_MAX = 2 * LIVE_MESSAGE_MAX;
export const LIVE_VECTOR_MAX = 65_536;
export const LIVE_STATE_MAX = 4 * DOC_CONTENT_MAX;
export const LIVE_BODY_MAX = 4 * Math.ceil((LIVE_UPDATE_MAX + LIVE_VECTOR_MAX) / 3) + 8_192;

const COMPACT_MIN_BYTES = 64_000;
const COMPACT_FACTOR = 4;
const WATCH_REFRESH_SECONDS = 30;

export type StoredLive = { doc: Y.Doc | null; generation: number; bytes: number };

export type LiveCopy = { doc: Y.Doc; generation: number; rebuilt: boolean };

export async function loadLiveDoc(db: Db, pageId: string): Promise<StoredLive> {
  const result = await db.query<{ ydoc: Buffer | null; generation: number }>("select ydoc, ydoc_generation as generation from crm.pages where id = $1", [pageId]);
  const row = result.rows[0];
  const generation = row?.generation ?? 0;
  if (!row?.ydoc) return { doc: null, generation, bytes: 0 };
  try {
    return { doc: createLiveDoc(new Uint8Array(row.ydoc)), generation, bytes: row.ydoc.length };
  } catch {
    return { doc: null, generation, bytes: row.ydoc.length };
  }
}

export function usableLiveDoc(stored: StoredLive): stored is StoredLive & { doc: Y.Doc } {
  return stored.doc !== null && stored.bytes <= LIVE_STATE_MAX && plainLiveDoc(stored.doc) && !pendingLiveDoc(stored.doc);
}

export function freshLiveDoc(content: string) {
  return createLiveDoc(stateFromMarkdown(content));
}

export function rebuildLive(stored: StoredLive, content: string): LiveCopy {
  stored.doc?.destroy();
  return { doc: freshLiveDoc(content), generation: stored.bytes > 0 ? stored.generation + 1 : stored.generation, rebuilt: stored.bytes > 0 };
}

export function compactable(bytes: number, content: string) {
  if (bytes < COMPACT_MIN_BYTES) return false;
  return bytes > COMPACT_FACTOR * stateFromMarkdown(content).length;
}

export function fitLiveDoc(copy: LiveCopy, content: string): LiveCopy {
  if (Y.encodeStateAsUpdate(copy.doc).length <= LIVE_STATE_MAX) return copy;
  copy.doc.destroy();
  return { doc: freshLiveDoc(content), generation: copy.generation + 1, rebuilt: true };
}

export async function storeLiveDoc(db: Db, pageId: string, copy: LiveCopy) {
  await db.query("update crm.pages set ydoc = $2, ydoc_generation = $3 where id = $1", [pageId, encodeState(copy.doc), copy.generation]);
}

export function liveUserFor(actor: Actor, editor: DocEditor): LiveUser | null {
  if (editor === "assistant") return { id: "orbit-assistant", name: "Orbit assistant", kind: "assistant" };
  if (editor !== "agent") return null;
  if (actor.type === "agent") return { id: `agent:${actor.agentId}`, name: actor.agentName || "Agent", kind: "mcp" };
  return { id: `agent:mcp:${actor.userId}`, name: "MCP", kind: "mcp" };
}

export function writeLiveText(doc: Y.Doc, content: string, agent: LiveUser | null) {
  if (agent) {
    const steps = typeLiveText(doc, content, { origin: SERVER_ORIGIN });
    const typed = steps.reduce((total, step) => total + Math.max(0, step.to - step.from), 0);
    const live: LiveStep[] = steps.map((step) => ({
      u: encodeBytes(step.update),
      from: relativeAt(doc, step.from, 0),
      head: relativeAt(doc, step.to, -1),
    }));
    return { steps: live, typed };
  }
  const update = setLiveText(doc, content, SERVER_ORIGIN);
  return { steps: update ? [{ u: encodeBytes(update), from: null, head: null }] : [], typed: 0 };
}

export function liveChange(
  page: { id: string; workspace_id: string; user_id: string | null; effective_shared: boolean },
  revision: number,
  generation: number,
  agent: LiveUser | null,
  written: { steps: LiveStep[]; typed: number },
): LiveChange {
  return {
    pageId: page.id,
    workspaceId: page.workspace_id,
    ownerId: page.user_id,
    shared: page.effective_shared,
    revision,
    generation,
    agent,
    steps: written.steps,
    typedCharacters: written.typed,
  };
}

export async function markWatching(db: Db, actor: Actor, page: { id: string; workspace_id: string }, options: { refresh?: boolean } = {}) {
  if (actor.type !== "user") return;
  const onlyStale = options.refresh === false ? ` where crm.page_watchers.seen_at < now() - make_interval(secs => ${WATCH_REFRESH_SECONDS})` : "";
  await db.query(
    `insert into crm.page_watchers (page_id, user_id, workspace_id, seen_at) values ($1, $2, $3, now())
     on conflict (page_id, user_id) do update set seen_at = excluded.seen_at${onlyStale}`,
    [page.id, actor.userId, page.workspace_id],
  );
}

export function encodeState(doc: Y.Doc) {
  return Buffer.from(Y.encodeStateAsUpdate(doc));
}
