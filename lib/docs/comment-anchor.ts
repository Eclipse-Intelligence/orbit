export const ANCHOR_CONTEXT = 32;
export const ANCHOR_QUOTE_LIMIT = 1000;
const TAIL_MATCH = 24;
const SHORT_QUOTE = 12;
const SHORT_QUOTE_SCORE = 6;
const FUZZY_SHARE = 0.25;
const FUZZY_CELLS = 6_000_000;

export type CommentAnchor = { quote: string; prefix: string; suffix: string; at: number };

export type TextSegment = { key: number; text: string };

export type FlatSpan = { start: number; end: number };

export type FlatText = { text: string; spans: FlatSpan[] };

export type AnchorMatch = { status: "found"; start: number; end: number; fuzzy: boolean } | { status: "orphaned" };

export function flattenText(segments: TextSegment[]): FlatText {
  let text = "";
  const spans: FlatSpan[] = [];
  let previous: number | null = null;
  for (const segment of segments) {
    if (previous !== null && segment.key !== previous && segment.text.length > 0 && text.length > 0) text += "\n";
    const start = text.length;
    text += segment.text;
    spans.push({ start, end: text.length });
    if (segment.text.length > 0) previous = segment.key;
  }
  return { text, spans };
}

export function locateOffset(flat: FlatText, offset: number, prefer: "before" | "after" = "before"): { segment: number; offset: number } | null {
  let previous: { segment: number; offset: number } | null = null;
  for (let index = 0; index < flat.spans.length; index += 1) {
    const span = flat.spans[index];
    if (span.end === span.start) continue;
    if (offset >= span.start && offset < span.end) return { segment: index, offset: offset - span.start };
    if (offset === span.end && prefer === "before") return { segment: index, offset: span.end - span.start };
    if (offset < span.start) return prefer === "after" || !previous ? { segment: index, offset: 0 } : previous;
    previous = { segment: index, offset: span.end - span.start };
  }
  return previous;
}

export function offsetOf(flat: FlatText, segment: number, offset: number) {
  const span = flat.spans[segment];
  if (!span) return null;
  return span.start + Math.max(0, Math.min(offset, span.end - span.start));
}

export function createAnchor(text: string, start: number, end: number): CommentAnchor | null {
  const from = Math.max(0, Math.min(start, end));
  const to = Math.min(text.length, Math.max(start, end));
  let quoteEnd = Math.min(to, from + ANCHOR_QUOTE_LIMIT);
  if (quoteEnd < to && isHighSurrogate(text.charCodeAt(quoteEnd - 1))) quoteEnd -= 1;
  const quote = text.slice(from, quoteEnd);
  if (quote.trim().length === 0) return null;
  return {
    quote,
    prefix: text.slice(Math.max(0, from - ANCHOR_CONTEXT), from),
    suffix: text.slice(quoteEnd, quoteEnd + ANCHOR_CONTEXT),
    at: from,
  };
}

function isHighSurrogate(code: number) {
  return code >= 0xd800 && code <= 0xdbff;
}

function commonSuffix(before: string, prefix: string) {
  let count = 0;
  while (count < before.length && count < prefix.length && before[before.length - 1 - count] === prefix[prefix.length - 1 - count]) count += 1;
  return count;
}

function commonPrefix(after: string, suffix: string) {
  let count = 0;
  while (count < after.length && count < suffix.length && after[count] === suffix[count]) count += 1;
  return count;
}

function occurrences(text: string, needle: string) {
  const found: number[] = [];
  if (!needle) return found;
  let from = text.indexOf(needle);
  while (from !== -1) {
    found.push(from);
    from = text.indexOf(needle, from + 1);
  }
  return found;
}

function exactMatch(text: string, anchor: CommentAnchor): AnchorMatch | null {
  const hits = occurrences(text, anchor.quote);
  if (hits.length === 0) return null;
  const hasContext = anchor.prefix.length + anchor.suffix.length > 0;
  let best: { start: number; score: number; distance: number } | null = null;
  for (const start of hits) {
    const score =
      commonSuffix(text.slice(Math.max(0, start - anchor.prefix.length), start), anchor.prefix) +
      commonPrefix(text.slice(start + anchor.quote.length, start + anchor.quote.length + anchor.suffix.length), anchor.suffix);
    const distance = Math.abs(start - anchor.at);
    if (!best || score > best.score || (score === best.score && distance < best.distance)) best = { start, score, distance };
  }
  if (!best) return null;
  const needed = Math.min(SHORT_QUOTE_SCORE, anchor.prefix.length + anchor.suffix.length);
  if (hasContext && anchor.quote.length < SHORT_QUOTE && best.score < needed) return null;
  return { status: "found", start: best.start, end: best.start + anchor.quote.length, fuzzy: false };
}

