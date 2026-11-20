import { CHAT_SEARCH_MAX, CHAT_SEARCH_MIN, CHAT_SEARCH_PAGE, CHAT_SEARCH_TEXT_MAX, type ChatKind, type ChatSearch, type ChatSearchHit, type ChatSubjectKind } from "@/lib/chat/types";
import { discussionHref } from "@/lib/chat/discussions";
import { cleanFormat } from "@/lib/chat/markdown";
import { messageHref } from "@/lib/chat/routes";
import { searchExcerpt } from "@/lib/chat/search";
import { directName, GROUP_PEOPLE, type PeopleRow } from "@/lib/crm/chat";
import { withActor } from "@/lib/crm/context";
import { CrmError, pgFailure } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import { readDateTime, startOfDay } from "@/lib/time";

type Stamp = Date | string;

type SearchRow = {
  id: string;
  conversation_id: string;
  parent_id: string | null;
  created_at: Stamp;
  created_key: string;
  author_user_id: string | null;
  author_name: string;
  body: string;
  format: string | null;
  conversation_kind: ChatKind;
  conversation_name: string | null;
  workspace_name: string | null;
  archived: boolean;
  subject_id: string | null;
  subject_title: string | null;
  files: { id: string; name: string }[] | null;
};

export type ChatSearchInput = {
  text: unknown;
  in?: unknown;
  from?: unknown;
  hasFile?: unknown;
  after?: unknown;
  before?: unknown;
  cursor?: unknown;
  limit?: unknown;
};

export type ChatSearchOptions = { agent?: boolean };

const FORMER = "Former teammate";
const NUL = /\u0000/g;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function invalid(message: string, field: string) {
  return new CrmError("invalid_input", message, 400, { field });
}

function searchText(value: unknown) {
  const text = typeof value === "string" ? value.replace(NUL, "").trim().slice(0, CHAT_SEARCH_TEXT_MAX).trim() : "";
  if (Array.from(text).length < CHAT_SEARCH_MIN) throw invalid(`Type at least ${CHAT_SEARCH_MIN} characters to search.`, "q");
  return text;
}

function searchId(value: unknown, noun: string, field: string) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !isUuid(value.trim())) throw invalid(`Pick ${noun} from the list.`, field);
  return value.trim().toLowerCase();
}

function searchFlag(value: unknown, field: string) {
  if (value === undefined || value === null || value === "" || value === false || value === "0" || value === "false") return false;
  if (value === true || value === "1" || value === "true") return true;
  throw invalid("Use true or false.", field);
}

function searchTime(value: unknown, field: string, edge: "start" | "end") {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw invalid(`${field} is a date or a date and time.`, field);
  const text = value.trim();
  const reading = readDateTime(text);
  if (!reading.ok) throw invalid(`${field}: ${reading.error}`, field);
  if (!reading.dateOnly) return reading.date.toISOString();
  return (edge === "start" ? startOfDay(reading.date) : startOfDay(reading.date, undefined, 1)).toISOString();
}

function searchLimit(value: unknown) {
  if (value === undefined || value === null || value === "") return CHAT_SEARCH_PAGE;
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) throw invalid("Use a number for limit.", "limit");
  return Math.min(CHAT_SEARCH_MAX, Math.max(1, Math.floor(number)));
}

function readCursor(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const broken = invalid("That page of results has expired. Search again.", "cursor");
  if (typeof value !== "string" || value.length > 200) throw broken;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { t?: unknown; id?: unknown };
    if (typeof parsed.t === "string" && STAMP.test(parsed.t) && typeof parsed.id === "string" && isUuid(parsed.id)) return { t: parsed.t, id: parsed.id.toLowerCase() };
  } catch {}
  throw broken;
}

function writeCursor(row: { created_key: string; id: string }) {
  return Buffer.from(JSON.stringify({ t: row.created_key, id: row.id })).toString("base64url");
}

function toHit(row: SearchRow, text: string, full: boolean, groups: Map<string, PeopleRow[]>): ChatSearchHit {
  const kind = row.conversation_kind;
  const discussion = kind === "task" || kind === "doc" || kind === "mail_thread";
  const subject = discussion && row.subject_id ? { kind: kind as ChatSubjectKind, id: row.subject_id, title: row.subject_title?.trim() || null } : null;
  const parentId = row.parent_id;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    parentId,
    createdAt: new Date(row.created_at).toISOString(),
    author: { id: row.author_user_id, name: row.author_name || FORMER },
    excerpt: searchExcerpt(row.body, cleanFormat(row.format), text),
    ...(full ? { text: row.body } : {}),
    files: row.files ?? [],
    conversation: { kind, name: directName(kind, { name: row.conversation_name, dmName: row.conversation_name, people: groups.get(row.conversation_id) ?? null }), workspaceName: row.workspace_name, archived: row.archived },
    subject,
    href: subject ? discussionHref({ kind: subject.kind, id: subject.id }) : messageHref(row.conversation_id, { id: row.id, parentId }),
  };
}

export async function searchChat(actor: UserActor, input: ChatSearchInput, options: ChatSearchOptions = {}): Promise<ChatSearch> {
  const text = searchText(input.text);
  const limit = searchLimit(input.limit);
  const after = searchTime(input.after, "after", "end");
  const before = searchTime(input.before, "before", "start");
  const filters = {
    in: searchId(input.in, "a conversation", "in"),
    from: searchId(input.from, "a person", "from"),
    has_file: searchFlag(input.hasFile, "hasFile"),
    after,
    before,
    agent: options.agent === true,
  };
  const cursor = readCursor(input.cursor);
  let rows: SearchRow[];
  try {
    const found = await query<SearchRow>("select * from private.chat_search_all($1, $2, $3::jsonb, $4, $5::jsonb)", [actor.userId, text, JSON.stringify(filters), limit + 1, cursor ? JSON.stringify(cursor) : null]);
    rows = found.rows;
  } catch (error) {
    throw pgFailure(error) ?? error;
  }
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  if (page.length === 0) return { hits: [], next: null };
  const { seen, groups } = await withActor(actor, async (db) => {
    const result = await db.query<{ id: string }>("select id from crm.chat_messages where id = any($1::uuid[])", [page.map((row) => row.id)]);
    const groupIds = [...new Set(page.filter((row) => row.conversation_kind === "group_dm").map((row) => row.conversation_id))];
    const people = groupIds.length
      ? await db.query<{ id: string; people: PeopleRow[] | null }>(`select c.id, ${GROUP_PEOPLE("c", "$2")} as people from crm.chat_conversations c where c.id = any($1::uuid[])`, [groupIds, actor.userId])
      : { rows: [] };
    return { seen: new Set(result.rows.map((row) => row.id)), groups: new Map(people.rows.map((row) => [row.id, row.people ?? []])) };
  });
  const last = page[page.length - 1];
  return {
    hits: page.filter((row) => seen.has(row.id)).map((row) => toHit(row, text, options.agent === true, groups)),
    next: more ? writeCursor(last) : null,
  };
}
