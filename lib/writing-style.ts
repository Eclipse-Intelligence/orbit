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
const NUMBER_WORD = `(?:(?:${TENS.slice(2).join("|")})(?:[- ](?:${UNITS.slice(1).join("|")}))?|${[...UNITS.slice(1), ...TEENS].join("|")})`;
const DIGITS = String.raw`\d{1,3}`;
const QUANTITY_UNITS =
  "hrs?|hours?|days?|wks?|weeks?|months?|yrs?|years?|mins?|minutes?|people|persons?|deals?|prospects?|clients?|customers?|leads?|meetings?|calls?|demos?|seats?|users?|sessions?|companies|accounts?";
const NOT_QUANTITIES = [
  /^\s*\d+[.)]\s/gm,
  /\b\d{4}-\d{1,2}-\d{1,2}\b/g,
  /\b\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?\b/g,
  /\b\d{1,2}:\d{2}\b/g,
  /\b\d{1,2}(?:\s*-\s*\d{1,2})?\s*[ap]\.?m\b/gi,
  /\b\d+(?:st|nd|rd|th)\b/gi,
  /[£$€]\s?\d[\d,.]*(?:\s?(?:k|m|bn)\b)?/gi,
  /\b\d[\d,.]*\s?(?:k|m|bn)?\s?(?:gbp|usd|eur|pounds?|dollars?|euros?)\b/gi,
  /\b\d[\d.]*\s?(?:%|per ?cent\b)/gi,
];
const UNIT_NAMES: Record<string, string> = { hr: "hour", wk: "week", yr: "year", min: "minute", people: "person", companies: "company" };

function rangeOf(number: string) {
  return new RegExp(String.raw`\b(${number})\s*(?:-|\bto\b)\s*(${number})\b`, "gi");
}

function quantityOf(number: string) {
  return new RegExp(String.raw`\b(${number})[\s-]*(${QUANTITY_UNITS})\b`, "gi");
}

function unitName(unit: string) {
  const word = unit.toLowerCase();
  const base = UNIT_NAMES[word] ?? word.replace(/s$/, "");
  return UNIT_NAMES[base] ?? base;
}

function wordValue(text: string) {
  const [first, second] = text.toLowerCase().split(/[- ]/);
  if (TENS.includes(first)) return TENS.indexOf(first) * 10 + (second ? UNITS.indexOf(second) : 0);
  return UNITS.includes(first) ? UNITS.indexOf(first) : 10 + TEENS.indexOf(first);
}

function quantities(source: string) {
  const text = NOT_QUANTITIES.reduce((rest, pattern) => rest.replace(pattern, " "), source);
  const ranges = new Set<string>();
  for (const [, low, high] of text.matchAll(rangeOf(DIGITS))) if (Number(low) < Number(high)) ranges.add(`${Number(low)}-${Number(high)}`);
  const counts = new Set([...text.matchAll(quantityOf(DIGITS))].map(([, count, unit]) => `${Number(count)} ${unitName(unit)}`));
  return { ranges, counts };
}

export function spelledFigures(reply: string, source: string) {
  const { ranges, counts } = quantities(source);
  if (!ranges.size && !counts.size) return [];
  const found: string[] = [];
  const rest = reply.replace(rangeOf(NUMBER_WORD), (match, low: string, high: string) => {
    if (!ranges.has(`${wordValue(low)}-${wordValue(high)}`)) return match;
    found.push(match);
    return " ";
  });
  for (const [match, count, unit] of rest.matchAll(quantityOf(NUMBER_WORD))) if (counts.has(`${wordValue(count)} ${unitName(unit)}`)) found.push(match);
  return found;
}
