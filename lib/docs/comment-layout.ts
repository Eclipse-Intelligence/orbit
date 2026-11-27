import { resolveAnchor, type CommentAnchor } from "@/lib/docs/comment-anchor";
import { sourceMap, sourceRange } from "@/lib/docs/editor/source-map";

export type Placement = { id: string; from: number; to: number; fuzzy: boolean };

export type Layout = { placed: Placement[]; orphaned: string[] };

export function placeThreads(body: string, threads: { id: string; anchor: CommentAnchor | null }[]): Layout {
  const anchored = threads.filter((thread) => thread.anchor !== null);
  if (anchored.length === 0) return { placed: [], orphaned: threads.map((thread) => thread.id) };
  const map = sourceMap(body);
  const placed: Placement[] = [];
  const orphaned: string[] = [];
  for (const thread of threads) {
    const match = thread.anchor ? resolveAnchor(map.flat.text, thread.anchor) : null;
    const span = match && match.status === "found" ? sourceRange(map, match.start, match.end) : null;
    if (match && match.status === "found" && span) placed.push({ id: thread.id, from: span.from, to: span.to, fuzzy: match.fuzzy });
    else orphaned.push(thread.id);
  }
  return { placed, orphaned };
}
