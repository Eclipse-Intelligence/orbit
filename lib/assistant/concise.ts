export const DETAIL_PARAM = {
  type: "string",
  enum: ["concise", "full"],
  description:
    "concise (the default) returns the newest entries with long texts shortened and says what it left out. full returns everything, including every timeline entry in full.",
};

type ConciseRule = { lists: Record<string, number>; text: number; summaries?: string };

export const CONCISE_TOOLS: Record<string, ConciseRule> = {
  get_company: { lists: { timeline: 25, knowledge: 40 }, text: 1_200, summaries: "insights" },
  get_contact: { lists: { timeline: 25, completedTasks: 20 }, text: 1_200, summaries: "callSummaries" },
  list_activities: { lists: {}, text: 1_200 },
};

const TEXT_FIELDS = ["body", "summary"];

export function withDetail<T>(name: string, parameters: T): T {
  if (!CONCISE_TOOLS[name]) return parameters;
  const shape = (parameters ?? { type: "object", properties: {} }) as { properties?: Record<string, unknown> };
  return { ...shape, properties: { ...(shape.properties ?? {}), detail: DETAIL_PARAM } } as T;
}

function shorten(item: unknown, max: number, counts: { texts: number }) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  const record = item as Record<string, unknown>;
  let changed: Record<string, unknown> | null = null;
  for (const field of TEXT_FIELDS) {
    const value = record[field];
    if (typeof value !== "string" || value.length <= max) continue;
    changed ??= { ...record };
    changed[field] = `${value.slice(0, max).trimEnd()}… [${(value.length - max).toLocaleString("en-GB")} more characters]`;
    counts.texts += 1;
  }
  return changed ?? record;
}

export function conciseResult(name: string, args: Record<string, unknown>, output: unknown): unknown {
  const rule = CONCISE_TOOLS[name];
  if (!rule || args.detail === "full" || !output || typeof output !== "object" || Array.isArray(output) || "error" in output) return output;
  const result = { ...(output as Record<string, unknown>) };
  const counts = { texts: 0 };
  const left: string[] = [];
  for (const [field, limit] of Object.entries(rule.lists)) {
    const list = result[field];
    if (!Array.isArray(list) || list.length <= limit) continue;
    result[field] = list.slice(0, limit);
    left.push(`the newest ${limit} of ${list.length} ${field === "completedTasks" ? "completed tasks" : field === "knowledge" ? "Knowledge items" : "timeline entries"}`);
  }
  for (const field of ["timeline", "data"]) {
    if (Array.isArray(result[field])) result[field] = (result[field] as unknown[]).map((item) => shorten(item, rule.text, counts));
  }
  const timeline = Array.isArray(result.timeline) ? (result.timeline as { id?: unknown }[]) : null;
  if (rule.summaries && timeline && result[rule.summaries] && typeof result[rule.summaries] === "object") {
    const shown = new Set(timeline.map((item) => item.id));
    result[rule.summaries] = Object.fromEntries(Object.entries(result[rule.summaries] as Record<string, unknown>).filter(([id]) => shown.has(id)));
  }
  if (left.length === 0 && counts.texts === 0) return output;
  const parts = [...left, ...(counts.texts > 0 ? [`${counts.texts === 1 ? "1 long text" : `${counts.texts} long texts`} shortened`] : [])];
  return {
    ...result,
    detail: "concise",
    detailNote: `Concise view: ${parts.join(", ")}. Call ${name} again with detail "full" when you need the rest.`,
  };
}
