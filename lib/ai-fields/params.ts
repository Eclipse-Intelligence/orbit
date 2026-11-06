export const AI_PARAM_PREFIX = "ai.";
export const AI_SORT_PREFIX = "ai.";
export const UNKNOWN_TOKEN = "?";
const OPTION_SEPARATOR = "|";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AiFilter =
  | { fieldId: string; op: "is"; value: "yes" | "no" | "unknown" }
  | { fieldId: string; op: "range"; min: number | null; max: number | null; unknown: boolean }
  | { fieldId: string; op: "has"; text: string }
  | { fieldId: string; op: "any"; options: string[]; unknown: boolean };

export function aiParamKey(fieldId: string) {
  return `${AI_PARAM_PREFIX}${fieldId}`;
}

export function aiSortValue(fieldId: string) {
  return `${AI_SORT_PREFIX}${fieldId}`;
}

export function aiSortField(sort: string | null | undefined) {
  if (!sort?.startsWith(AI_SORT_PREFIX)) return null;
  const id = sort.slice(AI_SORT_PREFIX.length);
  return UUID.test(id) ? id.toLowerCase() : null;
}

function finite(text: string) {
  if (!text.trim()) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : undefined;
}

export function parseAiFilter(fieldId: string, raw: string): AiFilter | null {
  if (!UUID.test(fieldId)) return null;
  const id = fieldId.toLowerCase();
  const split = raw.indexOf(":");
  if (split < 0) return null;
  const op = raw.slice(0, split);
  const body = raw.slice(split + 1);
  if (op === "is") return body === "yes" || body === "no" || body === "unknown" ? { fieldId: id, op, value: body } : null;
  if (op === "has") {
    const text = body.trim().slice(0, 100);
    return text ? { fieldId: id, op, text } : null;
  }
  const parts = body.split(OPTION_SEPARATOR);
  const unknown = parts.includes(UNKNOWN_TOKEN);
  const rest = parts.filter((part) => part !== UNKNOWN_TOKEN);
  if (op === "range") {
    const [from = "", to = ""] = (rest[0] ?? "").split("..");
    const min = finite(from);
    const max = finite(to);
    if (min === undefined || max === undefined) return null;
    if (min === null && max === null && !unknown) return null;
    return { fieldId: id, op, min, max, unknown };
  }
  if (op === "any") {
    const options = [...new Set(rest.map((part) => part.trim()).filter(Boolean))].slice(0, 30);
    if (options.length === 0 && !unknown) return null;
    return { fieldId: id, op, options, unknown };
  }
  return null;
}

export function aiFilterValue(filter: AiFilter) {
  if (filter.op === "is") return `is:${filter.value}`;
  if (filter.op === "has") return `has:${filter.text}`;
  const tail = filter.unknown ? [UNKNOWN_TOKEN] : [];
  if (filter.op === "range") return `range:${[`${filter.min ?? ""}..${filter.max ?? ""}`, ...tail].join(OPTION_SEPARATOR)}`;
  return `any:${[...filter.options, ...tail].join(OPTION_SEPARATOR)}`;
}

export function aiFiltersFromParams(params: URLSearchParams) {
  const filters: AiFilter[] = [];
  for (const [key, value] of params.entries()) {
    if (!key.startsWith(AI_PARAM_PREFIX)) continue;
    const filter = parseAiFilter(key.slice(AI_PARAM_PREFIX.length), value);
    if (filter && !filters.some((item) => item.fieldId === filter.fieldId)) filters.push(filter);
    if (filters.length >= 20) break;
  }
  return filters;
}

export function validOptionName(option: string) {
  return option !== UNKNOWN_TOKEN && !option.includes(OPTION_SEPARATOR);
}

const VIEW_PARAMS_SKIPPED = new Set(["page", "view", "record", "limit", "offset"]);

export function normaliseViewParams(value: string | URLSearchParams) {
  const params = typeof value === "string" ? new URLSearchParams(value.replace(/^\?/, "")) : value;
  const kept = new URLSearchParams();
  for (const [key, entry] of params.entries()) {
    if (VIEW_PARAMS_SKIPPED.has(key) || !entry) continue;
    if (key.length > 60 || entry.length > 500) continue;
    kept.set(key, entry);
  }
  kept.sort();
  return kept.toString();
}
