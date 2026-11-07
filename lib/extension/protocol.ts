export const EXTENSION_SOURCE = "linkedin_extension";
export const EXTENSION_TOKEN_PREFIX = "olx_";
export const WORKSPACE_HEADER = "x-orbit-workspace";
export const PAIRING_TTL_MINUTES = 10;
export const SALES_NAVIGATOR_ID = /^[A-Za-z0-9_-]{6,120}$/;
export const LINKEDIN_PROFILE_SLUG = /^[\p{L}\p{M}\p{N}_-]{2,100}$/u;

export function linkedinProfileSlug(segment: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  const slug = decoded.normalize("NFC").toLowerCase();
  return LINKEDIN_PROFILE_SLUG.test(slug) ? slug : null;
}

const LETTERS = "\\p{L}{3,12}\\.?";
const MONTH_NAME = "(?:jan|feb|f[eé]v|m[aä]r|apr|avr|abr|ma[iy]|mag|mei|jun|jui|giu|jul|lug|aug|ao[uû]|ago|sep|set|o[ck]t|ott|nov|de[cz]|d[eé]c|dic|ene|gen)\\p{L}*\\.?";
const DATE_SHAPE = `(?:(?:\\d{1,2}\\.?\\s+)?(?:${LETTERS}\\s+(?:de\\s+)?)?\\d{4}|\\d{1,2}[./]\\d{4})`;
const RANGE_END = `(${DATE_SHAPE}|[\\p{L}'\u2019]+(?:\\s+[\\p{L}'\u2019]+){0,2})`;
const SEPARATOR = "(?:\\s*[-\u2013\u2014]\\s*|\\s+(?:to|until|bis|a|à|al|tot|até|au)\\s+)";
const DATE_RANGE = new RegExp(`^${DATE_SHAPE}${SEPARATOR}${RANGE_END}(?:\\s*,.*)?$`, "iu");
const CURRENT = "(?:present|now|today|heute|actualidad|actualmente|aujourd['\u2019]hui|atual|presente|huidig|heden|oggi|o momento)";
const SINGLE_DATE = new RegExp(`^(?:(?:\\d{1,2}\\.?\\s+)?(?:${MONTH_NAME}\\s+(?:de\\s+)?)?\\d{4}|${CURRENT})$`, "iu");
const DURATION_UNIT =
  "(?:yrs?|years?|mos?|months?|j\\.?|jahre?n?|mon\\.?|monate?n?|años?|meses|mes|ans?|mois|anni|anno|mesi|mese|jaar|jaren|jr\\.?|maanden|maand|mnd\\.?|anos?)";
const DURATION = new RegExp(`^(?:less than (?:a|one) (?:year|month)|(?:\\d+\\+?\\s*${DURATION_UNIT}(?:\\s+|$))+)$`, "iu");
const EMPLOYMENT =
  /^(?:full[- ]time|part[- ]time|self[- ]employed|freelance|freelancer|contract|contractor|internship|apprenticeship|seasonal|permanent|temporary|volunteer|trainee|vollzeit|teilzeit|selbstst[aä]ndig|freiberuflich|praktikum|jornada (?:completa|parcial)|aut[oó]nomo|temps (?:plein|partiel)|ind[eé]pendant|tempo (?:integral|parcial)|aut[oô]nomo|tempo pieno|voltijd|deeltijd|zzp)$/iu;