function contextMatch(text: string, anchor: CommentAnchor): AnchorMatch | null {
  const prefixTail = anchor.prefix.slice(-TAIL_MATCH);
  const suffixHead = anchor.suffix.slice(0, TAIL_MATCH);
  if (!prefixTail && !suffixHead) return null;
  const starts = prefixTail ? occurrences(text, prefixTail).map((index) => index + prefixTail.length) : [0];
  const reach = anchor.quote.length * 3 + 40;
  let best: { start: number; end: number; distance: number } | null = null;
  for (const start of starts) {
    let end: number | null = null;
    if (suffixHead) {
      const next = text.indexOf(suffixHead, start);
      if (next !== -1 && next - start <= reach) end = next;
    } else if (text.length - start <= reach) {
      end = text.length;
    }
    if (end === null || end <= start) continue;
    if (text.slice(start, end).trim().length === 0) continue;
    const distance = Math.abs(start - anchor.at);
    if (!best || distance < best.distance) best = { start, end, distance };
  }
  if (!best) return null;
  return { status: "found", start: best.start, end: best.end, fuzzy: true };
}

function approximateMatch(text: string, anchor: CommentAnchor): AnchorMatch | null {
  const pattern = anchor.quote;
  const length = pattern.length;
  if (length < 8) return null;
  const allowed = Math.floor(length * FUZZY_SHARE);
  if (allowed < 1) return null;
  let from = 0;
  let to = text.length;
  if (text.length * length > FUZZY_CELLS) {
    const window = Math.floor(FUZZY_CELLS / length / 2);
    from = Math.max(0, anchor.at - window);
    to = Math.min(text.length, anchor.at + window);
  }
  const slice = text.slice(from, to);
  let column = Array.from({ length: length + 1 }, (_, row) => row);
  const origin = new Array<number>(length + 1).fill(0);
  let originColumn = origin.slice();
  let best = { distance: allowed + 1, end: -1, begin: -1 };
  for (let index = 0; index < slice.length; index += 1) {
    const next = new Array<number>(length + 1);
    const nextOrigin = new Array<number>(length + 1);
    next[0] = 0;
    nextOrigin[0] = index + 1;
    for (let row = 1; row <= length; row += 1) {
      const substitution = column[row - 1] + (pattern[row - 1] === slice[index] ? 0 : 1);
      const insertion = column[row] + 1;
      const deletion = next[row - 1] + 1;
      if (substitution <= insertion && substitution <= deletion) {
        next[row] = substitution;
        nextOrigin[row] = originColumn[row - 1];
      } else if (insertion <= deletion) {
        next[row] = insertion;
        nextOrigin[row] = originColumn[row];
      } else {
        next[row] = deletion;
        nextOrigin[row] = nextOrigin[row - 1];
      }
    }
    if (next[length] < best.distance || (next[length] === best.distance && best.end !== -1 && Math.abs(from + nextOrigin[length] - anchor.at) < Math.abs(from + best.begin - anchor.at))) {
      best = { distance: next[length], end: index + 1, begin: nextOrigin[length] };
    }
    column = next;
    originColumn = nextOrigin;
  }
  if (best.end === -1 || best.distance > allowed) return null;
  const start = from + best.begin;
  const end = from + best.end;
  if (end <= start || text.slice(start, end).trim().length === 0) return null;
  return { status: "found", start, end, fuzzy: true };
}

export function resolveAnchor(text: string, anchor: CommentAnchor): AnchorMatch {
  if (!anchor.quote) return { status: "orphaned" };
  return exactMatch(text, anchor) ?? contextMatch(text, anchor) ?? approximateMatch(text, anchor) ?? { status: "orphaned" };
}

export type CardSlot = { key: string; top: number; height: number };

export function stackCards(slots: CardSlot[], gap: number, activeKey?: string | null) {
  const tops = slots.map((slot) => Math.max(0, slot.top));
  const active = activeKey ? slots.findIndex((slot) => slot.key === activeKey) : -1;
  if (active > 0) {
    for (let index = active - 1; index >= 0; index -= 1) tops[index] = Math.min(tops[index], tops[index + 1] - gap - slots[index].height);
  }
  for (let index = 0; index < slots.length; index += 1) {
    if (index > 0) tops[index] = Math.max(tops[index], tops[index - 1] + slots[index - 1].height + gap);
    tops[index] = Math.max(0, tops[index]);
  }
  return new Map(slots.map((slot, index) => [slot.key, tops[index]]));
}
