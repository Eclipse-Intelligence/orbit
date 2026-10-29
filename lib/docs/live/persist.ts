import * as Y from "yjs";
import type { Actor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import type { LiveChange, LiveStep } from "@/lib/docs/live/broadcast";
import type { LiveUser } from "@/lib/docs/live/protocol";
import { createLiveDoc, encodeBytes, relativeAt, setLiveText, typeLiveText } from "@/lib/docs/live/ydoc";
import type { DocEditor } from "@/lib/docs/types";

export const SERVER_ORIGIN = "server";

export async function loadLiveDoc(db: Db, pageId: string) {
  const result = await db.query<{ ydoc: Buffer | null }>("select ydoc from crm.pages where id = $1", [pageId]);
  const state = result.rows[0]?.ydoc;
  return state ? createLiveDoc(new Uint8Array(state)) : null;
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
  agent: LiveUser | null,
  written: { steps: LiveStep[]; typed: number },
): LiveChange {
  return {
    pageId: page.id,
    workspaceId: page.workspace_id,
    ownerId: page.user_id,
    shared: page.effective_shared,
    revision,
    agent,
    steps: written.steps,
    typedCharacters: written.typed,
  };
}

export async function markWatching(db: Db, actor: Actor, page: { id: string; workspace_id: string }) {
  if (actor.type !== "user") return;
  await db.query(
    `insert into crm.page_watchers (page_id, user_id, workspace_id, seen_at) values ($1, $2, $3, now())
     on conflict (page_id, user_id) do update set seen_at = excluded.seen_at`,
    [page.id, actor.userId, page.workspace_id],
  );
}

export function encodeState(doc: Y.Doc) {
  return Buffer.from(Y.encodeStateAsUpdate(doc));
}
