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

export function diffCounts(lines: DocDiffLine[]) {
  return {
    added: lines.filter((line) => line.kind === "add").length,
    removed: lines.filter((line) => line.kind === "remove").length,
  };
}
