export type DiffPart = { type: "same" | "add" | "del"; text: string };

export type LineDiff = { sign: " " | "+" | "-"; text: string };

const WORD = /\s+|[\p{L}\p{N}'’]+|[^\s\p{L}\p{N}]/gu;
const MAX_EDITS = 1200;

function tokens(text: string) {
  return text.match(WORD) ?? [];
}

function myers<T>(left: T[], right: T[]): { type: DiffPart["type"]; item: T }[] | null {
  const n = left.length;
  const m = right.length;
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  const frontier = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let depth = 0; depth <= max; depth += 1) {
    trace.push(frontier.slice());
    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      const down = diagonal === -depth || (diagonal !== depth && frontier[offset + diagonal - 1] < frontier[offset + diagonal + 1]);
      let x = down ? frontier[offset + diagonal + 1] : frontier[offset + diagonal - 1] + 1;
      let y = x - diagonal;
      while (x < n && y < m && left[x] === right[y]) {
        x += 1;
        y += 1;
      }
      frontier[offset + diagonal] = x;
      if (x >= n && y >= m) return backtrack(trace, left, right, offset, depth);
    }
  }
  return null;
}

function backtrack<T>(trace: Int32Array[], left: T[], right: T[], offset: number, depth: number) {
  const steps: { type: DiffPart["type"]; item: T }[] = [];
  let x = left.length;
  let y = right.length;
  for (let level = depth; level > 0; level -= 1) {
    const frontier = trace[level];
    const diagonal = x - y;
    const down = diagonal === -level || (diagonal !== level && frontier[offset + diagonal - 1] < frontier[offset + diagonal + 1]);
    const previous = down ? diagonal + 1 : diagonal - 1;
    const previousX = frontier[offset + previous];
    const previousY = previousX - previous;
    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      steps.push({ type: "same", item: left[x] });
    }
    if (down) {
      y -= 1;
      steps.push({ type: "add", item: right[y] });
    } else {
      x -= 1;
      steps.push({ type: "del", item: left[x] });
    }
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    steps.push({ type: "same", item: left[x] });
  }
  return steps.reverse();
}

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
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const before = out[out.length - 1];
    const after = parts[index + 1];
    if (part.type === "same" && /^[ \t]+$/.test(part.text) && before && after && before.type !== "same" && after.type !== "same") {
      out.push({ type: "del", text: part.text }, { type: "add", text: part.text });
      continue;
    }
    out.push(part);
  }
  const dels: DiffPart[] = [];
  const result: DiffPart[] = [];
  let adds: DiffPart[] = [];
  const flush = () => {
    if (dels.length) result.push({ type: "del", text: dels.map((part) => part.text).join("") });
    if (adds.length) result.push({ type: "add", text: adds.map((part) => part.text).join("") });
    dels.length = 0;
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
  const head = before.slice(0, start);
  const tail = before.slice(endBefore);
  const left = tokens(before.slice(start, endBefore));
  const right = tokens(after.slice(start, endAfter));
  const steps = myers(left, right);
  const middle: DiffPart[] = steps
    ? steps.map((step) => ({ type: step.type, text: step.item }))
    : [
        { type: "del", text: left.join("") },
        { type: "add", text: right.join("") },
      ];
  return absorbSpaces(merge([{ type: "same", text: head }, ...middle, { type: "same", text: tail }]));
}

export function lineDiff(before: string, after: string, context = 1): LineDiff[] {
  const left = before.split("\n");
  const right = after.split("\n");
  const steps = myers(left, right) ?? [...left.map((item) => ({ type: "del" as const, item })), ...right.map((item) => ({ type: "add" as const, item }))];
  const lines: LineDiff[] = steps.map((step) => ({ sign: step.type === "same" ? " " : step.type === "add" ? "+" : "-", text: step.item }));
  const keep = lines.map(() => false);
  lines.forEach((line, index) => {
    if (line.sign === " ") return;
    for (let near = Math.max(0, index - context); near <= Math.min(lines.length - 1, index + context); near += 1) keep[near] = true;
  });
  const out: LineDiff[] = [];
  let skipped = false;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped && out.length) out.push({ sign: " ", text: "…" });
      skipped = false;
      out.push(line);
    } else skipped = true;
  });
  return out;
}

export function changeSummary(parts: DiffPart[]) {
  const added = parts.filter((part) => part.type === "add").reduce((sum, part) => sum + (part.text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0), 0);
  const removed = parts.filter((part) => part.type === "del").reduce((sum, part) => sum + (part.text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0), 0);
  return { added, removed };
}
