import { fromBase64, toBase64 } from "lib0/buffer";
import * as Y from "yjs";
import { textEdits, type TextEdit } from "@/lib/docs/live/text-diff";

export const LIVE_TEXT = "body";

export type TypingStep = { update: Uint8Array; from: number; to: number };

export function liveText(doc: Y.Doc) {
  return doc.getText(LIVE_TEXT);
}

export function createLiveDoc(state?: Uint8Array | null) {
  const doc = new Y.Doc();
  if (state && state.length > 0) Y.applyUpdate(doc, state);
  return doc;
}

export function stateFromMarkdown(markdown: string) {
  const doc = new Y.Doc();
  if (markdown) liveText(doc).insert(0, markdown);
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}

export function textOfState(state: Uint8Array) {
  const doc = createLiveDoc(state);
  const text = liveText(doc).toString();
  doc.destroy();
  return text;
}

export function captureUpdate(doc: Y.Doc, change: () => void): Uint8Array | null {
  const updates: Uint8Array[] = [];
  const listen = (update: Uint8Array) => updates.push(update);
  doc.on("update", listen);
  try {
    change();
  } finally {
    doc.off("update", listen);
  }
  if (updates.length === 0) return null;
  return updates.length === 1 ? updates[0] : Y.mergeUpdates(updates);
}

export function applyTextEdits(doc: Y.Doc, edits: TextEdit[], origin: unknown = null) {
  if (edits.length === 0) return;
  const text = liveText(doc);
  doc.transact(() => {
    for (let index = edits.length - 1; index >= 0; index -= 1) {
      const edit = edits[index];
      if (edit.remove > 0) text.delete(edit.at, edit.remove);
      if (edit.insert) text.insert(edit.at, edit.insert);
    }
  }, origin);
}

export function setLiveText(doc: Y.Doc, next: string, origin: unknown = null) {
  const current = liveText(doc).toString();
  if (current === next) return null;
  return captureUpdate(doc, () => applyTextEdits(doc, textEdits(current, next), origin));
}

function pieces(text: string, size: number) {
  if (size <= 0 || text.length <= size) return [text];
  const words = text.match(/\s*\S+\s*|\s+/gu) ?? [text];
  const out: string[] = [];
  let current = "";
  for (const word of words) {
    if (current && current.length + word.length > size) {
      out.push(current);
      current = "";
    }
    if (word.length > size * 2) {
      const points = Array.from(word);
      for (let index = 0; index < points.length; index += size) {
        const slice = points.slice(index, index + size).join("");
        if (index + size >= points.length) current = slice;
        else out.push(slice);
      }
      continue;
    }
    current += word;
  }
  if (current) out.push(current);
  const limit = Math.max(1, Math.ceil(text.length / size));
  if (out.length <= limit) return out;
  const group = Math.ceil(out.length / limit);
  const grouped: string[] = [];
  for (let index = 0; index < out.length; index += group) grouped.push(out.slice(index, index + group).join(""));
  return grouped;
}

export function typeLiveText(doc: Y.Doc, next: string, options: { origin?: unknown; maxSteps?: number } = {}): TypingStep[] {
  const text = liveText(doc);
  const edits = textEdits(text.toString(), next);
  if (edits.length === 0) return [];
  const maxSteps = Math.max(1, options.maxSteps ?? 24);
  const inserted = edits.reduce((total, edit) => total + edit.insert.length, 0);
  const size = Math.max(1, Math.ceil(inserted / maxSteps));
  const steps: TypingStep[] = [];
  let offset = 0;
  for (const edit of edits) {
    const start = edit.at + offset;
    const chunks = edit.insert ? pieces(edit.insert, size) : [""];
    let written = 0;
    chunks.forEach((chunk, index) => {
      const update = captureUpdate(doc, () =>
        doc.transact(() => {
          if (index === 0 && edit.remove > 0) text.delete(start, edit.remove);
          if (chunk) text.insert(start + written, chunk);
        }, options.origin ?? null),
      );
      written += chunk.length;
      if (update) steps.push({ update, from: start, to: start + written });
    });
    offset += edit.insert.length - edit.remove;
  }
  return steps;
}

export function isEmptyUpdate(update: Uint8Array) {
  return update.length <= 2;
}

export function stateVector(doc: Y.Doc) {
  return Y.encodeStateVector(doc);
}

export function missingFrom(doc: Y.Doc, vector: Uint8Array | null) {
  return vector && vector.length > 0 ? Y.encodeStateAsUpdate(doc, vector) : Y.encodeStateAsUpdate(doc);
}

export function covers(server: Map<number, number>, local: Map<number, number>, clientId: number) {
  return (server.get(clientId) ?? 0) >= (local.get(clientId) ?? 0);
}

export function decodeVector(vector: Uint8Array) {
  return Y.decodeStateVector(vector);
}

export function encodeBytes(bytes: Uint8Array) {
  return toBase64(bytes);
}

export function relativeAt(doc: Y.Doc, index: number, assoc = 0) {
  const text = liveText(doc);
  const clamped = Math.max(0, Math.min(index, text.length));
  return Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, clamped, assoc));
}

export function absoluteFrom(doc: Y.Doc, position: unknown) {
  if (!position || typeof position !== "object") return null;
  try {
    const absolute = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(position), doc);
    return absolute && absolute.type === liveText(doc) ? absolute.index : null;
  } catch {
    return null;
  }
}

export function decodeBytes(text: unknown) {
  if (typeof text !== "string" || !text) return null;
  try {
    return fromBase64(text);
  } catch {
    return null;
  }
}
