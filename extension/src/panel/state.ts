import type {
  DiffField,
  DiffResponse,
  ExtensionWorkspace,
  LogCheckResponse,
  LookupResponse,
  MeResponse,
  PageCompany,
  PagePerson,
  PairStartResponse,
  ThreadMessage,
  WorkspaceLookup,
} from "../../../lib/extension/protocol";
import type { ThreadPartner } from "../parsers";
import type { PageTarget } from "../urls";

export type Active = "task" | "note" | "message" | "update" | "people" | null;

export type Conversation = {
  messages: ThreadMessage[];
  checks: LogCheckResponse["messages"];
  ticked: Set<number>;
  readAt: string;
};

export type Store = {
  phase: "loading" | "connect" | "waiting" | "ready";
  token: string | null;
  me: MeResponse | null;
  workspaceId: string | null;
  pairing: PairStartResponse | null;
  connectNotice: string | null;
  tabId: number | null;
  tabUrl: string | null;
  target: PageTarget;
  pageKey: string | null;
  person: PagePerson | null;
  company: PageCompany | null;
  partner: ThreadPartner | null;
  readNote: string | null;
  lookup: LookupResponse | null;
  lookupError: string | null;
  loadingPage: boolean;
  active: Active;
  menu: "workspace" | "more" | null;
  editing: boolean;
  rejected: Set<string>;
  form: Record<string, string>;
  diff: DiffResponse | null;
  diffTicks: Set<DiffField>;
  conversation: Conversation | null;
  lastLogged: LogCheckResponse["lastLogged"];
  busy: boolean;
  flash: string | null;
  error: string | null;
};

export function initialStore(): Store {
  return {
    phase: "loading",
    token: null,
    me: null,
    workspaceId: null,
    pairing: null,
    connectNotice: null,
    tabId: null,
    tabUrl: null,
    target: { kind: "other", canonical: null, path: "" },
    pageKey: null,
    person: null,
    company: null,
    partner: null,
    readNote: null,
    lookup: null,
    lookupError: null,
    loadingPage: false,
    active: null,
    menu: null,
    editing: false,
    rejected: new Set(),
    form: {},
    diff: null,
    diffTicks: new Set(),
    conversation: null,
    lastLogged: null,
    busy: false,
    flash: null,
    error: null,
  };
}

export function currentWorkspace(s: Store): ExtensionWorkspace | null {
  return s.me?.workspaces.find((item) => item.id === s.workspaceId) ?? s.me?.workspaces[0] ?? null;
}

export function currentLookup(s: Store): WorkspaceLookup | null {
  return s.lookup?.workspaces.find((item) => item.workspaceId === s.workspaceId) ?? null;
}

export function shortLocation(value: string | null | undefined) {
  const parts = (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 3) return parts.slice(0, -1).join(", ");
  return parts.join(", ");
}

export function tagList(value: string | undefined) {
  return (value ?? "")
    .split(/[,;]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function firstNameOf(name: string | null | undefined) {
  return (name ?? "").trim().split(/\s+/)[0] || "them";
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

export function localDate(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function localDateTime(date: Date) {
  return `${localDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function dueDate(choice: string, now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (choice === "today") return localDate(start);
  if (choice === "tomorrow") return localDate(new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1));
  if (choice === "next_week") return localDate(new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7));
  return choice;
}

export function clockTime(iso: string) {
  const date = new Date(iso);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
