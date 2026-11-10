import { parseThreadKey } from "@/lib/mail/threads";
import { parseDocsRoute } from "@/lib/docs/routes";
import { withActor } from "@/lib/crm/context";
import { isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";
import { isLeadSource } from "@/lib/assistant/web-gate";
import type { Db } from "@/lib/db/pool";

export const PAGE_SELECTION_KINDS = ["companies", "contacts"] as const;
export type PageSelectionKind = (typeof PAGE_SELECTION_KINDS)[number];
export const PAGE_FOCUS_KINDS = ["calendar_event", "capture"] as const;
export type PageFocusKind = (typeof PAGE_FOCUS_KINDS)[number];

export type PageInput = {
  path: string;
  search: string;
  selection: { kind: PageSelectionKind; ids: string[] } | null;
  focus: { kind: PageFocusKind; id: string } | null;
};

export const PAGE_CONTEXT_TAG = "page_context";
export const SELECTION_MAX = 1_000;
const PATH_MAX = 500;
const SEARCH_MAX = 2_000;
const NAME_MAX = 200;
const FOCUS_ID_MAX = 600;

const SETTINGS_PAGES: Record<string, string> = {
  "about-you": "About you",
  activity: "Activity",
  "ai-fields": "AI fields",
  "api-tokens": "API tokens",
  "booking-page": "Booking page",
  brand: "Brand",
  calendars: "Calendars",
  connections: "Connections",
  email: "Email",
  "email-templates": "Email templates",
  general: "General",
  knowledge: "Knowledge",
  learning: "Learning",
  memory: "Memory",
  pipeline: "Pipeline",
  tags: "Tags",
  team: "Team",
  tools: "Tools",
};

const SECTIONS: Record<string, string> = {
  activities: "Activity",
  proposals: "Proposals",
  quiet: "Quiet relationships",
  workflows: "Workflows",
  boards: "Boards",
  companies: "Companies",
};

function oneOf<T extends string>(list: readonly T[], value: unknown): T | null {
  return typeof value === "string" && (list as readonly string[]).includes(value) ? (value as T) : null;
}

function hasNul(value: string) {
  return value.includes("\u0000");
}

export function readPageInput(raw: unknown): PageInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const path = typeof input.path === "string" ? input.path.trim() : "";
  if (!path.startsWith("/") || path.startsWith("//") || path.length > PATH_MAX || hasNul(path)) return null;
  const search = typeof input.search === "string" && input.search.length <= SEARCH_MAX && !hasNul(input.search) ? input.search : "";
  const rawSelection = input.selection as { kind?: unknown; ids?: unknown } | null | undefined;
  const selectionKind = oneOf(PAGE_SELECTION_KINDS, rawSelection?.kind);
  const rawIds = Array.isArray(rawSelection?.ids) && rawSelection.ids.length <= SELECTION_MAX ? rawSelection.ids : [];
  const ids = [...new Set(rawIds.filter((id): id is string => typeof id === "string" && isUuid(id)))];
  const rawFocus = input.focus as { kind?: unknown; id?: unknown } | null | undefined;
  const focusKind = oneOf(PAGE_FOCUS_KINDS, rawFocus?.kind);
  const focusId = typeof rawFocus?.id === "string" && rawFocus.id.length > 0 && rawFocus.id.length <= FOCUS_ID_MAX && !hasNul(rawFocus.id) ? rawFocus.id : null;
  return {
    path,
    search,
    selection: selectionKind && ids.length > 0 ? { kind: selectionKind, ids } : null,
    focus: focusKind && focusId ? { kind: focusKind, id: focusId } : null,
  };
}

function quoted(value: string | null | undefined, fallback: string) {
  const text = (value ?? "").replace(/[\u0000-\u001f\u007f[\]<>]/g, " ").replace(/\s+/g, " ").trim();
  const shown = !text ? fallback : text.length > NAME_MAX ? `${text.slice(0, NAME_MAX - 1).trimEnd()}…` : text;
  return JSON.stringify(shown);
}

function word(value: string | null) {
  return value && /^[a-z0-9_-]{1,40}$/i.test(value) ? value : null;
}

function londonWhen(value: Date | string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/London" }).format(date).replace(/,/g, "");
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/London" }).format(date);
  return `${day} ${time}`;
}

