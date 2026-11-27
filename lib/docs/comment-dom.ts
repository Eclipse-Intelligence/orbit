import { flattenText, locateOffset, offsetOf, type FlatText } from "@/lib/docs/comment-anchor";

export const BLOCK_SELECTOR = "[data-line]";
const KEY_SELECTOR = "[data-line], .note-table-cell";

export type TextMap = { flat: FlatText; nodes: Text[]; index: Map<Text, number> };

function hiddenWithin(node: Node, root: Element) {
  for (let element = node.parentElement; element && element !== root; element = element.parentElement) {
    if (element.getAttribute("aria-hidden") === "true" || element.hasAttribute("aria-hidden")) return true;
  }
  return false;
}

export function mapText(root: Element): TextMap {
  const nodes: Text[] = [];
  const keys = new Map<Element, number>();
  const segments: { key: number; text: string }[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (hiddenWithin(text, root)) continue;
    const block = text.parentElement?.closest(KEY_SELECTOR);
    if (!block || !root.contains(block)) continue;
    if (!keys.has(block)) keys.set(block, keys.size);
    nodes.push(text);
    segments.push({ key: keys.get(block) ?? 0, text: text.data });
  }
  return { flat: flattenText(segments), nodes, index: new Map(nodes.map((node, position) => [node, position])) };
}

export function rangeOf(map: TextMap, start: number, end: number): Range | null {
  const from = locateOffset(map.flat, start, "after");
  const to = locateOffset(map.flat, end, "before");
  if (!from || !to) return null;
  const first = map.nodes[from.segment];
  const last = map.nodes[to.segment];
  if (!first || !last) return null;
  const range = document.createRange();
  try {
    range.setStart(first, Math.min(from.offset, first.length));
    range.setEnd(last, Math.min(to.offset, last.length));
  } catch {
    return null;
  }
  return range.collapsed ? null : range;
}

export function pointOffset(map: TextMap, node: Node, offset: number) {
  if (node.nodeType === Node.TEXT_NODE) {
    const position = map.index.get(node as Text);
    if (position !== undefined) return offsetOf(map.flat, position, offset);
  }
  const probe = document.createRange();
  try {
    probe.setStart(node, offset);
  } catch {
    return null;
  }
  for (let position = 0; position < map.nodes.length; position += 1) {
    if (probe.comparePoint(map.nodes[position], 0) >= 0) return map.flat.spans[position].start;
  }
  return map.flat.text.length;
}

export function selectionOffsets(map: TextMap, range: Range) {
  const start = pointOffset(map, range.startContainer, range.startOffset);
  const end = pointOffset(map, range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) return null;
  return { start, end };
}

export function blockOffsets(map: TextMap, block: Element) {
  let start = -1;
  let end = -1;
  for (let position = 0; position < map.nodes.length; position += 1) {
    if (!block.contains(map.nodes[position])) continue;
    const span = map.flat.spans[position];
    if (span.end === span.start) continue;
    if (start === -1) start = span.start;
    end = span.end;
  }
  return start === -1 ? null : { start, end };
}

type Pointed = { node: Node; offset: number };

function caretAt(x: number, y: number): Pointed | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (doc.caretPositionFromPoint) {
    const position = doc.caretPositionFromPoint(x, y);
    return position ? { node: position.offsetNode, offset: position.offset } : null;
  }
  if (doc.caretRangeFromPoint) {
    const range = doc.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  return null;
}

export function offsetAtPoint(map: TextMap, x: number, y: number) {
  const caret = caretAt(x, y);
  if (!caret) return null;
  return pointOffset(map, caret.node, caret.offset);
}

export function pointInside(range: Range, x: number, y: number) {
  for (const rect of Array.from(range.getClientRects())) {
    if (x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top - 1 && y <= rect.bottom + 1) return true;
  }
  return false;
}

type HighlightRegistry = { set: (name: string, value: unknown) => void; delete: (name: string) => void };

function registry(): HighlightRegistry | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  return css?.highlights ?? null;
}

export function highlightsSupported() {
  return registry() !== null && typeof (globalThis as { Highlight?: unknown }).Highlight === "function";
}

export function paintHighlight(name: string, ranges: Range[]) {
  const highlights = registry();
  const Highlight = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!highlights || !Highlight) return;
  if (ranges.length === 0) highlights.delete(name);
  else highlights.set(name, new Highlight(...ranges));
}
