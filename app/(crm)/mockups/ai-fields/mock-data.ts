export const SCENES = ["table", "menu", "add", "number", "cell", "filter", "settings", "company"] as const;
export type Scene = (typeof SCENES)[number];

export type FieldType = "yesno" | "number" | "text" | "pick";

export type AiField = {
  key: "geo" | "staff" | "type";
  label: string;
  question: string;
  type: FieldType;
  options?: string[];
  scope: string;
  refresh: string;
  answered: number;
  total: number;
  lastRun: string;
  status: "live" | "filling" | "paused";
  filled?: number;
};

export const FIELDS: AiField[] = [
  {
    key: "geo",
    label: "Sells GEO",
    question: "Does this agency sell GEO or AI search visibility work to its clients?",
    type: "yesno",
    scope: "All companies with a website",
    refresh: "Monthly",
    answered: 182,
    total: 214,
    lastRun: "3 Nov",
    status: "live",
  },
  {
    key: "staff",
    label: "Staff",
    question: "How many people work at this agency?",
    type: "number",
    scope: "All companies with a website",
    refresh: "Monthly",
    answered: 171,
    total: 214,
    lastRun: "3 Nov",
    status: "live",
  },
  {
    key: "type",
    label: "Agency type",
    question: "Which type of agency is this?",
    type: "pick",
    options: ["SEO", "PR", "Content", "Other"],
    scope: "Fit Good or better",
    refresh: "Monthly",
    answered: 41,
    total: 61,
    lastRun: "Today",
    status: "filling",
    filled: 47,
  },
];

export type Cell =
  | { state: "answer"; value: string; manual?: boolean }
  | { state: "checking" }
  | { state: "unknown" }
  | { state: "outside" };

export type MockCompany = {
  id: string;
  name: string;
  domain: string;
  lifecycle: "lead" | "prospect" | "customer";
  industry: string;
  size: string;
  last: string;
  relationship: "new" | "warm" | "strong";
  health: "healthy" | "watch" | "at_risk" | null;
  fit: number | null;
  owner: string;
  geo: Cell;
  staff: Cell;
  type: Cell;
};

const yes: Cell = { state: "answer", value: "Yes" };
const no: Cell = { state: "answer", value: "No" };
const checking: Cell = { state: "checking" };
const unknown: Cell = { state: "unknown" };
const outside: Cell = { state: "outside" };
const n = (value: number, manual = false): Cell => ({ state: "answer", value: String(value), manual });
const pick = (value: string, manual = false): Cell => ({ state: "answer", value, manual });