function segments(path: string) {
  return path
    .split("?")[0]
    .split("/")
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

type Lines = string[];

const MISSING = "isn't in this workspace, or you can't see it";

async function company(db: Db, actor: UserActor, id: string) {
  const result = await db.query<{ name: string; domain: string | null; source: string | null }>(
    "select name, domain, source from crm.companies where id = $1 and workspace_id = $2 and archived_at is null",
    [id, actor.workspaceId],
  );
  const row = result.rows[0];
  const domain = row?.domain && !isLeadSource(row.source) ? row.domain : null;
  return row ? `company ${quoted(row.name, "Unnamed company")} [company id ${id}]${domain ? `, domain ${quoted(domain, "")}` : ""}` : null;
}

async function contact(db: Db, actor: UserActor, id: string) {
  const result = await db.query<{ name: string | null; email: string | null; job_title: string | null; company_id: string | null; company_name: string | null }>(
    `select nullif(trim(concat_ws(' ', c.first_name, c.last_name)), '') as name, c.email, c.job_title, c.company_id, co.name as company_name
     from crm.contacts c left join crm.companies co on co.id = c.company_id and co.archived_at is null
     where c.id = $1 and c.workspace_id = $2 and c.archived_at is null`,
    [id, actor.workspaceId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const parts = [
    row.job_title ? `job title ${quoted(row.job_title, "")}` : "",
    row.company_id && row.company_name ? `at company ${quoted(row.company_name, "Unnamed company")} [company id ${row.company_id}]` : "",
  ].filter(Boolean);
  return `person ${quoted(row.name ?? row.email, "Unnamed person")} [person id ${id}]${parts.length ? `, ${parts.join(", ")}` : ""}`;
}

async function opportunity(db: Db, actor: UserActor, id: string) {
  const result = await db.query<{ name: string; status: string; stage: string | null; pipeline: string | null; kind: string | null; company_id: string | null; company_name: string | null }>(
    `select o.name, o.status, s.name as stage, p.name as pipeline, p.kind, o.company_id, co.name as company_name
     from crm.opportunities o
     left join crm.pipeline_stages s on s.id = o.stage_id
     left join crm.pipelines p on p.id = o.pipeline_id
     left join crm.companies co on co.id = o.company_id and co.archived_at is null
     where o.id = $1 and o.workspace_id = $2 and o.archived_at is null`,
    [id, actor.workspaceId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const parts = [
    row.stage ? `stage ${quoted(row.stage, "")}` : "",
    row.status && row.status !== "open" ? `status ${quoted(row.status, "")}` : "",
    row.kind === "board" && row.pipeline ? `on the board ${quoted(row.pipeline, "")}` : "",
    row.company_id && row.company_name ? `for company ${quoted(row.company_name, "Unnamed company")} [company id ${row.company_id}]` : "",
  ].filter(Boolean);
  return `opportunity ${quoted(row.name, "Unnamed opportunity")} [opportunity id ${id}]${parts.length ? `, ${parts.join(", ")}` : ""}`;
}

async function board(db: Db, actor: UserActor, id: string) {
  const result = await db.query<{ name: string }>(
    "select name from crm.pipelines where id = $1 and workspace_id = $2 and kind = 'board' and archived_at is null",
    [id, actor.workspaceId],
  );
  return result.rows[0] ? `board ${quoted(result.rows[0].name, "Unnamed board")} [board id ${id}]` : null;
}

async function mailThread(db: Db, actor: UserActor, key: string) {
  let parsed: { sourceId: string; key: string };
  try {
    parsed = parseThreadKey(key);
  } catch {
    return null;
  }
  const result = await db.query<{ id: string; subject: string | null; messages: number; latest: Date | null; people: string[] | null }>(
    `select (array_agg(m.id order by coalesce(m.received_at, m.sent_at, m.created_at) desc))[1] as id,
       (array_agg(m.subject order by coalesce(m.received_at, m.sent_at, m.created_at) desc))[1] as subject,
       count(*)::int as messages,
       max(coalesce(m.received_at, m.sent_at, m.created_at)) as latest,
       array_agg(distinct coalesce(nullif(m.from_name, ''), m.from_email)) filter (where m.from_email is not null) as people
     from crm.mail_messages m
     where m.user_id = $1 and m.source_id = $2 and coalesce(m.thread_key, 'm:' || m.id::text) = $3`,
    [actor.userId, parsed.sourceId, parsed.key],
  );
  const row = result.rows[0];
  if (!row?.id) return null;
  const people = (row.people ?? []).map((person) => quoted(person, "")).filter((person) => person !== '""');
  const when = londonWhen(row.latest);
  return `email thread with subject ${quoted(row.subject, "(no subject)")} [email id ${row.id}], ${row.messages === 1 ? "1 email" : `${row.messages} emails`}${when ? `, latest ${when}` : ""}${people.length ? `, from ${people.join(", ")}` : ""}. Read it with get_email_thread and that email id.`;
}

async function doc(db: Db, actor: UserActor, id: string) {
  const result = await db.query<{ title: string | null; kind: string; daily_date: string | null; shared: boolean }>(
    `select title, kind, daily_date::text, effective_shared as shared from crm.pages
     where id = $1 and archived_at is null and (workspace_id = $2 or (kind = 'daily' and user_id = $3))`,
    [id, actor.workspaceId, actor.userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const label = row.kind === "daily" && row.daily_date ? `daily note for ${row.daily_date}` : `doc ${quoted(row.title, "Untitled doc")}`;
  return `${label} [doc id ${id}], ${row.shared ? "shared with the workspace" : "private"}. Read it with read_knowledge and that docId.`;
}

async function dailyNote(db: Db, actor: UserActor, date: string) {
  const result = await db.query<{ id: string }>(
    `select id from crm.pages where user_id = $1 and kind = 'daily' and daily_date = $2::date and archived_at is null
     order by (workspace_id = $3) desc, updated_at desc, id limit 1`,
    [actor.userId, date, actor.workspaceId],
  );
  return result.rows[0] ? doc(db, actor, result.rows[0].id) : `daily note for ${date}, not written yet`;
}

async function calendarEvent(db: Db, actor: UserActor, id: string) {
  if (!isUuid(id)) return null;
  const result = await db.query<{ subject: string | null; starts_at: Date; is_all_day: boolean; is_cancelled: boolean }>(
    "select subject, starts_at, is_all_day, is_cancelled from crm.calendar_events where id = $1 and user_id = $2",
    [id, actor.userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const when = row.is_all_day ? londonWhen(row.starts_at)?.replace(/ \d\d:\d\d$/, "") : londonWhen(row.starts_at);
  return `event ${quoted(row.subject, "Untitled event")} [calendar event id ${id}]${when ? `, ${when}${row.is_all_day ? ", all day" : ""}` : ""}${row.is_cancelled ? ", cancelled" : ""}`;
}

async function proposal(db: Db, actor: UserActor, id: string) {
  const result = await db.query<{ title: string; kind: string; status: string; company_id: string | null; company_name: string | null }>(
    `select d.title, d.kind, d.status, d.company_id, co.name as company_name from crm.documents d
     left join crm.companies co on co.id = d.company_id and co.archived_at is null
     where d.id = $1 and d.workspace_id = $2 and d.archived_at is null`,
    [id, actor.workspaceId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return `${row.kind === "nda" ? "NDA" : "proposal"} ${quoted(row.title, "Untitled")} [proposal id ${id}], ${word(row.status) ?? "draft"}${row.company_id && row.company_name ? `, for company ${quoted(row.company_name, "Unnamed company")} [company id ${row.company_id}]` : ""}`;
}

async function workflow(db: Db, actor: UserActor, id: string) {
  const result = await db.query<{ name: string; status: string }>(
    "select name, status from crm.workflows where id = $1 and workspace_id = $2 and archived_at is null",
    [id, actor.workspaceId],
  );
  const row = result.rows[0];
  return row ? `workflow ${quoted(row.name, "Untitled workflow")} [workflow id ${id}], ${word(row.status) ?? "off"}` : null;
}

async function task(db: Db, actor: UserActor, id: string) {
  const result = await db.query<{ title: string; due_at: Date | null; completed_at: Date | null }>(
    "select title, due_at, completed_at from crm.tasks where id = $1 and workspace_id = $2 and archived_at is null",
    [id, actor.workspaceId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const due = londonWhen(row.due_at);
  return `task ${quoted(row.title, "Untitled task")} [task id ${id}]${row.completed_at ? ", done" : due ? `, due ${due}` : ""}`;
}

async function captureItem(db: Db, actor: UserActor, value: string) {
  const split = value.indexOf(":");
  const kind = split > 0 ? value.slice(0, split) : "";
  const id = split > 0 ? value.slice(split + 1) : "";
  if (kind === "task" && isUuid(id)) return task(db, actor, id);
  if (kind === "reply" || kind === "email") {
    const found = await mailThread(db, actor, id);
    return found ? `${kind === "reply" ? "waiting for a reply" : "email from someone who isn't in Orbit yet"}, ${found}` : null;
  }
  if (kind === "nudge" && isUuid(id)) {
    const result = await db.query<{ source_id: string; thread_key: string }>(
      "select source_id, thread_key from crm.mail_prepared where id = $1 and user_id = $2 and kind = 'nudge'",
      [id, actor.userId],
    );
    const row = result.rows[0];
    const found = row ? await mailThread(db, actor, `${row.source_id}|${row.thread_key}`) : null;
    return found ? `sent email nobody has replied to, with a follow-up ready, ${found}` : null;
  }
  if (kind === "reminder" && isUuid(id)) {
    const result = await db.query<{ source_id: string; thread_key: string }>(
      "select source_id, thread_key from crm.mail_reminders where id = $1 and user_id = $2",
      [id, actor.userId],
    );
    const row = result.rows[0];
    const found = row ? await mailThread(db, actor, `${row.source_id}|${row.thread_key}`) : null;
    return found ? `email reminder, ${found}` : null;
  }
  if (kind === "call" && isUuid(id)) {
    const result = await db.query<{ subject: string | null; person_name: string | null; person_email: string | null; call_at: Date | null }>(
      "select subject, person_name, person_email, call_at from crm.follow_up_suggestions where id = $1 and user_id = $2 and workspace_id = $3",
      [id, actor.userId, actor.workspaceId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const when = londonWhen(row.call_at);
    return `suggested follow-up email after a call${when ? ` on ${when}` : ""} to ${quoted(row.person_name ?? row.person_email, "someone")}, subject ${quoted(row.subject, "(no subject)")}`;
  }
  if (kind === "import" && isUuid(id)) {
    const result = await db.query<{ title: string | null; source: string; occurred_at: Date | null }>(
      "select title, source, occurred_at from crm.conversation_imports where id = $1 and user_id = $2 and workspace_id = $3",
      [id, actor.userId, actor.workspaceId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const when = londonWhen(row.occurred_at);
    return `unfiled ${word(row.source) ?? "call"} conversation ${quoted(row.title, "Untitled")} [conversation id ${id}]${when ? `, ${when}` : ""}. File it with file_conversation and that conversationId.`;
  }
  if (kind === "approval" && isUuid(id)) {
    const result = await db.query<{ name: string }>(
      `select w.name from crm.workflow_runs r join crm.workflows w on w.id = r.workflow_id
       where r.id = $1 and r.owner_id = $2 and r.workspace_id = $3`,
      [id, actor.userId, actor.workspaceId],
    );
    return result.rows[0] ? `approval for the workflow ${quoted(result.rows[0].name, "Untitled workflow")} [workflow run id ${id}]` : null;
  }
  if (kind === "person" && /^[^\s@"<>[\]]{1,100}@[^\s@"<>[\]]{1,200}$/.test(id)) {
    return `someone from a meeting who isn't a contact yet, email ${quoted(id, "")}`;
  }
  return null;
}

const SELECTION_SQL: Record<PageSelectionKind, { label: string; one: string; id: string; sql: string }> = {
  companies: { label: "companies", one: "company", id: "company", sql: "select id, name from crm.companies where id = any($1::uuid[]) and workspace_id = $2 and archived_at is null" },
  contacts: {
    label: "people",
    one: "person",
    id: "person",
    sql: "select id, coalesce(nullif(trim(concat_ws(' ', first_name, last_name)), ''), email) as name from crm.contacts where id = any($1::uuid[]) and workspace_id = $2 and archived_at is null",
  },
};

async function selectionLines(db: Db, actor: UserActor, selection: NonNullable<PageInput["selection"]>): Promise<Lines> {
  const shape = SELECTION_SQL[selection.kind];
  const result = await db.query<{ id: string; name: string | null }>(shape.sql, [selection.ids, actor.workspaceId]);
  const names = new Map(result.rows.map((row) => [row.id, row.name]));
  const found = selection.ids.filter((id) => names.has(id));
  if (found.length === 0) return [];
  return [
    `Selected ${found.length === 1 ? `1 ${shape.one}` : `${found.length} ${shape.label}`}:`,
    ...found.map((id) => `- ${quoted(names.get(id), `Unnamed ${shape.one}`)} [${shape.id} id ${id}]`),
  ];
}

function opened(label: string, found: string | null) {
  return found ? `Open: ${found}` : `The ${label} open on this page ${MISSING}.`;
}

async function pageLines(db: Db, actor: UserActor, input: PageInput): Promise<Lines> {
  const params = new URLSearchParams(input.search.startsWith("?") ? input.search.slice(1) : input.search);
  const parts = segments(input.path);
  const [first, second] = parts;
  const lines: Lines = [];
  if (parts.length === 0) {
    lines.push("Page: Companies list.");
  } else if (first === "companies" && second && isUuid(second)) {
    lines.push("Page: a company.", opened("company", await company(db, actor, second)));
  } else if (first === "contacts" && second && isUuid(second)) {
    lines.push("Page: a person.", opened("person", await contact(db, actor, second)));
  } else if (first === "contacts") {
    lines.push("Page: People list.");
  } else if (first === "opportunities" && second && isUuid(second)) {
    lines.push("Page: an opportunity.", opened("opportunity", await opportunity(db, actor, second)));
  } else if (first === "opportunities") {
    lines.push("Page: Opportunities pipeline.");
  } else if (first === "boards" && second && isUuid(second)) {
    lines.push("Page: a board.", opened("board", await board(db, actor, second)));
  } else if (first === "tasks") {
    const view = word(params.get("view"));
    const who = params.get("who") === "everyone" ? "everyone's tasks" : "their own tasks";
    lines.push(`Page: Tasks${view ? `, ${view} view` : ""}, showing ${who}.`);
  } else if (first === "mail") {
    const thread = params.get("thread");
    const view = second === "subscriptions" ? "subscriptions" : (word(params.get("view")) ?? "inbox");
    lines.push(`Page: Mail, ${view}.`);
    const query = params.get("q")?.trim();
    if (query) lines.push(`Text in the search box: ${quoted(query, "")}`);
    if (thread) lines.push(opened("email thread", await mailThread(db, actor, thread)));
  } else if (first === "docs") {
    const route = parseDocsRoute(input.path, params);
    lines.push("Page: Docs.");
    if (route.pageId && isUuid(route.pageId)) lines.push(opened("doc", await doc(db, actor, route.pageId)));
    else if (route.date) lines.push(`Open: ${await dailyNote(db, actor, route.date)}`);
  } else if (first === "calendar") {
    const date = params.get("date");
    const view = word(params.get("view"));
    lines.push(`Page: Calendar${view ? `, ${view} view` : ""}${date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? ` around ${date}` : ""}.`);
  } else if (first === "capture") {
    lines.push("Page: Capture (what's waiting on the user: approvals, follow-ups, replies, tasks and things to file).");
  } else if (first === "proposals" && second && isUuid(second)) {
    lines.push("Page: a proposal.", opened("proposal", await proposal(db, actor, second)));
  } else if (first === "workflows" && second && isUuid(second)) {
    lines.push("Page: a workflow.", opened("workflow", await workflow(db, actor, second)));
  } else if (first === "settings") {
    const section = second ? SETTINGS_PAGES[second] : null;
    lines.push(`Page: Settings${section ? `, ${section}` : ""}.`);
  } else if (SECTIONS[first]) {
    lines.push(`Page: ${SECTIONS[first]}.`);
  }
  if (input.focus?.kind === "calendar_event" && first === "calendar") {
    const found = await calendarEvent(db, actor, input.focus.id);
    if (found) lines.push(`Event they last opened: ${found}`);
  }
  if (input.focus?.kind === "capture" && first === "capture") {
    const found = await captureItem(db, actor, input.focus.id);
    if (found) lines.push(`Capture item they last selected: ${found}`);
  }
  if (input.selection && (parts.length === 0 || (first === "contacts" && !second))) lines.push(...(await selectionLines(db, actor, input.selection)));
  return lines;
}

export async function pageContext(actor: UserActor, input: PageInput | null): Promise<string> {
  if (!input) return "";
  const lines = await withActor(actor, (db) => pageLines(db, actor, input));
  if (lines.length === 0) return "";
  return `<${PAGE_CONTEXT_TAG}>\n${lines.join("\n")}\n</${PAGE_CONTEXT_TAG}>`;
}
