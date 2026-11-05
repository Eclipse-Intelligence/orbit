export const SCENES = ["full", "approvals", "empty", "partial", "rows", "swipe", "menu", "bell", "nav", "team", "colleague"] as const;

export type Scene = (typeof SCENES)[number];

export type SectionId = "approvals" | "followups" | "replies" | "tasks" | "tofile";

export const SECTIONS: { id: SectionId; label: string }[] = [
  { id: "approvals", label: "Approvals" },
  { id: "followups", label: "Follow-ups" },
  { id: "replies", label: "Replies" },
  { id: "tasks", label: "Tasks" },
  { id: "tofile", label: "To file" },
];

export type ApprovalItem = {
  kind: "approval";
  id: string;
  title: string;
  workflow: string;
  company: string | null;
  when: string;
  details: string;
  owner?: string;
};

export type FollowUpItem = {
  kind: "followup";
  id: string;
  source: "email" | "teams" | "granola";
  title: string;
  to: string;
  when: string;
  line: string;
  draft: string;
};

export type ReplyItem = {
  kind: "reply";
  id: string;
  from: string;
  company: string | null;
  subject: string;
  snippet: string;
  when: string;
  waiting: string;
  ready: boolean;
};

export type TaskItem = {
  kind: "task";
  id: string;
  title: string;
  company: string | null;
  due: string;
  overdue: boolean;
};

export type FileItem =
  | { kind: "email"; id: string; name: string; email: string; to: string; subject: string; snippet: string; when: string }
  | { kind: "meeting"; id: string; source: "teams" | "granola"; title: string; line: string; when: string }
  | { kind: "person"; id: string; name: string; email: string; line: string };

export type ActionItem = ApprovalItem | FollowUpItem | ReplyItem | TaskItem | FileItem;

export type ActionData = Record<SectionId, ActionItem[]>;

export const MARK_DATA: ActionData = {
  approvals: [
    {
      kind: "approval",
      id: "a1",
      title: "Send intro email to Priya Shah",
      workflow: "New lead intro",
      company: "Northwind Analytics",
      when: "2h ago",
      details: "Subject: Orbit for Northwind. Hi Priya, thanks for the chat at the Founders Forum. As promised, here is the two page overview and a link to book a pilot call.",
    },
    {
      kind: "approval",
      id: "a2",
      title: "Move Halden & Co to Negotiation",
      workflow: "Proposal chaser",
      company: "Halden & Co",
      when: "Yesterday",
      details: "The proposal was opened 4 times since Monday. Stage changes from Proposal sent to Negotiation.",
    },
    {
      kind: "approval",
      id: "a3",
      title: "Create 6 ClickUp tasks",
      workflow: "Granola to ClickUp",
      company: "Kestrel Logistics",
      when: "Tue",
      details: "From Tuesday's onboarding call: SSO set-up, data import, training session, success plan, invoice contact, review in 30 days.",
    },
  ],
  followups: [
    {
      kind: "followup",
      id: "f1",
      source: "email",
      title: "Pilot pricing",
      to: "Tom Becker",
      when: "Sent 6 days ago",
      line: "Nobody has replied. Orbit has a follow-up ready.",
      draft: "Hi Tom, just bringing this back up. Happy to walk through the pilot numbers on a quick call this week if that helps.",
    },
    {
      kind: "followup",
      id: "f2",
      source: "email",
      title: "Proposal for Q1",
      to: "Amelia Ross",
      when: "Sent 4 days ago",
      line: "Opened 3 times. Nobody has replied.",
      draft: "Hi Amelia, did you get a chance to look at the proposal? I can adjust the start date if January is tight.",
    },
    {
      kind: "followup",
      id: "f3",
      source: "teams",
      title: "Call with Marcus Lee",
      to: "Marcus Lee",
      when: "Yesterday, 32 min",
      line: "No next step was agreed.",
      draft: "Hi Marcus, thanks for the time yesterday. Shall we pencil in a demo with your ops team next week?",
    },
    {
      kind: "followup",
      id: "f4",
      source: "granola",
      title: "Halden & Co weekly",
      to: "Grace Lin",
      when: "Tue, 45 min",
      line: "You said you would send the security pack.",
      draft: "Hi Grace, as promised, here is our security pack and the DPA. Shout if your team needs anything else.",
    },
  ],
  replies: [
    {
      kind: "reply",
      id: "r1",
      from: "Daniel Hughes",
      company: "Kestrel Logistics",
      subject: "Contract redlines",
      snippet: "Legal have been through it. Two points on liability, see clause 9. Can we close this week?",
      when: "Fri 30 Oct",
      waiting: "4 days",
      ready: false,
    },
    {
      kind: "reply",
      id: "r2",
      from: "Sarah Okafor",
      company: "Fernhill Capital",
      subject: "Data room access",
      snippet: "Could you confirm who on your side needs access before Friday?",
      when: "Mon",
      waiting: "3 days",
      ready: true,
    },
    {
      kind: "reply",
      id: "r3",
      from: "Lena Fischer",
      company: null,
      subject: "Intro: Lena and Mark",
      snippet: "Great to be connected. Are you free for 20 minutes early next week?",
      when: "Tue",
      waiting: "2 days",
      ready: true,
    },
  ],
  tasks: [
    { kind: "task", id: "t0", title: "Send Halden the security pack", company: "Halden & Co", due: "Yesterday", overdue: true },
    { kind: "task", id: "t1", title: "Send revised SOW to Kestrel", company: "Kestrel Logistics", due: "2 days overdue", overdue: true },
    { kind: "task", id: "t2", title: "Book onsite with Fernhill", company: "Fernhill Capital", due: "Yesterday", overdue: true },
    { kind: "task", id: "t3", title: "Call Priya about pilot scope", company: "Northwind Analytics", due: "Today 14:00", overdue: false },
    { kind: "task", id: "t4", title: "Review Q4 pipeline", company: null, due: "Today", overdue: false },
  ],
  tofile: [
    {
      kind: "email",
      id: "u1",
      name: "Olivia Grant",
      email: "olivia@harbourline.io",
      to: "mark@eclipse.ai",
      subject: "Partnership idea",
      snippet: "We run the ops stack for 40 logistics firms and think there is a fit.",
      when: "10:12",
    },
    {
      kind: "email",
      id: "u2",
      name: "Noah Patel",
      email: "noah.patel@gmail.com",
      to: "mark@eclipse.ai",
      subject: "Following up from Web Summit",
      snippet: "Loved the talk. Would you be open to a quick chat about the agent work?",
      when: "Wed",
    },
    { kind: "meeting", id: "m1", source: "teams", title: "Call with +44 7700 900123", line: "12 min, no contact matched", when: "Wed" },
    { kind: "meeting", id: "m2", source: "granola", title: "Coffee with Ben", line: "Notes ready, no contact matched", when: "Tue" },
    { kind: "person", id: "p1", name: "Rachel Moore", email: "rachel@kinfolk.studio", line: "2 meetings. Next Tue 10 Nov" },
  ],
};

