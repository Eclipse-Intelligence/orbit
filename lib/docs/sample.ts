import type { Participant, RecordRef, Visibility } from "@/lib/docs/client-types";

export const SAMPLE_RECORDS = {
  acme: { kind: "company", id: "5a8f2c10-6b1e-4c39-9d0a-0c1a2b3c4d01", name: "Acme", detail: "Customer · Mark Ridgeon" },
  northwind: { kind: "company", id: "5a8f2c10-6b1e-4c39-9d0a-0c1a2b3c4d02", name: "Northwind", detail: "Partner · Priya Shah" },
  helix: { kind: "company", id: "5a8f2c10-6b1e-4c39-9d0a-0c1a2b3c4d03", name: "Helix Data", detail: "Prospect · Mark Ridgeon" },
  lena: { kind: "contact", id: "5a8f2c10-6b1e-4c39-9d0a-0c1a2b3c4e01", name: "Lena Ortiz", detail: "Partner marketing, Northwind" },
  dana: { kind: "contact", id: "5a8f2c10-6b1e-4c39-9d0a-0c1a2b3c4e02", name: "Dana Whitfield", detail: "Procurement, Northwind" },
  helixOffer: { kind: "opportunity", id: "5a8f2c10-6b1e-4c39-9d0a-0c1a2b3c4f01", name: "Helix joint offer", detail: "Proposal · £24,000" },
} satisfies Record<string, RecordRef>;

const token = (record: RecordRef) => `@[${record.name}](${record.kind}:${record.id})`;

export const SAMPLE_PEOPLE = {
  priya: { id: "sample-priya", name: "Priya Shah", short: "Priya", initials: "PS", color: "oklch(0.76 0.13 70)", kind: "person" },
  lena: { id: "sample-lena", name: "Lena Ortiz", short: "Lena", initials: "LO", color: "oklch(0.70 0.13 162)", kind: "person" },
  tom: { id: "sample-tom", name: "Tom Becker", short: "Tom", initials: "TB", color: "oklch(0.66 0.21 323)", kind: "person" },
  assistant: { id: "orbit-assistant", name: "Orbit assistant", short: "Orbit assistant", initials: "", color: "#8b7bff", kind: "assistant" },
  claude: { id: "mcp-claude-code", name: "Claude Code via MCP", short: "Claude Code", initials: "", color: "#a4a4a4", kind: "mcp" },
} satisfies Record<string, Participant>;

export type SampleAuthor = keyof typeof SAMPLE_PEOPLE | "viewer";

export type SampleFolder = { id: string; name: string; parentId: string | null; visibility: Visibility; owner: SampleAuthor };

export const SAMPLE_FOLDERS: SampleFolder[] = [
  { id: "f-partnerships", name: "Partnerships", parentId: null, visibility: "shared", owner: "viewer" },
  { id: "f-outbound", name: "Outbound playbooks", parentId: null, visibility: "shared", owner: "priya" },
  { id: "f-clients", name: "Clients", parentId: null, visibility: "private", owner: "viewer" },
  { id: "f-ideas", name: "Ideas", parentId: null, visibility: "private", owner: "viewer" },
];

export type SampleNote = {
  id: string;
  folderId: string | null;
  title: string;
  body: string;
  author: SampleAuthor;
  editedBy?: SampleAuthor;
  createdMinutesAgo: number;
  editedMinutesAgo: number;
  visibility?: Visibility;
};

const DAY = 24 * 60;

export const Q4_ID = "3f9c6a2e-1d4b-4e8a-9b51-6a7c2d1e0a01";

