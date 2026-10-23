export const WRITING_STYLE =
  'No em dashes or en dashes. Never put a colon in the middle of a sentence; use a full stop or a comma instead. Never call an article a "piece"; say "article".';

const URL = /\bhttps?:\/\/\S+/gi;

export function midSentenceColons(text: string) {
  return text
    .replace(URL, "")
    .split("\n")
    .filter((line) => /(?<!\d):(?!\d)/.test(line.replace(/:\s*$/, "")))
    .map((line) => line.trim());
}

export function piecesOf(text: string) {
  return text.match(/\bpieces?\b/gi) ?? [];
}
