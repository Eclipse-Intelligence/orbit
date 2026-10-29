import type { NoteTitle } from "@/lib/docs/client-types";

export const LINK_MATCH_LIMIT = 6;

export function linkMatches(titles: NoteTitle[], query: string, excludeId: string | null, limit = LINK_MATCH_LIMIT): NoteTitle[] {
  const wanted = query.replace(/\s+/g, " ").trim().toLowerCase();
  const starts: NoteTitle[] = [];
  const contains: NoteTitle[] = [];
  for (const note of titles) {
    if (starts.length >= limit) break;
    if (note.id === excludeId || !note.title) continue;
    const index = note.title.replace(/\s+/g, " ").toLowerCase().indexOf(wanted);
    if (index === 0) starts.push(note);
    else if (index > 0 && contains.length < limit) contains.push(note);
  }
  return [...starts, ...contains].slice(0, limit);
}
