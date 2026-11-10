import type { UserActor } from "@/lib/crm/types";

export const CORE_CATEGORIES = [
  "find",
  "summarise",
  "draft",
  "propose_write",
  "cold_email",
  "calendar",
  "docs",
  "mail_triage",
  "multi_step",
  "ambiguous",
  "two_matches",
  "cross_workspace",
] as const;

export const SECURITY_CATEGORIES = ["injection", "exfiltration", "workspace_isolation", "memory"] as const;

export type Category = (typeof CORE_CATEGORIES)[number] | (typeof SECURITY_CATEGORIES)[number];

export type Suite = "core" | "security";

export type WorkspaceKey = "eclipse" | "ridgeon";

export type ToolCallRecord = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  write: boolean;
  result: unknown;
  refused: boolean;
};

export type CardRecord = {
  id: string;
  name: string;
  title: string;
  lines: string[];
  args: Record<string, unknown>;
  status: string;
};

export type OutboundRecord = { url: string; method: string; body: string };

export type EclipseCall = { tool: string; args: Record<string, unknown> };

export type Usage = { input: number; output: number; cached: number; cacheWrite: number };

export type PricedUsage = Usage & { model: string; kind: "assistant" | "other" };

export type Transcript = {
  calls: ToolCallRecord[];
  cards: CardRecord[];
  answer: string;
  outbound: OutboundRecord[];
  eclipseCalls: EclipseCall[];
  offeredTools: string[];
  sources: string[];
  modelSaw: string;
  usage: PricedUsage[];
  rounds: number;
  error: string | null;
};

export type World = {
  tag: string;
  eclipse: UserActor;
  ridgeon: UserActor;
  colleague: UserActor;
  actor: UserActor;
  ids: Map<string, string>;
  addresses: Record<WorkspaceKey, string>;
  bookingUrl: string | null;
  web: Map<string, string>;
  eclipseClients: EclipseClient[];
  knownHosts: Set<string>;
  knownAddresses: Set<string>;
  emailFrom: Map<string, string>;
  dns: Map<string, string>;
  id: (key: string) => string;
};

export type Verdict = true | false | string;

export const DEFENCES = {
  "outside-read-approval": "Approval cards for outside reads once untrusted content is in the conversation",
  "eclipse-client-isolation": "Eclipse calls pinned to the workspace's own Eclipse client",
  "linear-workspace": "Linear limited to the workspace it is connected to",
  "outside-note-scope": "A remember card shows when the note it saves came from an outside source",
  "cross-brand-warning": "A cross-brand warning on cards after another workspace's data was read",
} as const;

export type Defence = keyof typeof DEFENCES;

export type DeterministicCheck = {
  kind: "check";
  name: string;
  pending?: Defence;
  test: (transcript: Transcript, world: World) => Verdict | Promise<Verdict>;
};

export type JudgeCheck = {
  kind: "judge";
  name: string;
  pending?: Defence;
  rubric: string[];
  facts?: (world: World) => string;
};

export type Check = DeterministicCheck | JudgeCheck;

export type CheckResult = { name: string; kind: "check" | "judge"; pass: boolean; detail?: string; pending?: Defence };

export type When = { days: number; at?: string } | { weekday: number; weeks?: number; at?: string } | { nextWeek: number; at?: string };

type CompanySeed = {
  name: string;
  domain?: string;
  description?: string;
  industry?: string;
  lifecycle?: "lead" | "prospect" | "customer" | "churned";
  tags?: string[];
  unowned?: boolean;
};

type ContactSeed = {
  first: string;
  last: string;
  email?: string;
  company?: string;
  title?: string;
  linkedin?: string;
  notes?: string;
  unowned?: boolean;
};

type TaskSeed = { title: string; due?: When; company?: string; contact?: string; done?: boolean; remindMinutes?: number };

type DealSeed = { name: string; company: string; stage: string; value: number; contact?: string; close?: When };

type ActivitySeed = {
  key?: string;
  type: "note" | "call" | "meeting" | "email";
  title: string;
  body: string;
  at: When;
  company?: string;
  contact?: string;
  transcript?: string;
  summary?: string;
};

type EmailSeed = {
  key: string;
  from: { name: string; email: string } | "me";
  to: ({ name: string; email: string } | "me")[];
  cc?: { name: string; email: string }[];
  subject: string;
  body: string;
  at: When;
  folder?: "inbox" | "sent" | "archive";
  thread?: string;
  read?: boolean;
};

type EventSeed = {
  key: string;
  subject: string;
  start: When;
  minutes: number;
  attendees: { name: string; email: string }[];
  organiser?: { name: string; email: string };
  location?: string;
};

type DocSeed = { key?: string; title: string; content: string; shared?: boolean; byColleague?: boolean; assistantCanEdit?: boolean };

type DailySeed = { day: When; text: string };

type KnowledgeSeed = { title: string; content: string; company?: string };

type ProofSeed = { client: string; description: string; result: string; measured: string; product?: string };

type MemorySeed = { scope: "personal" | "business" | "market"; kind: string; title: string; body: string; sources?: Record<string, unknown>[] };

type ChangeSeed = { company: string; description: string };

export type WorkspaceSeed = {
  brand?: { website: string; whatYouSell: string; whoItsFor?: string; tone?: string };
  companies?: CompanySeed[];
  contacts?: ContactSeed[];
  tasks?: TaskSeed[];
  deals?: DealSeed[];
  activities?: ActivitySeed[];
  emails?: EmailSeed[];
  events?: EventSeed[];
  docs?: DocSeed[];
  daily?: DailySeed[];
  knowledge?: KnowledgeSeed[];
  proof?: ProofSeed[];
  memories?: MemorySeed[];
  changes?: ChangeSeed[];
  booking?: boolean;
};

export type EclipseClient = { id: string; name: string; geo: string };

export type Fixture = {
  eclipse?: WorkspaceSeed;
  ridgeon?: WorkspaceSeed;
  web?: Record<string, string>;
  dns?: Record<string, string>;
  eclipseClients?: EclipseClient[];
};

export type EarlierTurn = { role: "user" | "assistant"; content: string };

export type EvalTask = {
  id: string;
  suite: Suite;
  category: Category;
  origin: string;
  workspace?: WorkspaceKey;
  webSearch?: boolean;
  fixture: Fixture;
  earlier?: EarlierTurn[];
  message: string;
  checks: Check[];
};
