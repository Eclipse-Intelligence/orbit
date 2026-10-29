import type { DocDiffLine } from "@/lib/docs/types";

const LCS_CELLS_MAX = 4_000_000;

function middleOps(before: string[], after: string[]): DocDiffLine[] {
  if (before.length === 0) return after.map((text) => ({ kind: "add", text }));
  if (after.length === 0) return before.map((text) => ({ kind: "remove", text }));
  if (before.length * after.length > LCS_CELLS_MAX) {
    return [...before.map((text) => ({ kind: "remove" as const, text })), ...after.map((text) => ({ kind: "add" as const, text }))];
  }
  const rows = before.length + 1;
  const cols = after.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = before[i] === after[j] ? table[(i + 1) * cols + j + 1] + 1 : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const ops: DocDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      ops.push({ kind: "same", text: before[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
      ops.push({ kind: "remove", text: before[i] });
      i += 1;
    } else {
      ops.push({ kind: "add", text: after[j] });
      j += 1;
    }
  }
  while (i < before.length) ops.push({ kind: "remove", text: before[i++] });
  while (j < after.length) ops.push({ kind: "add", text: after[j++] });
  return ops;
}

export function fullDiff(before: string, after: string): DocDiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  return [
    ...a.slice(0, head).map((text) => ({ kind: "same" as const, text })),
    ...middleOps(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
    ...a.slice(a.length - tail).map((text) => ({ kind: "same" as const, text })),
  ];
}

export function lineDiff(before: string, after: string, options: { context?: number; maxLines?: number } = {}): DocDiffLine[] {
  const context = options.context ?? 2;
  const maxLines = options.maxLines ?? 400;
  const ops = fullDiff(before, after);
  const keep = ops.map(() => false);
  ops.forEach((op, index) => {
    if (op.kind === "same") return;
    for (let near = Math.max(0, index - context); near <= Math.min(ops.length - 1, index + context); near += 1) keep[near] = true;
  });
  const shown: DocDiffLine[] = [];
  let skipped = false;
  ops.forEach((op, index) => {
    if (keep[index]) {
      if (skipped && shown.length > 0) shown.push({ kind: "gap", text: "" });
      shown.push(op);
      skipped = false;
    } else {
      skipped = true;
    }
  });
  if (shown.length <= maxLines) return shown;
  return [...shown.slice(0, maxLines), { kind: "gap", text: `${shown.length - maxLines} more lines` }];
}

export function changeCounts(before: string, after: string) {
  return diffCounts(fullDiff(before, after));
}

export function diffCounts(lines: DocDiffLine[]) {
  return {
    added: lines.filter((line) => line.kind === "add").length,
    removed: lines.filter((line) => line.kind === "remove").length,
  };
}

export type DiffPart = { type: "same" | "add" | "del"; text: string };

const WORD = /\s+|[\p{L}\p{N}'’]+|[^\s\p{L}\p{N}]/gu;

function merge(parts: DiffPart[]) {
  const merged: DiffPart[] = [];
  for (const part of parts) {
    if (!part.text) continue;
    const previous = merged[merged.length - 1];
    if (previous && previous.type === part.type) previous.text += part.text;
    else merged.push({ ...part });
  }
  return merged;
}

function absorbSpaces(parts: DiffPart[]) {
  const out: DiffPart[] = [];
  parts.forEach((part, index) => {
    const before = out[out.length - 1];
    const after = parts[index + 1];
    if (part.type === "same" && /^[ \t]+$/.test(part.text) && before && after && before.type !== "same" && after.type !== "same") {
      out.push({ type: "del", text: part.text }, { type: "add", text: part.text });
    } else out.push(part);
  });
  const result: DiffPart[] = [];
  let dels: DiffPart[] = [];
  let adds: DiffPart[] = [];
  const flush = () => {
    if (dels.length) result.push({ type: "del", text: dels.map((part) => part.text).join("") });
    if (adds.length) result.push({ type: "add", text: adds.map((part) => part.text).join("") });
    dels = [];
    adds = [];
  };
  for (const part of out) {
    if (part.type === "same") {
      flush();
      result.push(part);
    } else if (part.type === "del") dels.push(part);
    else adds.push(part);
  }
  flush();
  return merge(result);
}

export function wordDiff(before: string, after: string): DiffPart[] {
  if (before === after) return before ? [{ type: "same", text: before }] : [];
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  while (start > 0 && /[\p{L}\p{N}]/u.test(before[start - 1])) start -= 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  while (endBefore < before.length && /[\p{L}\p{N}]/u.test(before[endBefore])) {
    endBefore += 1;
    endAfter += 1;
  }
  const left = before.slice(start, endBefore).match(WORD) ?? [];
  const right = after.slice(start, endAfter).match(WORD) ?? [];
  const middle = middleOps(left, right).map((op): DiffPart => ({ type: op.kind === "remove" ? "del" : op.kind === "add" ? "add" : "same", text: op.text }));
  return absorbSpaces(merge([{ type: "same", text: before.slice(0, start) }, ...middle, { type: "same", text: before.slice(endBefore) }]));
}
