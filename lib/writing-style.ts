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

const UNITS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const TEENS = ["ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const NUMBER_WORD = new RegExp(
  `\\b(?:(${TENS.slice(2).join("|")})(?:[- ](${UNITS.slice(1).join("|")}))?|(${[...UNITS.slice(2), ...TEENS].join("|")}))\\b`,
  "gi",
);

function wordValue(tens: string | undefined, unit: string | undefined, single: string | undefined) {
  if (tens) return TENS.indexOf(tens.toLowerCase()) * 10 + (unit ? UNITS.indexOf(unit.toLowerCase()) : 0);
  const word = (single ?? "").toLowerCase();
  return UNITS.includes(word) ? UNITS.indexOf(word) : 10 + TEENS.indexOf(word);
}

export function spelledFigures(reply: string, source: string) {
  const figures = new Set((source.replace(/^\s*\d+[.)]\s/gm, "").match(/\d+/g) ?? []).map(Number));
  return [...reply.matchAll(NUMBER_WORD)].filter((match) => figures.has(wordValue(match[1], match[2], match[3]))).map((match) => match[0]);
}