export const SAMPLE_NOTES: SampleNote[] = [
  {
    id: Q4_ID,
    folderId: "f-partnerships",
    title: "Q4 partner strategy",
    author: "viewer",
    editedBy: "assistant",
    createdMinutesAgo: 15 * DAY,
    editedMinutesAgo: 0.3,
    body: `Three partners carry Q4. Double down on the two that already send us pipeline, and give Helix one clear test. #partners/q4

## Where we are

- **Acme** ${token(SAMPLE_RECORDS.acme)} signed the reseller pilot in September: 4 deals, £86k in pipeline. #clients/acme
- **Northwind** is warm but waiting on legal. See [[Northwind MSA redlines]].
- **Helix Data** has made one intro. It needs a joint offer to move.

## Risks

Northwind's legal review could slip into January. Priya owns the chase.

Acme's renewal lands in January, so the pilot results need to be in their hands by 12 December, with the case study

> Partner-sourced deals closed in 41 days on average in Q3, against 68 for cold outbound.

## Q4 plan

- [x] Agree the co-marketing calendar with ${token(SAMPLE_RECORDS.lena)}
- [x] Share revised pricing with Acme, see [[Acme pricing notes]]
- [ ] Joint webinar with Northwind, week of 17 Nov
- [ ] Partner one-pager for Helix, tracked as ${token(SAMPLE_RECORDS.helixOffer)}
- [ ] Tag partner deals with \`source: partner\` so the board can filter them

## Numbers to watch

Pipeline from partners is 31% of the quarter so far. Partner deals carry a higher win rate (38% against 21%), but a smaller first contract. The bet is that partner customers expand faster, so track seats at 90 days rather than first-year value.

1. Partner-sourced pipeline, weekly
2. Days from intro to first call
3. Seats at 90 days for partner customers

---

Next review on 14 Nov with Priya and Tom.`,
  },
  {
    id: "3f9c6a2e-1d4b-4e8a-9b51-6a7c2d1e0a02",
    folderId: "f-partnerships",
    title: "Northwind MSA redlines",
    author: "priya",
    createdMinutesAgo: 9 * DAY,
    editedMinutesAgo: 1 * DAY + 120,
    body: `Legal came back on clause 9. They want a 60 day termination window and a cap on partner liability. #clients/northwind

## Clause 9

- Termination for convenience: they asked for 60 days, we offered 90.
- Liability cap at 12 months of fees. Fine for us.
- Data processing goes into a separate DPA, which ${token(SAMPLE_RECORDS.dana)} owns.

## Next

- [ ] Send the marked-up draft back by Friday
- [ ] Ask Tom whether 60 days changes the partner margin in [[Partner tiers and margins]]`,
  },
  {
    id: "3f9c6a2e-1d4b-4e8a-9b51-6a7c2d1e0a03",
    folderId: "f-partnerships",
    title: "Co-marketing calendar",
    author: "lena",
    createdMinutesAgo: 12 * DAY,
    editedMinutesAgo: 3 * DAY,
    body: `Webinar with Northwind in the week of 17 Nov. Acme case study goes out once the pilot numbers are signed off.

Dates follow the [[Q4 partner strategy]], so the webinar moves if Northwind slips.

## November

- 17 Nov: joint webinar with Northwind, ${token(SAMPLE_RECORDS.lena)} hosts
- 24 Nov: Acme case study draft
- 1 Dec: partner newsletter`,
  },
  {
    id: "3f9c6a2e-1d4b-4e8a-9b51-6a7c2d1e0a04",
    folderId: "f-partnerships",
    title: "Helix Data joint offer",
    author: "viewer",
    createdMinutesAgo: 6 * DAY,
    editedMinutesAgo: 5 * DAY,
    body: `One intro so far. A bundled offer for their mid-market book could move it: two seats free for the first quarter.

This is the one clear test from the Q4 partner strategy. If it doesn't land by December, drop Helix to the Registered tier.

- ${token(SAMPLE_RECORDS.helix)} wants co-branded onboarding
- Pricing follows [[Partner tiers and margins]]`,
  },
  {
    id: "3f9c6a2e-1d4b-4e8a-9b51-6a7c2d1e0a05",
    folderId: "f-partnerships",
    title: "Partner tiers and margins",
    author: "viewer",
    createdMinutesAgo: 30 * DAY,
    editedMinutesAgo: 8 * DAY,
    body: `Registered 10%, Select 15%, Strategic 20% plus co-selling. Review once Acme renews.

## Tiers

- **Registered**, 10%: deal registration
- **Select**, 15%: co-marketing and a named contact
- **Strategic**, 20%: co-selling and a joint plan

Partner margin is paid on the first year only.`,
  },
  {
    id: "3f9c6a2e-1d4b-4e8a-9b51-6a7c2d1e0a06",
    folderId: "f-partnerships",
    title: "Partner programme FAQ",
    author: "priya",
    createdMinutesAgo: 40 * DAY,
    editedMinutesAgo: 21 * DAY,
    body: `How do partners register a deal? Through the form on the partner page. Orbit creates the deal and tags the source.

## Who owns a registered deal?

The partner for 90 days. After that it goes back to us unless there is a meeting booked.

## Where is the plan?

See the Q4 partner strategy for this quarter's priorities.`,
  },
  {
    id: "3f9c6a2e-1d4b-4e8a-9b51-6a7c2d1e0a07",
    folderId: "f-partnerships",
    title: "Acme renewal timeline",
    author: "priya",
    createdMinutesAgo: 20 * DAY,
    editedMinutesAgo: 2 * DAY + 60,
    body: `Renewal is on 31 January. Working back from that date.

- 12 Dec: pilot results with ${token(SAMPLE_RECORDS.acme)}
- 9 Jan: commercial proposal
- 20 Jan: signature`,
  },
  {
    id: "3f9c6a2e-1d4b-4e8a-9b51-6a7c2d1e0b01",
    folderId: "f-clients",
    title: "Acme pricing notes",
    author: "viewer",
    createdMinutesAgo: 27 * DAY,
    editedMinutesAgo: 1 * DAY + 200,
    visibility: "shared",
    body: `Anchor the renewal to the reseller pilot, not to seat count. ${token(SAMPLE_RECORDS.acme)} cares about the partner margin more than the list price. #clients/acme

## Discount bands

\`\`\`text
50 seats and up     8%
100 seats and up   12%
Multi-year         +3%, capped at 15%
\`\`\`

- Nothing below 50 seats. Point them at the self-serve plan instead.
- Partner margin stays at 15% as agreed in [[Partner tiers and margins]].

## For the renewal call

Lead with the pilot numbers from [[Q4 partner strategy]], then the multi-year option. Dana will ask about the cap, so have the Brightline comparison ready.`,
  },
  {
    id: "3f9c6a2e-1d4b-4e8a-9b51-6a7c2d1e0b02",
    folderId: "f-clients",
    title: "Acme onboarding checklist",
    author: "viewer",
    createdMinutesAgo: 10 * DAY,
    editedMinutesAgo: 3 * DAY + 100,
    body: `SSO first, then the CRM import. Their ops lead wants a weekly check-in for the first month. #clients/acme

- [x] SSO with their IT team
- [ ] CRM import
- [ ] Weekly check-in, Thursdays`,
  },
  {
    id: "3f9c6a2e-1d4b-4e8a-9b51-6a7c2d1e0b03",
    folderId: "f-clients",
    title: "Northwind: who's who",
    author: "viewer",
    createdMinutesAgo: 14 * DAY,
    editedMinutesAgo: 6 * DAY,
    body: `Dana runs procurement and decides. Sam is the champion but can't sign. Legal is outsourced. #clients/northwind

- ${token(SAMPLE_RECORDS.dana)}: procurement, decides
- Sam: champion
- ${token(SAMPLE_RECORDS.lena)}: partner marketing`,
  },
  {
    id: "3f9c6a2e-1d4b-4e8a-9b51-6a7c2d1e0b04",
    folderId: "f-clients",
    title: "Brightline renewal risks",
    author: "viewer",
    createdMinutesAgo: 16 * DAY,
    editedMinutesAgo: 9 * DAY,
    body: `Usage dropped 30% since August. New VP of Sales started in September and hasn't logged in once.

- [ ] Book a call with the new VP
- [ ] Usage report for the last quarter`,
  },
  {
    id: "3f9c6a2e-1d4b-4e8a-9b51-6a7c2d1e0b05",
    folderId: "f-clients",
    title: "Orion Labs discovery call",
    author: "viewer",
    createdMinutesAgo: 13 * DAY,
    editedMinutesAgo: 12 * DAY,
    body: `They run outbound from three tools. Pain is reporting, not sending. Follow up with the dashboard demo.`,
  },
  {
    id: "3f9c6a2e-1d4b-4e8a-9b51-6a7c2d1e0b06",
    folderId: "f-clients",
    title: "Kestrel procurement steps",
    author: "viewer",
    createdMinutesAgo: 25 * DAY,
    editedMinutesAgo: 20 * DAY,
    body: `Security questionnaire, then a DPA, then a 30 day pilot. Budget is signed off for January.`,
  },
  {
    id: "3f9c6a2e-1d4b-4e8a-9b51-6a7c2d1e0b07",
    folderId: "f-clients",
    title: "Acme renewal call prep",
    author: "viewer",
    createdMinutesAgo: 4 * DAY,
    editedMinutesAgo: 4 * DAY,
    body: `Questions for the renewal call on 14 Nov. Start with what the pilot saved their ops team. #clients/acme`,
  },
  {
    id: "3f9c6a2e-1d4b-4e8a-9b51-6a7c2d1e0c01",
    folderId: "f-outbound",
    title: "Cold email teardown: Kestrel",
    author: "priya",
    createdMinutesAgo: 5 * DAY,
    editedMinutesAgo: 3 * DAY,
    body: `Three lines, one ask. The subject line did most of the work.`,
  },
  {
    id: "3f9c6a2e-1d4b-4e8a-9b51-6a7c2d1e0c02",
    folderId: "f-outbound",
    title: "Follow-up sequence",
    author: "priya",
    createdMinutesAgo: 30 * DAY,
    editedMinutesAgo: 11 * DAY,
    body: `Day 2, day 5, day 12. Each one adds something new, never just a bump.`,
  },
  {
    id: "3f9c6a2e-1d4b-4e8a-9b51-6a7c2d1e0c03",
    folderId: "f-outbound",
    title: "Subject lines that worked",
    author: "tom",
    createdMinutesAgo: 44 * DAY,
    editedMinutesAgo: 17 * DAY,
    body: `Short and specific. Names beat numbers. Questions beat statements.`,
  },
  {
    id: "3f9c6a2e-1d4b-4e8a-9b51-6a7c2d1e0d01",
    folderId: "f-ideas",
    title: "Partner deals get their own board",
    author: "viewer",
    createdMinutesAgo: 2 * DAY,
    editedMinutesAgo: 2 * DAY,
    body: `So we stop guessing what the programme is worth. #partners`,
  },
  {
    id: "3f9c6a2e-1d4b-4e8a-9b51-6a7c2d1e0d02",
    folderId: "f-ideas",
    title: "Quarterly customer letter",
    author: "viewer",
    createdMinutesAgo: 19 * DAY,
    editedMinutesAgo: 15 * DAY,
    body: `One page, written by hand, sent to every customer with more than 20 seats.`,
  },
  {
    id: "3f9c6a2e-1d4b-4e8a-9b51-6a7c2d1e0d03",
    folderId: null,
    title: "Reading list",
    author: "viewer",
    createdMinutesAgo: 60 * DAY,
    editedMinutesAgo: 26 * DAY,
    body: `- The Mom Test
- Working Backwards
- High Output Management`,
  },
];

