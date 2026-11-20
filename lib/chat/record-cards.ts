import { chatApi } from "@/lib/chat/client";
import type { ChatRecordCard, RecordRef } from "@/lib/chat/links";

export const RECORD_CARD_FRESH_MS = 30_000;

type Entry = { at: number; card: ChatRecordCard | null };
type Loader = (refs: RecordRef[]) => Promise<ChatRecordCard[]>;

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<void>>();

export function recordKey(ref: RecordRef) {
  return `${ref.kind}:${ref.id}`;
}

export function refsFromKey(key: string): RecordRef[] {
  return key
    .split(",")
    .filter(Boolean)
    .map((part) => {
      const [kind, id] = part.split(":");
      return { kind, id } as RecordRef;
    });
}

export function forgetRecordCards() {
  entries.clear();
  inflight.clear();
}

function fresh(ref: RecordRef, now: number) {
  const entry = entries.get(recordKey(ref));
  return entry && now - entry.at <= RECORD_CARD_FRESH_MS ? entry : null;
}

export async function loadRecordCards(
  refs: RecordRef[],
  options: { load?: Loader; now?: () => number } = {},
): Promise<ChatRecordCard[]> {
  const load = options.load ?? ((wanted) => chatApi.records(wanted).then((result) => result.cards));
  const now = options.now ?? Date.now;
  const missing = refs.filter((ref) => !fresh(ref, now()) && !inflight.has(recordKey(ref)));
  if (missing.length > 0) {
    const request = load(missing)
      .then((cards) => {
        const at = now();
        for (const ref of missing) {
          const card = cards.find((item) => item.kind === ref.kind && item.id === ref.id) ?? null;
          entries.set(recordKey(ref), { at, card });
        }
      })
      .catch(() => undefined)
      .finally(() => {
        for (const ref of missing) inflight.delete(recordKey(ref));
      });
    for (const ref of missing) inflight.set(recordKey(ref), request);
  }
  await Promise.all(refs.map((ref) => inflight.get(recordKey(ref))));
  return refs.flatMap((ref) => {
    const card = fresh(ref, now())?.card;
    return card ? [card] : [];
  });
}