export const COMPANIES: MockCompany[] = [
  { id: "c1", name: "Northlight SEO", domain: "northlightseo.co.uk", lifecycle: "prospect", industry: "Agency", size: "11-50", last: "2 weeks ago", relationship: "warm", health: null, fit: 3.6, owner: "Mark Ridgeon", geo: yes, staff: n(14), type: pick("SEO") },
  { id: "c2", name: "Fieldwork Content", domain: "fieldwork.studio", lifecycle: "lead", industry: "Agency", size: "11-50", last: "No contact", relationship: "new", health: null, fit: 3.3, owner: "Unassigned", geo: yes, staff: n(22), type: pick("Content") },
  { id: "c3", name: "Orchard PR", domain: "orchardpr.com", lifecycle: "lead", industry: "Agency", size: "11-50", last: "No contact", relationship: "new", health: null, fit: 2.8, owner: "Unassigned", geo: no, staff: n(31), type: pick("PR") },
  { id: "c4", name: "Beacon Search", domain: "beaconsearch.co.uk", lifecycle: "prospect", industry: "Agency", size: "1-10", last: "4 days ago", relationship: "strong", health: "healthy", fit: 3.9, owner: "Mark Ridgeon", geo: yes, staff: n(9, true), type: pick("SEO") },
  { id: "c5", name: "Copperleaf Media", domain: "copperleaf.media", lifecycle: "lead", industry: "Agency", size: "51-200", last: "No contact", relationship: "new", health: null, fit: 1.9, owner: "Unassigned", geo: no, staff: n(64), type: checking },
  { id: "c6", name: "Wordsmith Studio", domain: "wordsmith.studio", lifecycle: "lead", industry: "Agency", size: "1-10", last: "No contact", relationship: "new", health: null, fit: 3.1, owner: "Unassigned", geo: checking, staff: checking, type: checking },
  { id: "c7", name: "Harbour Creative", domain: "harbourcreative.co.uk", lifecycle: "lead", industry: "Agency", size: "11-50", last: "3 weeks ago", relationship: "warm", health: "watch", fit: 2.4, owner: "James Carter", geo: unknown, staff: n(18), type: pick("Other") },
  { id: "c8", name: "Tandem Growth", domain: "tandemgrowth.io", lifecycle: "customer", industry: "Agency", size: "11-50", last: "Yesterday", relationship: "strong", health: "healthy", fit: 3.4, owner: "Mark Ridgeon", geo: yes, staff: n(27), type: pick("Content", true) },
  { id: "c9", name: "Lumen Communications", domain: "lumencomms.com", lifecycle: "lead", industry: "Agency", size: "51-200", last: "No contact", relationship: "new", health: null, fit: 1.2, owner: "Unassigned", geo: no, staff: n(85), type: outside },
  { id: "c10", name: "Pinnacle Search", domain: "pinnaclesearch.co.uk", lifecycle: "lead", industry: "Agency", size: "11-50", last: "No contact", relationship: "new", health: null, fit: 3.2, owner: "Unassigned", geo: yes, staff: n(12), type: pick("SEO") },
  { id: "c11", name: "Mosaic PR", domain: "mosaicpr.co.uk", lifecycle: "prospect", industry: "Agency", size: "11-50", last: "3 weeks ago", relationship: "warm", health: null, fit: 2.9, owner: "James Carter", geo: no, staff: n(16), type: pick("PR") },
  { id: "c12", name: "Atlas Content Co", domain: "atlascontent.co", lifecycle: "lead", industry: "Agency", size: "11-50", last: "No contact", relationship: "new", health: null, fit: 3.5, owner: "Unassigned", geo: yes, staff: n(19), type: pick("Content") },
  { id: "c13", name: "Redline Digital", domain: "redline.digital", lifecycle: "lead", industry: "Agency", size: "1-10", last: "No contact", relationship: "new", health: null, fit: 2.2, owner: "Unassigned", geo: unknown, staff: unknown, type: pick("Other") },
  { id: "c14", name: "Greenhouse Digital", domain: "greenhouse.digital", lifecycle: "lead", industry: "Agency", size: "11-50", last: "No contact", relationship: "new", health: null, fit: 3.0, owner: "Unassigned", geo: yes, staff: n(24), type: pick("SEO") },
  { id: "c15", name: "Folio Agency", domain: "folio.agency", lifecycle: "lead", industry: "Agency", size: "1-10", last: "No contact", relationship: "new", health: null, fit: 2.6, owner: "Unassigned", geo: no, staff: n(6), type: pick("Content") },
  { id: "c16", name: "Signal Path", domain: "signalpath.co.uk", lifecycle: "lead", industry: "Agency", size: "11-50", last: "No contact", relationship: "new", health: null, fit: 3.3, owner: "Unassigned", geo: yes, staff: n(11), type: pick("SEO") },
  { id: "c17", name: "Kite and Co", domain: "kiteandco.com", lifecycle: "lead", industry: "Agency", size: "11-50", last: "No contact", relationship: "new", health: null, fit: 2.7, owner: "Unassigned", geo: checking, staff: n(29), type: pick("PR") },
  { id: "c18", name: "Ninefold", domain: "ninefold.co.uk", lifecycle: "lead", industry: "Agency", size: "11-50", last: "No contact", relationship: "new", health: null, fit: 3.1, owner: "Unassigned", geo: yes, staff: n(21), type: pick("Content") },
  { id: "c19", name: "Pivot Comms", domain: "pivotcomms.com", lifecycle: "lead", industry: "Agency", size: "11-50", last: "No contact", relationship: "new", health: null, fit: 2.5, owner: "Unassigned", geo: no, staff: n(38), type: pick("PR") },
  { id: "c20", name: "Brightside Digital", domain: "brightside.digital", lifecycle: "lead", industry: "Agency", size: "11-50", last: "No contact", relationship: "new", health: null, fit: 3.0, owner: "Unassigned", geo: yes, staff: n(17), type: pick("SEO") },
];

function staffOf(company: MockCompany) {
  return company.staff.state === "answer" ? Number(company.staff.value) : null;
}

export const GEO_PROSPECTS = COMPANIES.filter((company) => {
  const staff = staffOf(company);
  const type = company.type.state === "answer" ? company.type.value : null;
  return company.geo.state === "answer" && company.geo.value === "Yes" && staff !== null && staff >= 5 && staff <= 30 && (type === "SEO" || type === "Content");
}).sort((a, b) => (staffOf(a) ?? 0) - (staffOf(b) ?? 0));

export type Source = { title: string; url: string; host: string };

export const NORTHLIGHT_GEO = {
  company: "Northlight SEO",
  field: "Sells GEO",
  question: "Does this agency sell GEO or AI search visibility work to its clients?",
  answer: "Yes",
  likely: 94,
  reason: "Its services page offers “AI search visibility: get cited in ChatGPT, Perplexity and Google AI Overviews”.",
  sources: [
    { title: "AI search visibility services", url: "https://northlightseo.co.uk/services/ai-search", host: "northlightseo.co.uk" },
    { title: "Northlight SEO on LinkedIn", url: "https://www.linkedin.com/company/northlight-seo", host: "linkedin.com" },
    { title: "Northlight SEO reviews", url: "https://clutch.co/profile/northlight-seo", host: "clutch.co" },
  ] satisfies Source[],
  checked: "Checked 3 Nov 2026",
  next: "Next check 3 Dec",
};

export const TAG_RULES = [
  { label: "agency", question: "Is the company a marketing, content or SEO agency?", tagged: 96 },
  { label: "b2b", question: "Does the company sell to other businesses?", tagged: 141 },
  { label: "hiring", question: "Is the company advertising any jobs right now?", tagged: 23 },
];
