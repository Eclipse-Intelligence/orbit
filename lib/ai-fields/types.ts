export const AI_FIELD_KINDS = ["yes_no", "number", "text", "pick"] as const;
export type AiFieldKind = (typeof AI_FIELD_KINDS)[number];

export const AI_FIELD_SCOPES = ["all", "view", "fit"] as const;
export type AiFieldScope = (typeof AI_FIELD_SCOPES)[number];

export const AI_FIELD_REFRESH = ["monthly", "weekly", "manual"] as const;
export type AiFieldRefresh = (typeof AI_FIELD_REFRESH)[number];

export const AI_FIELD_KIND_LABELS: Record<AiFieldKind, string> = {
  yes_no: "Yes or no",
  number: "Number",
  text: "Short text",
  pick: "Pick from list",
};

export const AI_FIELD_REFRESH_LABELS: Record<AiFieldRefresh, string> = {
  monthly: "Monthly",
  weekly: "Weekly",
  manual: "Only when I ask",
};

export const AI_FIELD_LABEL_MAX = 30;
export const AI_FIELD_OPTION_MAX = 40;
export const AI_FIELD_OPTIONS_MAX = 30;
export const AI_FIELDS_MAX = 20;

export type AiField = {
  id: string;
  label: string;
  question: string;
  kind: AiFieldKind;
  options: string[];
  multiple: boolean;
  scope: AiFieldScope;
  scopeViewId: string | null;
  scopeViewName: string | null;
  refresh: AiFieldRefresh;
  paused: boolean;
  fillsSize: boolean;
  webCheckId: string | null;
  position: number;
  lastRunAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  createdAt: string;
};

export type AiValue = boolean | number | string | string[] | null;

export type AiCellState = "answered" | "unknown" | "checking" | "outside";

export type AiCell = { state: AiCellState; value: AiValue; manual: boolean };

export type AiSource = { title: string | null; url: string };

export type AiWebAnswer = {
  state: "answered" | "unknown";
  value: AiValue;
  likelihood: number | null;
  confidence: "high" | "medium" | "low" | null;
  reason: string | null;
  sources: AiSource[];
  checkedAt: string | null;
};

export type AiAnswer = AiCell & {
  fieldId: string;
  companyId: string;
  likelihood: number | null;
  confidence: "high" | "medium" | "low" | null;
  reason: string | null;
  sources: AiSource[];
  checkedAt: string | null;
  nextCheckAt: string | null;
  manualAt: string | null;
  manualByName: string | null;
  web: AiWebAnswer | null;
  error: string | null;
};

export type AiFieldStats = { fieldId: string; total: number; answered: number; checked: number; running: number; nextCheckAt: string | null };

export type CompanyView = { id: string; name: string; params: string; createdAt: string };

export function displayAiValue(field: Pick<AiField, "kind">, value: AiValue): string {
  if (value === null || value === undefined) return "";
  if (field.kind === "yes_no") return value === true ? "Yes" : value === false ? "No" : "";
  if (field.kind === "number") return typeof value === "number" ? value.toLocaleString("en-GB", { maximumFractionDigits: 2 }) : String(value);
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

export function likelihoodText(answer: { likelihood: number | null; confidence: "high" | "medium" | "low" | null; state: string }) {
  if (answer.confidence) return `${answer.confidence[0].toUpperCase()}${answer.confidence.slice(1)} confidence`;
  if (answer.likelihood === null) return null;
  const percent = Math.round(answer.likelihood * 100);
  return `${percent}% likely`;
}

export const MONTHLY_LIMIT_USD = 100;
export const DECISION_COST = 0.001;
export const TASK_COST = 0.01;
const WEEKS_A_MONTH = 52 / 12;

export function usesDecisions(kind: AiFieldKind) {
  return kind === "yes_no" || kind === "pick";
}

export function money(amount: number) {
  if (amount > 0 && amount < 0.01) return "under $0.01";
  return `$${amount.toFixed(2)}`;
}

export function costHint(kind: AiFieldKind, companies: number, refresh: AiFieldRefresh) {
  const unit = usesDecisions(kind) ? DECISION_COST : TASK_COST;
  const count = Math.max(0, Math.round(companies));
  const fill = count * unit;
  const monthly = refresh === "manual" ? 0 : refresh === "weekly" ? fill * WEEKS_A_MONTH : fill;
  const checks = `About ${count.toLocaleString("en-GB")} web ${count === 1 ? "check" : "checks"} to fill it, ${money(fill)}`;
  const text = refresh === "manual" ? `${checks}, then only when you ask.` : `${checks}, then about ${money(monthly)} a month.`;
  const note = usesDecisions(kind)
    ? "Yes or no and pick from list questions about the same company share one check, so more of them cost no more."
    : "Numbers and short text need a longer check, $0.01 a company. Other number and short text fields share it.";
  return { fill, monthly, text, note };
}

const STAFF_PATTERN = /\b(staff|employees?|headcount|head count|workforce|team size|people work|work(?:s|ing)? (?:at|for)|how many people)\b/i;

export function looksLikeStaff(label: string, question: string) {
  return STAFF_PATTERN.test(label) || STAFF_PATTERN.test(question);
}

export function sizeForStaff(count: number) {
  if (!Number.isFinite(count) || count < 1) return null;
  if (count <= 10) return "1-10";
  if (count <= 50) return "11-50";
  if (count <= 200) return "51-200";
  if (count <= 1000) return "201-1000";
  return "1000+";
}