export const OTHERS_APPROVALS: ApprovalItem[] = [
  {
    kind: "approval",
    id: "o1",
    title: "Send renewal reminder to Brightline",
    workflow: "Renewals",
    company: "Brightline",
    when: "2 days",
    details: "",
    owner: "James",
  },
];

export const JAMES_DATA: ActionData = {
  approvals: [
    {
      kind: "approval",
      id: "ja1",
      title: "Send renewal reminder to Brightline",
      workflow: "Renewals",
      company: "Brightline",
      when: "2 days ago",
      details: "Subject: Your renewal on 1 December. Hi Tom, a quick note that your plan renews on 1 December.",
    },
  ],
  followups: [
    {
      kind: "followup",
      id: "jf1",
      source: "teams",
      title: "Call with Grace Lin",
      to: "Grace Lin",
      when: "Today, 20 min",
      line: "No next step was agreed.",
      draft: "Hi Grace, thanks for the call. I will send the onboarding plan by Friday.",
    },
  ],
  replies: [],
  tasks: [
    { kind: "task", id: "jt1", title: "Prep Halden onboarding deck", company: "Halden & Co", due: "Yesterday", overdue: true },
    { kind: "task", id: "jt2", title: "Send Brightline usage report", company: "Brightline", due: "Today", overdue: false },
  ],
  tofile: [{ kind: "person", id: "jp1", name: "Omar Haddad", email: "omar@halden.co", line: "1 meeting. Last Mon 2 Nov" }],
};

export const PARTIAL_DATA: ActionData = {
  approvals: [],
  followups: [],
  replies: [MARK_DATA.replies[1]],
  tasks: MARK_DATA.tasks.slice(3),
  tofile: [],
};

export const EMPTY_DATA: ActionData = { approvals: [], followups: [], replies: [], tasks: [], tofile: [] };

export type BellUpdate = { id: string; title: string; body: string; when: string; fresh: boolean; tone?: "alert" };

export const BELL_UPDATES: BellUpdate[] = [
  { id: "n1", title: "Follow-up sent: Pricing for Halden", body: "Orbit sent your follow-up to Grace Lin.", when: "25m ago", fresh: true },
  { id: "n2", title: "Workflow failed: Granola to ClickUp", body: "ClickUp rejected the token. Reconnect it in Integrations.", when: "3h ago", fresh: true, tone: "alert" },
  { id: "n3", title: "Amelia Ross opened Proposal for Q1", body: "Opened 3 times.", when: "Yesterday", fresh: false },
  { id: "n4", title: "Approved: Send intro pack to Brightline", body: "The email went out at 09:14.", when: "Mon", fresh: false },
];

export function countOf(data: ActionData) {
  return SECTIONS.reduce((sum, section) => sum + data[section.id].length, 0);
}
