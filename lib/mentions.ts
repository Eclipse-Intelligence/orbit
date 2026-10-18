export const MENTION_KINDS = ["contact", "company", "task", "opportunity"] as const;
export type MentionKind = (typeof MENTION_KINDS)[number];

export type Mention = { kind: MentionKind; id: string; name: string };

export type MentionPiece = { text: string } | { mention: Mention };

const TOKEN = /@\[([^\]\n]{1,200})\]\((contact|company|task|opportunity):([0-9a-f-]{36})\)/g;

const LABELS: Record<MentionKind, string> = { contact: "person", company: "company", task: "task", opportunity: "opportunity" };

export function mentionToken(mention: Mention) {
  return `@[${mention.name.replace(/[[\]\n]/g, " ").trim()}](${mention.kind}:${mention.id})`;
}

export function splitMentions(text: string): MentionPiece[] {
  const pieces: MentionPiece[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index ?? 0;
    if (start > last) pieces.push({ text: text.slice(last, start) });
    pieces.push({ mention: { name: match[1], kind: match[2] as MentionKind, id: match[3] } });
    last = start + match[0].length;
  }
  if (last < text.length) pieces.push({ text: text.slice(last) });
  return pieces;
}

export function mentionsIn(text: string) {
  return splitMentions(text).flatMap((piece) => ("mention" in piece ? [piece.mention] : []));
}

export function plainMentions(text: string) {
  return text.replace(TOKEN, (_whole, name: string) => `@${name}`);
}

export function namedMentions(text: string) {
  return text.replace(TOKEN, (_whole, name: string) => name);
}

export function expandMentions(text: string) {
  return text.replace(TOKEN, (_whole, name: string, kind: MentionKind, id: string) => `${name} [${LABELS[kind]} id ${id}]`);
}

export function encodeMentions(text: string, mentions: Mention[]) {
  let output = text;
  const used = new Set<string>();
  for (const mention of [...mentions].sort((left, right) => right.name.length - left.name.length)) {
    const key = `${mention.kind}:${mention.id}`;
    if (used.has(key)) continue;
    const label = `@${mention.name}`;
    const index = output.indexOf(label);
    if (index < 0) continue;
    output = `${output.slice(0, index)}${mentionToken(mention)}${output.slice(index + label.length)}`;
    used.add(key);
  }
  return output;
}

export function liveMentions(text: string, mentions: Mention[]) {
  return mentions.filter((mention) => text.includes(`@${mention.name}`));
}