function dateParts(value: string | null | undefined) {
  if (typeof value !== "string") return [];
  return value
    .replace(/\s+/g, " ")
    .split(/\s*[·•]\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function dateRangeIn(value: string | null | undefined): "current" | "past" | null {
  const first = dateParts(value)[0];
  const match = first ? DATE_RANGE.exec(first) : null;
  if (!match) return null;
  return /\d{4}/.test(match[1]) ? "past" : "current";
}

export function looksLikeDateOrDuration(value: string | null | undefined) {
  return dateParts(value).some((part) => DATE_RANGE.test(part) || SINGLE_DATE.test(part) || DURATION.test(part));
}

export function looksLikeEmploymentType(value: string | null | undefined) {
  return dateParts(value).some((part) => EMPLOYMENT.test(part));
}

export type PairStartResponse = { code: string; secret: string; expiresAt: string; approveUrl: string };

export type PairRedeemResponse =
  | { status: "pending"; expiresAt: string }
  | { status: "approved"; token: string; browser: { id: string; name: string } };

type Person = { id: string; name: string };

type ExtensionStage = { id: string; name: string };

export type ExtensionBoard = { id: string; name: string; kind: "sales" | "board"; stages: ExtensionStage[] };

type ExtensionLifecycle = { value: string; label: string };

export type ExtensionWorkspace = {
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
  members: Person[];
  boards: ExtensionBoard[];
  lifecycles: ExtensionLifecycle[];
};

export type MeResponse = {
  browser: { id: string; name: string };
  user: { id: string; name: string; email: string };
  orbitUrl: string;
  homeWorkspaceId: string | null;
  workspaces: ExtensionWorkspace[];
};

export type PageKind = "person" | "lead" | "company" | "conversation" | "other";

export type MatchStatus = "in" | "maybe" | "none";

export type PersonMatch = "linkedin" | "sales_navigator" | "name";

export type CompanyMatch = "linkedin" | "domain" | "name";

export type DealSummary = { id: string; name: string; value: string | null; board: string; stage: string | null };

export type TaskSummary = { id: string; title: string; dueAt: string | null; dueLabel: string | null; overdue: boolean; dueToday: boolean };

export type LastContact = { kind: string; title: string; occurredAt: string; whenLabel: string };

export type CompanyBrief = {
  id: string;
  name: string;
  domain: string | null;
  lifecycle: string;
  lifecycleLabel: string;
  linkedinUrl: string | null;
  url: string;
};

export type PersonSummary = {
  id: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  jobTitle: string | null;
  email: string | null;
  location: string | null;
  linkedinUrl: string | null;
  salesNavigatorUrl: string | null;
  tags: string[];
  owner: Person | null;
  company: CompanyBrief | null;
  deal: DealSummary | null;
  lastContact: LastContact | null;
  tasks: TaskSummary[];
  addedLabel: string;
  url: string;
};

type AiFieldValue = { id: string; label: string; value: string; detail: string | null; meta: string | null };

export type CompanySummary = {
  id: string;
  name: string;
  domain: string | null;
  website: string | null;
  industry: string | null;
  sizeCategory: string | null;
  lifecycle: string;
  lifecycleLabel: string;
  linkedinUrl: string | null;
  tags: string[];
  owner: Person | null;
  deal: DealSummary | null;
  people: { id: string; name: string; jobTitle: string | null }[];
  openTasks: number;
  nextDueLabel: string | null;
  tasks: TaskSummary[];
  aiFields: AiFieldValue[];
  url: string;
};

export type LookupQuery = {
  url: string;
  linkedinUrl?: string;
  name?: string;
  company?: string;
  companyUrl?: string;
  domain?: string;
};

export type WorkspaceLookup = {
  workspaceId: string;
  workspaceName: string;
  status: MatchStatus;
  matchedOn: PersonMatch | CompanyMatch | null;
  person: PersonSummary | null;
  company: CompanySummary | null;
  candidates: PersonSummary[];
  companyCandidates: CompanySummary[];
  presence: string;
};

export type LookupResponse = { kind: PageKind; url: string | null; workspaces: WorkspaceLookup[] };

export type PagePerson = {
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  headline: string | null;
  jobTitle: string | null;
  location: string | null;
  linkedinUrl: string | null;
  salesNavigatorUrl: string | null;
  companyName: string | null;
  companyLinkedinUrl: string | null;
};

export type PageCompany = {
  name: string | null;
  tagline: string | null;
  website: string | null;
  industry: string | null;
  sizeCategory: string | null;
  location: string | null;
  linkedinUrl: string | null;
};

type CapturePersonRequest = {
  kind: "person";
  person: {
    firstName: string | null;
    lastName: string | null;
    jobTitle: string | null;
    location: string | null;
    linkedinUrl: string | null;
    salesNavigatorUrl: string | null;
  };
  company: { name: string | null; domain: string | null; linkedinUrl: string | null } | null;
  ownerId?: string | null;
  tags: string[];
  boardId: string | null;
  stageId: string | null;
  sourceUrl: string | null;
};

type CaptureCompanyRequest = {
  kind: "company";
  company: {
    name: string;
    domain: string | null;
    linkedinUrl: string | null;
    industry: string | null;
    sizeCategory: string | null;
    description: string | null;
  };
  lifecycle: string | null;
  ownerId: string | null;
  tags: string[];
  boardId: string | null;
  stageId: string | null;
  sourceUrl: string | null;
};

type LinkRequest = { kind: "link"; contactId: string; linkedinUrl: string | null; salesNavigatorUrl: string | null; sourceUrl: string | null };

type LinkCompanyRequest = { kind: "link_company"; companyId: string; linkedinUrl: string; sourceUrl: string | null };

export type CaptureRequest = CapturePersonRequest | CaptureCompanyRequest | LinkRequest | LinkCompanyRequest;

export type CaptureResponse = {
  person: PersonSummary | null;
  company: CompanySummary | null;
  created: { contact: boolean; company: boolean };
};

export const DIFF_FIELDS = ["name", "jobTitle", "location", "company", "linkedinUrl", "salesNavigatorUrl", "website", "industry", "sizeCategory"] as const;

export type DiffField = (typeof DIFF_FIELDS)[number];

export type DiffRequest = {
  contactId?: string;
  companyId?: string;
  person?: PagePerson;
  company?: PageCompany;
  apply?: DiffField[];
};

export type DiffRow = { field: DiffField; label: string; before: string | null; after: string | null; changed: boolean };

export type DiffResponse = { changes: DiffRow[]; applied: DiffField[]; person: PersonSummary | null; company: CompanySummary | null };

export type TaskResponse = { task: TaskSummary };

export type NoteResponse = { activityId: string };

export type ThreadMessage = { from: string; mine: boolean; when: string | null; at: string | null; text: string };

type LogMessageRequest = {
  kind: "message";
  contactId: string;
  direction: "received" | "sent";
  occurredAt: string | null;
  text: string;
};

type LogConversationRequest = {
  kind: "conversation";
  contactId: string;
  title: string | null;
  threadUrl: string | null;
  messages: ThreadMessage[];
};

export type LogRequest = LogMessageRequest | LogConversationRequest;

export type LogResponse = { activityId: string; logged: number; skipped: number };

export type LogCheckResponse = {
  messages: { loggedAt: string | null; loggedLabel: string | null }[];
  lastLogged: { at: string; label: string; count: number } | null;
};
