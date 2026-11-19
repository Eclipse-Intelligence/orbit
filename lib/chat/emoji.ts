import { EMOJI_ROWS } from "@/lib/chat/emoji-data";

export type ChatEmoji = { emoji: string; codes: string[]; words: string[]; group: number; tones: boolean };

export const EMOJI_GROUPS: { id: number; label: string }[] = [
  { id: 0, label: "Smileys and people" },
  { id: 3, label: "Animals and nature" },
  { id: 4, label: "Food and drink" },
  { id: 5, label: "Travel and places" },
  { id: 6, label: "Activities" },
  { id: 7, label: "Objects" },
  { id: 8, label: "Symbols" },
  { id: 9, label: "Flags" },
];

export const SKIN_TONES = ["", "\u{1F3FB}", "\u{1F3FC}", "\u{1F3FD}", "\u{1F3FE}", "\u{1F3FF}"] as const;

export const SKIN_TONE_LABELS = ["Default skin tone", "Light skin tone", "Medium light skin tone", "Medium skin tone", "Medium dark skin tone", "Dark skin tone"] as const;

const SELECTORS = /[︎️]/g;
const TONE_MARKS = /[\u{1F3FB}-\u{1F3FF}]/gu;
const EMOJI_TEXT_MAX = 64;

export const CHAT_EMOJI: ChatEmoji[] = EMOJI_ROWS.map(([emoji, codes, words, group, tones]) => ({
  emoji,
  codes: codes.split(" "),
  words: words ? words.split(" ") : [],
  group,
  tones: tones === 1,
}));

const BY_KEY = new Map(CHAT_EMOJI.map((item) => [bare(item.emoji), item]));

function bare(text: string) {
  return text.replace(SELECTORS, "");
}

export function withTone(emoji: string, tone: number) {
  const mark = SKIN_TONES[tone] ?? "";
  if (!mark) return emoji;
  const item = BY_KEY.get(bare(emoji));
  if (!item?.tones) return emoji;
  const [first, ...rest] = Array.from(bare(item.emoji));
  return `${first}${mark}${rest.join("")}`;
}

export function emojiEntry(text: string) {
  return BY_KEY.get(bare(text).replace(TONE_MARKS, "")) ?? null;
}

export function chatEmoji(input: unknown): string | null {
  if (typeof input !== "string" || input.length === 0 || input.length > EMOJI_TEXT_MAX) return null;
  const plain = bare(input.normalize("NFC"));
  const exact = BY_KEY.get(plain);
  if (exact) return exact.emoji;
  const marks = plain.match(TONE_MARKS) ?? [];
  if (marks.length !== 1) return null;
  const base = BY_KEY.get(plain.replace(TONE_MARKS, ""));
  if (!base?.tones) return null;
  const tone = SKIN_TONES.indexOf(marks[0] as (typeof SKIN_TONES)[number]);
  const toned = withTone(base.emoji, tone);
  return toned === plain ? toned : null;
}

export function emojiByCode(input: unknown) {
  if (typeof input !== "string") return null;
  const code = input.trim().toLowerCase().replace(/^:|:$/g, "");
  return CHAT_EMOJI.find((item) => item.codes.includes(code))?.emoji ?? null;
}

export function emojiName(text: string) {
  return emojiEntry(text)?.codes[0] ?? null;
}

function score(item: ChatEmoji, query: string) {
  let best = Infinity;
  for (const code of item.codes) {
    if (code === query) return 0;
    if (code.startsWith(query)) best = Math.min(best, 1);
    else if (code.includes(`_${query}`)) best = Math.min(best, 2);
  }
  if (best < Infinity) return best;
  if (item.words.some((word) => word.startsWith(query))) return 3;
  return Infinity;
}

export function searchEmoji(text: string, limit = 60): ChatEmoji[] {
  const query = text.trim().toLowerCase().replace(/^:|:$/g, "").replace(/\s+/g, "_");
  if (!query) return [];
  return CHAT_EMOJI.map((item, index) => ({ item, index, rank: score(item, query) }))
    .filter((entry) => entry.rank < Infinity)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .slice(0, limit)
    .map((entry) => entry.item);
}
