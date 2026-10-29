import type { Viewer } from "@/components/crm/viewer";

export const MOCK_VIEWER: Viewer = {
  id: "mark",
  name: "Mark Ridgeon",
  email: "mark@eclipse.dev",
  role: "owner",
  workspaceName: "Eclipse",
};

export type Person = {
  id: string;
  name: string;
  short: string;
  initials: string;
  color: string;
  agent?: "assistant" | "mcp";
};

export const PEOPLE = {
  mark: { id: "mark", name: "Mark Ridgeon", short: "Mark", initials: "MR", color: "oklch(0.72 0.10 221)" },
  priya: { id: "priya", name: "Priya Shah", short: "Priya", initials: "PS", color: "oklch(0.76 0.13 70)" },
  lena: { id: "lena", name: "Lena Ortiz", short: "Lena", initials: "LO", color: "oklch(0.70 0.13 162)" },
  tom: { id: "tom", name: "Tom Becker", short: "Tom", initials: "TB", color: "oklch(0.66 0.21 323)" },
  assistant: { id: "assistant", name: "Orbit assistant", short: "Orbit assistant", initials: "", color: "#8b7bff", agent: "assistant" },
  claude: { id: "claude", name: "Claude Code via MCP", short: "Claude Code", initials: "", color: "#a4a4a4", agent: "mcp" },
} satisfies Record<string, Person>;

export type Folder = {
  id: string;
  name: string;
  count: number;
  shared: boolean;
  owner?: Person;
};

export const FOLDERS: Folder[] = [
  { id: "partnerships", name: "Partnerships", count: 6, shared: true },
  { id: "outbound", name: "Outbound playbooks", count: 11, shared: true, owner: PEOPLE.priya },
  { id: "clients", name: "Clients", count: 9, shared: false },
  { id: "ideas", name: "Ideas", count: 14, shared: false },
];

export type TagNode = { name: string; count: number; open?: boolean; children?: TagNode[] };

export const TAGS: TagNode[] = [
  {
    name: "clients",
    count: 12,
    open: true,
    children: [
      { name: "acme", count: 5 },
      { name: "northwind", count: 4 },
    ],
  },
  { name: "partners", count: 8 },
  { name: "q4", count: 6 },
];

export type NoteRow = {
  id: string;
  title: string;
  snippet: string;
  when: string;
  by?: Person;
  tags?: string[];
  shared?: boolean;
  privateMark?: boolean;
  live?: Person[];
  pinned?: boolean;
};

export const PARTNERSHIP_NOTES: NoteRow[] = [
  {
    id: "q4",
    title: "Q4 partner strategy",
    snippet: "Three partners carry Q4. Double down on the two that already send us pipeline, and give Helix one clear test.",
    when: "Now",
    by: PEOPLE.assistant,
    tags: ["partners/q4"],
    live: [PEOPLE.assistant, PEOPLE.priya],
    pinned: true,
  },
  {
    id: "northwind",
    title: "Northwind MSA redlines",
    snippet: "Legal came back on clause 9. They want a 60 day termination window and a cap on partner liability.",
    when: "Yesterday",
    by: PEOPLE.priya,
    tags: ["clients/northwind"],
  },
  {
    id: "comarketing",
    title: "Co-marketing calendar",
    snippet: "Webinar with Northwind in the week of 17 Nov. Acme case study goes out once the pilot numbers are signed off.",
    when: "Mon",
    by: PEOPLE.lena,
  },
  {
    id: "helix",
    title: "Helix Data joint offer",
    snippet: "One intro so far. A bundled offer for their mid-market book could move it: two seats free for the first quarter.",
    when: "24 Oct",
    by: PEOPLE.mark,
  },
  {
    id: "tiers",
    title: "Partner tiers and margins",
    snippet: "Registered 10%, Select 15%, Strategic 20% plus co-selling. Review once Acme renews.",
    when: "21 Oct",
    by: PEOPLE.mark,
  },
  {
    id: "faq",
    title: "Partner programme FAQ",
    snippet: "How do partners register a deal? Through the form on the partner page. Orbit creates the deal and tags the source.",
    when: "8 Oct",
    by: PEOPLE.priya,
  },
];

export const CLIENT_NOTES: NoteRow[] = [
  {
    id: "acme-pricing",
    title: "Acme pricing notes",
    snippet: "Anchor the renewal to the reseller pilot. Discount bands: 8% at 50 seats, 12% at 100, nothing below that.",
    when: "Yesterday",
    by: PEOPLE.mark,
    tags: ["clients/acme"],
    shared: true,
  },
  {
    id: "acme-onboarding",
    title: "Acme onboarding checklist",
    snippet: "SSO first, then the CRM import. Their ops lead wants a weekly check-in for the first month.",
    when: "Mon",
    by: PEOPLE.mark,
    tags: ["clients/acme"],
  },
  {
    id: "northwind-people",
    title: "Northwind: who's who",
    snippet: "Dana runs procurement and decides. Sam is the champion but can't sign. Legal is outsourced.",
    when: "23 Oct",
    by: PEOPLE.mark,
    tags: ["clients/northwind"],
  },
  {
    id: "brightline",
    title: "Brightline renewal risks",
    snippet: "Usage dropped 30% since August. New VP of Sales started in September and hasn't logged in once.",
    when: "20 Oct",
    by: PEOPLE.mark,
  },
  {
    id: "orion",
    title: "Orion Labs discovery call",
    snippet: "They run outbound from three tools. Pain is reporting, not sending. Follow up with the dashboard demo.",
    when: "17 Oct",
    by: PEOPLE.mark,
  },
  {
    id: "kestrel",
    title: "Kestrel procurement steps",
    snippet: "Security questionnaire, then a DPA, then a 30 day pilot. Budget is signed off for January.",
    when: "9 Oct",
    by: PEOPLE.mark,
  },
];

export type Day = { label: string; date: string; preview: string; entries: number; today?: boolean };

export const DAYS: Day[] = [
  { label: "Today", date: "Wed 29 Oct", preview: "Slept badly. Coffee first, inbox after.", entries: 6, today: true },
  { label: "Yesterday", date: "Tue 28 Oct", preview: "Northwind legal again. Pinged Dana directly, which worked.", entries: 4 },
  { label: "Monday", date: "27 Oct", preview: "Good week start. Acme renewal call booked for 14 Nov.", entries: 5 },
  { label: "Friday", date: "24 Oct", preview: "Board prep all afternoon. Too many slides.", entries: 3 },
  { label: "Thursday", date: "23 Oct", preview: "Lena's webinar draft is great. Tell her.", entries: 2 },
];

export const WEEK_ACTIVITY = [3, 0, 5, 4, 6, 0, 0];

export const SCREENS = [
  "main",
  "link-picker",
  "quick-open",
  "quick-open-search",
  "share",
  "daily",
  "history",
  "approval",
  "phone-folders",
  "phone-list",
  "phone-note",
  "phone-picker",
] as const;

export type Screen = (typeof SCREENS)[number];
