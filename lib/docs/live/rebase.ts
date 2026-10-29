import { ChangeSet, type ChangeSpec } from "@codemirror/state";
import { textEdits } from "@/lib/docs/live/text-diff";

export function changesBetween(from: string, to: string) {
  const specs: ChangeSpec[] = textEdits(from, to).map((edit) => ({ from: edit.at, to: edit.at + edit.remove, insert: edit.insert }));
  return ChangeSet.of(specs, from.length);
}

export function rebase(base: string, shown: string, shared: string) {
  const mine = changesBetween(base, shown);
  const theirs = changesBetween(base, shared);
  return { toShared: mine.map(theirs, true), toShown: theirs.map(mine) };
}
