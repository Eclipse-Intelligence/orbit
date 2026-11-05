import type { ThreadSummary } from "@/lib/mail/view";

export const MOCK_STATES = ["A-closed", "A", "B", "C", "C-eclipse", "D-list", "D", "D-elsewhere", "E", "E-mail", "F", "G"] as const;

export type MockState = (typeof MOCK_STATES)[number];

export type WorkspaceId = "eclipse" | "ridgeon";

export type MockWorkspace = {
  id: WorkspaceId;
  name: string;
  initial: string;
  companies: number;
  tasks: number;
  capture: number;
  boards: { id: string; name: string; count: number }[];
};

export const WORKSPACES: Record<WorkspaceId, MockWorkspace> = {
  eclipse: {
    id: "eclipse",
    name: "Eclipse",
    initial: "E",
    companies: 164,
    tasks: 10,
    capture: 5,
    boards: [
      { id: "agencies", name: "Agencies", count: 18 },
      { id: "direct", name: "Direct", count: 7 },
    ],
  },
  ridgeon: {
    id: "ridgeon",
    name: "Mark Ridgeon",
    initial: "M",
    companies: 23,
    tasks: 4,
    capture: 2,
    boards: [{ id: "consulting", name: "Consulting", count: 5 }],
  },
};

export const MOCK_NOW = Date.parse("2026-11-05T10:20:00Z");

export const VIEWER = {
  id: "mock-mark",
  name: "Mark Ridgeon",
  email: "mark@ridgeon.me",
  role: "owner",
  workspaceName: "Eclipse",
};

export const RIDGEON_INBOX = "mark@ridgeon.me";
export const ECLIPSE_INBOX = "mark@geteclipse.co";

function thread(
  key: string,
  account: string,
  name: string,
  address: string,
  subject: string,
  snippet: string,
  latestAt: string,
  extra: Partial<ThreadSummary> = {},
): ThreadSummary {
  return {
    key,
    sourceId: account,
    account,
    latestId: `${key}-latest`,
    subject,
    snippet,
    from: { name, address },
    to: [{ name: "Mark Ridgeon", address: account }],
    count: 1,
    unread: false,
    flagged: false,
    hasAttachments: false,
    draft: false,
    latestAt,
    reads: null,
    reminder: null,
    snoozedUntil: null,
    split: "important",
    prepared: false,
    ...extra,
  };
}

export const THREADS: ThreadSummary[] = [
  thread(
    "halden",
    RIDGEON_INBOX,
    "Sophie Turner",
    "sophie@haldengroup.co.uk",
    "Retainer for Q1",
    "Thanks Mark, the board liked the positioning work. Can we talk about carrying it into Q1?",
    "2026-11-05T09:42:00Z",
    { unread: true, count: 3, prepared: true },
  ),
  thread(
    "northwind",
    ECLIPSE_INBOX,
    "James Patel",
    "james@northwindlabs.com",
    "Re: AI visibility pilot",
    "Looping in Maya, who runs content. Could you send her last week's GEO report?",
    "2026-11-05T08:55:00Z",
    { unread: true, count: 4 },
  ),
  thread(
    "fernley",
    RIDGEON_INBOX,
    "Nina Alvarez",
    "nina@fernleycapital.com",
    "Intro: Mark and Tom at Fernley",
    "Tom is building out marketing across our portfolio and I think you two should talk.",
    "2026-11-05T07:31:00Z",
    { unread: true },
  ),
  thread(
    "release",
    ECLIPSE_INBOX,
    "Priya Shah",
    "priya@geteclipse.co",
    "Release notes for Monday",
    "Draft is in the doc. Two things need your call before it goes out.",
    "2026-11-04T17:12:00Z",
    { count: 2 },
  ),
  thread(
    "brightwell",
    RIDGEON_INBOX,
    "Oliver Grant",
    "oliver@brightwell.studio",
    "Workshop dates",
    "Either the 18th or the 20th works for the leadership team. Half day is plenty.",
    "2026-11-04T15:03:00Z",
    { hasAttachments: true },
  ),
  thread(
    "lumen",
    ECLIPSE_INBOX,
    "Daniel Brooks",
    "daniel@lumenagency.co.uk",
    "Pricing for agencies",
    "We run content for 14 B2B clients. What does Eclipse cost for a team like ours?",
    "2026-11-04T11:48:00Z",
  ),
  thread(
    "kestrel",
    ECLIPSE_INBOX,
    "Lena Fischer",
    "lena@kestrel.io",
    "Content audit proposal",
    "Signed copy attached. Looking forward to the kick-off.",
    "2026-11-03T16:20:00Z",
    { hasAttachments: true, flagged: true },
  ),
  thread(
    "companies-house",
    RIDGEON_INBOX,
    "Companies House",
    "noreply@companieshouse.gov.uk",
    "Confirmation statement due",
    "Your confirmation statement for Mark Ridgeon Ltd is due by 30 November.",
    "2026-11-03T09:00:00Z",
  ),
  thread(
    "reid",
    RIDGEON_INBOX,
    "Tom Reid",
    "tom@fernleycapital.com",
    "Coffee next week?",
    "Nina mentioned you might be around Shoreditch on Tuesday.",
    "2026-11-02T18:40:00Z",
  ),
];
