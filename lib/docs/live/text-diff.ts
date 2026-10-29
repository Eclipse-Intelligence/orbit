export type TextEdit = { at: number; remove: number; insert: string };

const LINE_STEPS_MAX = 1_200;
const CHAR_STEPS_MAX = 400;
const CHAR_BLOCK_MAX = 6_000;

type Op = { kind: "same" | "remove" | "add"; tokens: string[] };

function isHigh(code: number) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLow(code: number) {
  return code >= 0xdc00 && code <= 0xdfff;
}

function prefixLength(left: string, right: string) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  if (index > 0 && isHigh(left.charCodeAt(index - 1))) index -= 1;
  return index;
}

function suffixLength(left: string, right: string, prefix: number) {
  const limit = Math.min(left.length, right.length) - prefix;
  let count = 0;
  while (count < limit && left.charCodeAt(left.length - 1 - count) === right.charCodeAt(right.length - 1 - count)) count += 1;
  if (count > 0 && isLow(left.charCodeAt(left.length - count))) count -= 1;
  return count;
}

function lines(text: string) {
  if (!text) return [];
  const parts = text.split("\n");
  return parts.map((part, index) => (index < parts.length - 1 ? `${part}\n` : part)).filter((part) => part !== "");
}

function myers(before: string[], after: string[], maxSteps: number): Op[] | null {
  const n = before.length;
  const m = after.length;
  const max = n + m;
  if (max === 0) return [];
  const offset = max + 1;
  const frontier = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let step = 0; step <= Math.min(max, maxSteps); step += 1) {
    const snapshot = new Int32Array(2 * step + 1);
    for (let diagonal = -step; diagonal <= step; diagonal += 2) {
      let x =
        diagonal === -step || (diagonal !== step && frontier[offset + diagonal - 1] < frontier[offset + diagonal + 1])
          ? frontier[offset + diagonal + 1]
          : frontier[offset + diagonal - 1] + 1;
      let y = x - diagonal;
      while (x < n && y < m && before[x] === after[y]) {
        x += 1;
        y += 1;
      }
      frontier[offset + diagonal] = x;
      if (x >= n && y >= m) {
        found = step;
        break;
      }
    }
    for (let diagonal = -step; diagonal <= step; diagonal += 1) snapshot[diagonal + step] = frontier[offset + diagonal];
    trace.push(snapshot);
    if (found >= 0) break;
  }
  if (found < 0) return null;
  const reversed: { kind: Op["kind"]; token: string }[] = [];
  let x = n;
  let y = m;
  for (let step = found; step > 0; step -= 1) {
    const previous = trace[step - 1];
    const at = (diagonal: number) => previous[diagonal + step - 1];
    const diagonal = x - y;
    const down = diagonal === -step || (diagonal !== step && at(diagonal - 1) < at(diagonal + 1));
    const previousDiagonal = down ? diagonal + 1 : diagonal - 1;
    const previousX = at(previousDiagonal);
    const previousY = previousX - previousDiagonal;
    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      reversed.push({ kind: "same", token: before[x] });
    }
    if (down) {
      y -= 1;
      reversed.push({ kind: "add", token: after[y] });
    } else {
      x -= 1;
      reversed.push({ kind: "remove", token: before[x] });
    }
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    reversed.push({ kind: "same", token: before[x] });
  }
  const ops: Op[] = [];
  for (let index = reversed.length - 1; index >= 0; index -= 1) {
    const entry = reversed[index];
    const last = ops[ops.length - 1];
    if (last && last.kind === entry.kind) last.tokens.push(entry.token);
    else ops.push({ kind: entry.kind, tokens: [entry.token] });
  }
  return ops;
}

function trimmedReplace(at: number, before: string, after: string): TextEdit[] {
  if (before === after) return [];
  const head = prefixLength(before, after);
  const tail = suffixLength(before, after, head);
  return [{ at: at + head, remove: before.length - head - tail, insert: after.slice(head, after.length - tail) }];
}

function charEdits(at: number, before: string, after: string): TextEdit[] {
  const head = prefixLength(before, after);
  const tail = suffixLength(before, after, head);
  const left = before.slice(head, before.length - tail);
  const right = after.slice(head, after.length - tail);
  if (!left && !right) return [];
  const start = at + head;
  if (!left || !right) return [{ at: start, remove: left.length, insert: right }];
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  if (leftPoints.length + rightPoints.length > CHAR_BLOCK_MAX) return [{ at: start, remove: left.length, insert: right }];
  const ops = myers(leftPoints, rightPoints, CHAR_STEPS_MAX);
  if (!ops) return [{ at: start, remove: left.length, insert: right }];
  return opsToEdits(start, ops);
}

function opsToEdits(start: number, ops: Op[]): TextEdit[] {
  const edits: TextEdit[] = [];
  let position = start;
  for (const op of ops) {
    const text = op.tokens.join("");
    if (op.kind === "same") {
      position += text.length;
      continue;
    }
    const last = edits[edits.length - 1];
    const touching = last && last.at + last.remove === position;
    if (op.kind === "remove") {
      if (touching && last.insert === "") last.remove += text.length;
      else edits.push({ at: position, remove: text.length, insert: "" });
      position += text.length;
    } else if (touching) {
      last.insert += text;
    } else {
      edits.push({ at: position, remove: 0, insert: text });
    }
  }
  return edits;
}

export function textEdits(before: string, after: string): TextEdit[] {
  if (before === after) return [];
  const head = prefixLength(before, after);
  const tail = suffixLength(before, after, head);
  const left = before.slice(head, before.length - tail);
  const right = after.slice(head, after.length - tail);
  if (!left || !right) return [{ at: head, remove: left.length, insert: right }];
  const ops = myers(lines(left), lines(right), LINE_STEPS_MAX);
  if (!ops) return trimmedReplace(head, left, right);
  const edits: TextEdit[] = [];
  let position = head;
  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index];
    const text = op.tokens.join("");
    if (op.kind === "same") {
      position += text.length;
      continue;
    }
    if (op.kind === "remove" && ops[index + 1]?.kind === "add") {
      const added = ops[index + 1].tokens.join("");
      edits.push(...charEdits(position, text, added));
      position += text.length;
      index += 1;
      continue;
    }
    if (op.kind === "remove") {
      edits.push({ at: position, remove: text.length, insert: "" });
      position += text.length;
    } else {
      edits.push({ at: position, remove: 0, insert: text });
    }
  }
  return edits;
}

export function applyEdits(text: string, edits: TextEdit[]) {
  let result = "";
  let cursor = 0;
  for (const edit of edits) {
    result += text.slice(cursor, edit.at) + edit.insert;
    cursor = edit.at + edit.remove;
  }
  return result + text.slice(cursor);
}
