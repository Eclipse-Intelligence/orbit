export const SCENES = [
  "new-person",
  "workspace",
  "in-orbit",
  "in-orbit-task",
  "in-orbit-note",
  "in-orbit-message",
  "in-orbit-update",
  "conversation",
  "conversation-pick",
  "sales-nav",
  "connect",
  "connect-approve",
  "connect-token",
  "settings",
  "company",
  "company-new",
] as const;

export type Scene = (typeof SCENES)[number];

export type MockWorkspace = { id: string; name: string };

export const ECLIPSE: MockWorkspace = { id: "ws-eclipse-0001", name: "Eclipse" };
export const RIDGEON: MockWorkspace = { id: "ws-ridgeon-0002", name: "Mark Ridgeon" };
export const WORKSPACES = [ECLIPSE, RIDGEON];

export type PagePerson = {
  name: string;
  initials: string;
  headline: string;
  company: string;
  companySlug: string;
  location: string;
  slug: string;
  role: string;
  roleSince: string;
  about: string;
};

export const HANNAH: PagePerson = {
  name: "Hannah Okafor",
  initials: "HO",
  headline: "Head of Growth at Fernhill Digital | B2B SaaS marketing",
  company: "Fernhill Digital",
  companySlug: "fernhill-digital",
  location: "Bristol, England, United Kingdom",
  slug: "hannah-okafor",
  role: "Head of Growth",
  roleSince: "Mar 2024 to now",
  about: "I run growth for a 30 person digital agency. Search, content and paid, with a lot of time lately on how clients show up in AI answers.",
};

export const PRIYA: PagePerson = {
  name: "Priya Shah",
  initials: "PS",
  headline: "Founder and CEO, Northlight SEO",
  company: "Northlight SEO",
  companySlug: "northlight-seo",
  location: "Manchester, England, United Kingdom",
  slug: "priya-shah-seo",
  role: "Founder and CEO",
  roleSince: "Jan 2019 to now",
  about: "Northlight is a small SEO agency for B2B brands. We are adding AI search visibility to every retainer this year.",
};

export const TOM: PagePerson = {
  name: "Tom Reilly",
  initials: "TR",
  headline: "Director at Brightline PR",
  company: "Brightline PR",
  companySlug: "brightline-pr",
  location: "Leeds, England, United Kingdom",
  slug: "",
  role: "Director",
  roleSince: "Jun 2021 to now",
  about: "",
};

export const PRIYA_RECORD = {
  jobTitle: "Founder",
  email: "priya@northlightseo.co.uk",
  owner: "Mark Ridgeon",
  tags: ["agency", "geo"],
  company: "Northlight SEO",
  lifecycle: "Prospect",
  deal: { name: "GEO pilot", stage: "Proposal sent", value: "£4,800", board: "Sales" },
  lastInteraction: { kind: "Email", title: "Re: GEO pilot scope", when: "4 Nov" },
  tasks: [
    { title: "Send GEO pilot proposal", due: "Today" },
    { title: "Check in after the audit", due: "12 Nov" },
  ],
};

export type ThreadMessage = { id: string; from: string; mine: boolean; when: string; text: string };

export const THREAD: ThreadMessage[] = [
  { id: "m1", from: "Priya Shah", mine: false, when: "3 Nov, 16:42", text: "Thanks for the audit. The AI answers section was eye opening, two of our clients don't show up at all." },
  { id: "m2", from: "Mark Ridgeon", mine: true, when: "3 Nov, 17:05", text: "Glad it helped. Happy to scope a pilot for those two. Would a 6 week trial work?" },
  { id: "m3", from: "Priya Shah", mine: false, when: "5 Nov, 09:18", text: "Yes, 6 weeks is fine. Can you send pricing for both clients together?" },
  { id: "m4", from: "Mark Ridgeon", mine: true, when: "5 Nov, 09:31", text: "Will do. I'll send the proposal by Friday." },
  { id: "m5", from: "Priya Shah", mine: false, when: "6 Nov, 08:02", text: "Great. Also, could you join our team call on the 14th?" },
];

export const NORTHLIGHT = {
  name: "Northlight SEO",
  slug: "northlight-seo",
  initials: "N",
  tagline: "SEO and AI search visibility for B2B brands",
  industry: "Marketing services",
  size: "11-50 employees",
  location: "Manchester",
  website: "northlightseo.co.uk",
  founded: "2019",
  lifecycle: "Prospect",
  owner: "Mark Ridgeon",
  people: [
    { name: "Priya Shah", title: "Founder" },
    { name: "Dan Hughes", title: "Head of SEO" },
  ],
  ai: [
    { label: "ICP fit", value: "Strong fit, 3.6 of 4", meta: "3 Nov" },
    { label: "Sells GEO", value: "Yes", detail: "92% likely", meta: "3 sources · 3 Nov" },
    { label: "Staff", value: "9", meta: "Set by you on 4 Nov" },
    { label: "Agency type", value: "SEO", detail: "88% likely", meta: "2 sources · 3 Nov" },
  ],
};

export const KESTREL = {
  name: "Kestrel Content Co",
  slug: "kestrel-content",
  initials: "K",
  tagline: "Content strategy and production for tech companies",
  industry: "Marketing services",
  size: "11-50 employees",
  location: "Cardiff",
  website: "kestrelcontent.com",
  founded: "2017",
};
