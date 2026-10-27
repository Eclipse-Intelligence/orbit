export const CHUNK_SIZE = 1_200;
export const CHUNK_OVERLAP = 150;
export const CHUNKS_MAX = 600;

const MARKER = /^(Page|Slide|Sheet) [^\n]{1,80}:$/;

function pieces(text: string) {
  const out: string[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    if (trimmed.length <= CHUNK_SIZE) {
      out.push(trimmed);
      continue;
    }
    const sentences = trimmed.match(/[^.!?\n]+(?:[.!?]+|\n|$)/g) ?? [trimmed];
    let current = "";
    for (const sentence of sentences) {
      if (sentence.length > CHUNK_SIZE) {
        if (current.trim()) out.push(current.trim());
        current = "";
        for (let start = 0; start < sentence.length; start += CHUNK_SIZE) out.push(sentence.slice(start, start + CHUNK_SIZE).trim());
        continue;
      }
      if ((current + sentence).length > CHUNK_SIZE && current.trim()) {
        out.push(current.trim());
        current = "";
      }
      current += sentence;
    }
    if (current.trim()) out.push(current.trim());
  }
  return out.filter(Boolean);
}

function tail(text: string) {
  if (text.length <= CHUNK_OVERLAP) return text;
  const slice = text.slice(-CHUNK_OVERLAP);
  const space = slice.indexOf(" ");
  return space > 0 && space < CHUNK_OVERLAP / 2 ? slice.slice(space + 1) : slice;
}

export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let current = "";
  let place: string | null = null;
  for (const piece of pieces(text)) {
    const firstLine = piece.split("\n")[0].trim();
    if (MARKER.test(firstLine)) place = firstLine.slice(0, -1);
    const lead = current ? "" : place && !piece.startsWith(place) ? `${place}: ` : "";
    if (current && (current + "\n\n" + piece).length > CHUNK_SIZE) {
      chunks.push(current);
      if (chunks.length >= CHUNKS_MAX) return chunks;
      const carried = tail(current);
      const prefix = place && !piece.startsWith(place) ? `${place}: ` : "";
      current = `${prefix}${carried}\n\n${piece}`.slice(0, CHUNK_SIZE + CHUNK_OVERLAP + 100);
      continue;
    }
    current = current ? `${current}\n\n${piece}` : `${lead}${piece}`;
  }
  if (current.trim() && chunks.length < CHUNKS_MAX) chunks.push(current);
  return chunks.map((chunk) => chunk.trim()).filter(Boolean);
}