export const DAILY_BODIES: Record<number, string> = {
  0: `08:42 Slept badly. Coffee first, inbox after.

09:15 Call with Priya. ${token(SAMPLE_RECORDS.northwind)} legal is slower than they said. Not our problem yet, but chase on Friday.

11:30 Small win: Acme's ops lead said the pilot "saved her a whole Monday". That goes in the case study. #wins

13:05 Third reschedule from Helix. Letting it go for a week before I say something I regret. #vent

15:20 Idea: partner-sourced deals get their own board, so we stop guessing what the programme is worth. [[Partner deals board]]

16:48
- [ ] Send Lena the co-marketing dates
- [x] Reply to Dana about the DPA`,
  1: `08:10 Northwind legal again. Pinged Dana directly, which worked.

10:40 Priya has the Helix intro on Thursday.

14:00 Pricing call prep took longer than it should have.

17:30 Good day overall. #wins`,
  2: `09:00 Good week start. Acme renewal call booked for 14 Nov.

09:45 Rewrote the [[Q4 partner strategy]] on the train. Better.

12:15 Lunch with Tom. He wants partner deals on their own board.

15:00 Northwind still quiet.

18:20 Gym.`,
  5: `13:00 Board prep all afternoon. Too many slides.

16:30 Cut it to eight.

18:00 Sent.`,
  6: `09:30 Lena's webinar draft is great. Tell her.

15:10 Kestrel wants a DPA before the pilot.`,
};

export const DAILY_FILLER = [
  "Inbox to zero by ten. Felt good.",
  "Two discovery calls, one worth following up.",
  "Partner newsletter draft is too long. Cut it in half.",
  "Quiet day. Wrote the onboarding checklist.",
  "Helix asked for case studies. Sent two.",
  "Pipeline review with Tom. Partner share is growing.",
  "Late start, long evening. Not again.",
  "Kestrel signed the NDA.",
];

export const DAILY_OFFSETS = [0, 1, 2, 5, 6, 7, 8, 9, 12, 13, 14, 15, 16, 19, 20, 21, 22, 23, 26, 27, 28, 33, 34, 35, 36, 40, 41, 42, 43];
