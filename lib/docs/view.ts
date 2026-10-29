import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";
import type {
  Backlinks,
  DailySummary,
  DocsNav,
  Folder,
  LinkContext,
  LinkTarget,
  Meeting,
  Page,
  PageFilter,
  PageSort,
  PageSummary,
  Participant,
  RecordRef,
  SearchHit,
  SearchResults,
  Version,
  VersionBody,
} from "@/lib/docs/client-types";
import { localDate } from "@/lib/docs/daily";
import { shortDay } from "@/lib/docs/format";
import { dailyMeetings, listDailyNotes, openDailyNote } from "@/lib/docs/daily-notes";
import { listFolders } from "@/lib/docs/folders";
import { entryCount, excerptFrom, highlightIn, linkKey, tagTree } from "@/lib/docs/markdown";
import { prefixQuery, searchDocs } from "@/lib/docs/search";
import {
  assertDocsRead,
  docsMentioning,
  getDoc,
  getVersion,
  listBacklinks,
  listDocs,
  listUnlinkedMentions,
  listVersions,
  mapPage,
  pageSelect,
  type PageRow,
} from "@/lib/docs/store";
import type { DocDetail, DocEditorRef, DocFolder, DocPerson, DocReference, DocSearchHit, DocSummary, DocVersion } from "@/lib/docs/types";
import { agentParticipant, ASSISTANT_PARTICIPANT, personParticipant } from "@/lib/docs/participants";
import { MENTION_KINDS, type MentionKind } from "@/lib/mentions";

const LIST_LIMIT = 200;
const ACTIVITY_WINDOW_MS = 60_000;

function person(actor: UserActor, value: DocPerson | null): Participant {
  return personParticipant(value, actor.userId);
}

function ownerOf(actor: UserActor, owner: DocPerson | null, agent: DocPerson | null): Participant {
  if (!owner && agent) return agentParticipant(agent.id, agent.name);
  return person(actor, owner);
}

export function editorParticipant(actor: UserActor, ref: DocEditorRef | null, owner: DocPerson | null): Participant {
  if (!ref) return person(actor, owner);
  if (ref.editor === "assistant") return ASSISTANT_PARTICIPANT;
  if (ref.editor === "agent") return agentParticipant(ref.agentId ?? `mcp:${ref.userId ?? "workspace"}`, ref.name);
  return person(actor, ref.userId ? { id: ref.userId, name: ref.personName ?? ref.name } : owner);
}

export function toFolder(actor: UserActor, folder: DocFolder): Folder {
  return {
    id: folder.id,
    name: folder.name,
    parentId: folder.parentId,
    position: folder.position,
    visibility: folder.shared ? "shared" : "private",
    shared: folder.effectiveShared,
    owner: ownerOf(actor, folder.owner, folder.createdByAgent),
    noteCount: folder.pageCount,
  };
}

function displayTitle(doc: { kind: string; title: string; dailyDate: string | null }) {
  return doc.kind === "daily" && doc.dailyDate ? shortDay(doc.dailyDate) : doc.title;
}

export function toSummary(actor: UserActor, doc: DocSummary, entries = 0): PageSummary {
  return {
    id: doc.id,
    kind: doc.kind,
    title: displayTitle(doc),
    snippet: doc.excerpt,
    folderId: doc.folderId,
    dailyDate: doc.dailyDate,
    visibility: doc.shared ? "shared" : "private",
    shared: doc.effectiveShared,
    owner: ownerOf(actor, doc.owner, doc.createdByAgent),
    tags: doc.tags,
    createdAt: doc.createdAt,
    updatedAt: doc.editedAt,
    updatedBy: editorParticipant(actor, doc.lastEditor, doc.owner),
    wordCount: doc.wordCount,
    entryCount: entries,
  };
}

export function toPage(actor: UserActor, doc: DocDetail): Page {
  return {
    ...toSummary(actor, doc, doc.kind === "daily" ? entryCount(doc.content) : 0),
    snippet: doc.excerpt,
    body: doc.content,
    revision: doc.revision,
    assistantCanEdit: doc.assistantCanEdit,
    createdBy: ownerOf(actor, doc.owner, doc.createdByAgent),
  };
}

const REASON_SUMMARIES: Record<DocVersion["reason"], string> = {
  created: "Created",
  edited: "Edited",
  renamed: "Renamed",
  before_agent: "Saved before a change",
  restored: "Restored an earlier version",
  link_renamed: "Updated links",
};

export function toVersion(actor: UserActor, version: DocVersion): Version {
  const askedBy =
    version.by.editor === "assistant" && version.by.personName
      ? `Asked by ${version.by.personName}`
      : version.by.editor === "agent" && !version.by.agentId && version.by.personName
        ? `${version.by.personName}'s MCP token`
        : null;
  return {
    id: version.id,
    pageId: version.pageId,
    createdAt: version.createdAt,
    author: editorParticipant(actor, version.by, null),
    summary: version.summary ?? REASON_SUMMARIES[version.reason],
    askedBy,
    title: version.title,
  };
}

function toContext(reference: DocReference, wanted: string): LinkContext {
  return {
    pageId: reference.id,
    title: displayTitle(reference),
    kind: reference.kind,
    dailyDate: reference.dailyDate,
    folderName: reference.folderName,
    shared: reference.visibility !== "private",
    updatedAt: reference.editedAt,
    snippet: reference.snippet,
    ...highlightIn(reference.snippet, wanted),
  };
}

function notFound(error: unknown) {
  return error instanceof CrmError && error.status === 404;
}

async function summariesByIds(actor: UserActor, ids: string[]) {
  const wanted = [...new Set(ids.filter(isUuid))];
  if (wanted.length === 0) return new Map<string, PageSummary>();
  const rows = await withActor(actor, async (db) => {
    const result = await db.query<PageRow>(`${pageSelect(false)} where p.id = any($1::uuid[]) and p.workspace_id = $2 and p.archived_at is null`, [wanted, actor.workspaceId]);
    return result.rows;
  });
  return new Map(rows.map((row) => [row.id, toSummary(actor, mapPage(actor, row))]));
}

async function navCounts(actor: UserActor, today: string) {
  return withActor(actor, async (db) => {
    const tags = await db.query<{ path: string; count: number }>(
      `select x.path, count(distinct t.page_id)::int as count
       from crm.page_tags t
       join crm.pages p on p.id = t.page_id
       cross join lateral (
         select array_to_string((string_to_array(t.tag, '/'))[1:n], '/') as path
         from generate_series(1, cardinality(string_to_array(t.tag, '/'))) as n
       ) x
       where p.workspace_id = $1 and p.archived_at is null
       group by x.path`,
      [actor.workspaceId],
    );
    const daily = await db.query<{ count: number; today_id: string | null; today_head: string | null }>(
      `select count(*) filter (where p.content <> '')::int as count,
         (array_agg(p.id) filter (where p.daily_date = $3::date))[1] as today_id,
         (array_agg(left(p.content, 4000)) filter (where p.daily_date = $3::date))[1] as today_head
       from crm.pages p
       where p.workspace_id = $1 and p.user_id = $2 and p.kind = 'daily' and p.archived_at is null`,
      [actor.workspaceId, actor.userId, today],
    );
    return { tags: tags.rows, daily: daily.rows[0] };
  });
}

export async function docsNav(actor: UserActor): Promise<DocsNav> {
  assertDocsRead(actor);
  const today = localDate();
  const [folders, counts] = await Promise.all([listFolders(actor), navCounts(actor, today)]);
  const head = counts.daily?.today_head ?? "";
  return {
    viewer: personParticipant({ id: actor.userId, name: actor.fullName || actor.email }, actor.userId),
    folders: folders.map((folder) => toFolder(actor, folder)),
    tags: tagTree(counts.tags),
    dailyCount: counts.daily?.count ?? 0,
    today,
    todayNote:
      counts.daily?.today_id && head.trim()
        ? { date: today, pageId: counts.daily.today_id, entries: entryCount(head), preview: excerptFrom(head.replace(/^\d{2}:\d{2}( |$)/gm, ""), 120) }
        : null,
  };
}

export async function docsPage(actor: UserActor, id: string): Promise<Page | null> {
  try {
    const doc = await getDoc(actor, id);
    return doc.archivedAt ? null : toPage(actor, doc);
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
}

export async function docsSearch(actor: UserActor, query: string): Promise<SearchResults> {
  const text = query.trim();
  if (!text) return { query, titles: [], text: [] };
  const hits = await searchDocs(actor, text, { limit: 40 });
  const summaries = await summariesByIds(actor, hits.map((hit) => hit.id));
  const titles: PageSummary[] = [];
  const body: SearchHit[] = [];
  for (const hit of hits) {
    const summary = summaries.get(hit.id);
    if (!summary) continue;
    if (hit.titleMatch && hit.titleMatch !== "fuzzy") titles.push(summary);
    else body.push(searchHit(summary, hit, text));
  }
  return { query, titles, text: body };
}

function searchHit(summary: PageSummary, hit: DocSearchHit, query: string): SearchHit {
  const snippet = hit.snippet ?? summary.snippet;
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const first = words.map((word) => highlightIn(snippet, word)).find((range) => range.matchTo > range.matchFrom);
  return { page: summary, snippet, ...(highlightIn(snippet, query).matchTo > 0 ? highlightIn(snippet, query) : (first ?? { matchFrom: 0, matchTo: 0 })) };
}

export type PageListResult = { pages: PageSummary[]; hasMore: boolean };

export async function docsListPage(actor: UserActor, filter: PageFilter, sort: PageSort = "edited", offset = 0): Promise<PageListResult> {
  if (filter.kind === "search") {
    const results = await docsSearch(actor, filter.query);
    const pages = [...results.titles, ...results.text.map((hit) => hit.page)];
    return { pages, hasMore: false };
  }
  if (filter.kind === "daily") {
    const [pages, days] = await Promise.all([listDocs(actor, { kind: "daily", sort, limit: LIST_LIMIT, offset }), listDailyNotes(actor, { limit: 400 })]);
    const entries = new Map(days.map((day) => [day.id, day.entryCount]));
    return {
      pages: pages.data
        .map((doc) => toSummary(actor, doc, entries.get(doc.id) ?? 0))
        .sort((left, right) => (right.dailyDate ?? "").localeCompare(left.dailyDate ?? "")),
      hasMore: pages.hasMore,
    };
  }
  const query = filter.kind === "folder" ? { folderId: filter.folderId, deep: true } : filter.kind === "tag" ? { tag: filter.path } : {};
  try {
    const pages = await listDocs(actor, { ...query, sort, limit: LIST_LIMIT, offset });
    return { pages: pages.data.map((doc) => toSummary(actor, doc)), hasMore: pages.hasMore };
  } catch (error) {
    if (notFound(error)) return { pages: [], hasMore: false };
    throw error;
  }
}

export async function docsList(actor: UserActor, filter: PageFilter, sort: PageSort = "edited"): Promise<PageSummary[]> {
  return (await docsListPage(actor, filter, sort)).pages;
}

export async function docsRecent(actor: UserActor, limit = 8): Promise<PageSummary[]> {
  const pages = await listDocs(actor, { kind: "any", sort: "edited", limit: Math.min(50, Math.max(1, limit)) });
  return pages.data.map((doc) => toSummary(actor, doc));
}

export async function docsVersions(actor: UserActor, pageId: string): Promise<Version[]> {
  return (await listVersions(actor, pageId)).map((version) => toVersion(actor, version));
}

export async function docsVersionBody(actor: UserActor, pageId: string, versionId: string): Promise<VersionBody> {
  const version = await getVersion(actor, versionId);
  if (version.pageId !== pageId) throw new CrmError("not_found", "That version isn't one of this doc's versions.", 404);
  return { id: version.id, title: version.title, body: version.content };
}

export async function docsBacklinks(actor: UserActor, pageId: string): Promise<Backlinks> {
  const [page, linked, unlinked] = await Promise.all([getDoc(actor, pageId), listBacklinks(actor, pageId), listUnlinkedMentions(actor, pageId)]);
  const label = page.kind === "daily" ? (page.dailyDate ?? page.title) : page.title;
  return { linked: linked.map((reference) => toContext(reference, label)), unlinked: unlinked.map((reference) => toContext(reference, page.title)) };
}

export async function docsTitles(actor: UserActor): Promise<Record<string, string>> {
  assertDocsRead(actor);
  return withActor(actor, async (db) => {
    const result = await db.query<{ id: string; title: string; kind: string; daily_date: string | null }>(
      `select p.id, p.title, p.kind, p.daily_date::text as daily_date from crm.pages p
       where p.workspace_id = $1 and p.archived_at is null and (p.kind = 'note' and p.title <> '' or p.kind = 'daily')
       order by (p.user_id is not distinct from $2) asc, p.effective_shared asc, p.edited_at asc`,
      [actor.workspaceId, actor.userId],
    );
    const map: Record<string, string> = {};
    for (const row of result.rows) {
      if (row.kind === "daily" && row.daily_date) map[row.daily_date] = row.id;
      else map[linkKey(row.title)] = row.id;
    }
    return map;
  });
}

type HeadingRow = { id: string; title: string; heading: string };

export async function docsLinkTargets(actor: UserActor, query: string, fromPageId: string | null): Promise<LinkTarget[]> {
  assertDocsRead(actor);
  const text = query.replace(/\s+/g, " ").trim().slice(0, 120);
  const from = fromPageId && isUuid(fromPageId) ? fromPageId : null;
  if (!text) {
    const [recent, folders] = await Promise.all([listDocs(actor, { sort: "edited", limit: 7 }), listFolders(actor)]);
    const names = new Map(folders.map((folder) => [folder.id, folder.name]));
    return recent.data
      .filter((doc) => doc.id !== from && doc.title)
      .slice(0, 6)
      .map((doc) => noteTarget(actor, doc, names));
  }
  const hits = await searchDocs(actor, text, { limit: 20 });
  const noteIds = hits.filter((hit) => hit.kind === "note" && hit.id !== from && hit.titleMatch && hit.title).slice(0, 5);
  const daily = hits.find((hit) => hit.kind === "daily" && hit.id !== from && hit.snippet);
  const pattern = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const words = prefixQuery(text);
  const [summaries, folders, headings] = await Promise.all([
    noteIds.length ? listSummaries(actor, noteIds.map((hit) => hit.id)) : Promise.resolve([] as DocSummary[]),
    noteIds.length ? listFolders(actor) : Promise.resolve([] as DocFolder[]),
    text.length >= 3 && words
      ? withActor(actor, async (db) => {
          const result = await db.query<HeadingRow>(
            `select c.id, c.title, m.parts[1] as heading from (
               select p.id, p.title, p.edited_at, left(p.content, 200000) as content from crm.pages p
               where p.workspace_id = $1 and p.archived_at is null and p.kind = 'note' and p.title <> '' and p.id is distinct from $3::uuid
                 and p.search @@ to_tsquery('english', $4)
                 and strpos(lower(left(p.content, 200000)), lower($5)) > 0
               order by p.edited_at desc
               limit 50
             ) c
             cross join lateral regexp_matches(c.content, '^\\s{0,3}#{1,6}\\s+([^\\n]*' || $2 || '[^\\n]*?)\\s*$', 'gin') as m(parts)
             order by c.edited_at desc limit 2`,
            [actor.workspaceId, pattern, from, words, text],
          );
          return result.rows;
        })
      : Promise.resolve([] as HeadingRow[]),
  ]);
  const order = new Map(noteIds.map((hit, index) => [hit.id, index]));
  const names = new Map(folders.map((folder) => [folder.id, folder.name]));
  const notes = summaries.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0)).map((doc) => noteTarget(actor, doc, names));
  return [
    ...notes,
    ...headings.map((row): LinkTarget => ({ kind: "heading", pageId: row.id, title: row.title, heading: row.heading.replace(/[*_`]/g, "").trim() })),
    ...(daily && daily.dailyDate ? [{ kind: "daily" as const, pageId: daily.id, title: shortDay(daily.dailyDate), dailyDate: daily.dailyDate, snippet: (daily.snippet ?? "").replace(/(^|\s)\d{2}:\d{2}(?=\s)/g, "").replace(/\s+/g, " ").trim() }] : []),
  ];
}

async function listSummaries(actor: UserActor, ids: string[]) {
  return withActor(actor, async (db) => {
    const result = await db.query<PageRow>(`${pageSelect(false)} where p.id = any($1::uuid[]) and p.workspace_id = $2 and p.archived_at is null`, [ids, actor.workspaceId]);
    return result.rows.map((row) => mapPage(actor, row));
  });
}

function noteTarget(actor: UserActor, doc: DocSummary, folderNames: Map<string, string>): LinkTarget {
  return {
    kind: "note",
    pageId: doc.id,
    title: doc.title,
    folderName: doc.folderId ? (folderNames.get(doc.folderId) ?? null) : null,
    shared: doc.effectiveShared,
    updatedAt: doc.editedAt,
    updatedBy: editorParticipant(actor, doc.lastEditor, doc.owner),
  };
}

export async function docsMentions(actor: UserActor, record: { kind: string; id: string }): Promise<SearchHit[]> {
  if (!(MENTION_KINDS as readonly string[]).includes(record.kind)) return [];
  const references = await docsMentioning(actor, { kind: record.kind as MentionKind, id: record.id });
  const summaries = await summariesByIds(actor, references.map((reference) => reference.id));
  return references.flatMap((reference) => {
    const summary = summaries.get(reference.id);
    return summary ? [{ page: summary, snippet: reference.snippet, matchFrom: 0, matchTo: 0 }] : [];
  });
}

export async function docsDailyList(actor: UserActor): Promise<DailySummary[]> {
  const days = await listDailyNotes(actor, { limit: 400 });
  return days.map((day) => ({ date: day.date, pageId: day.id, entries: day.entryCount, preview: day.excerpt }));
}

export async function docsDailyNote(actor: UserActor, date: string): Promise<Page> {
  const note = await openDailyNote(actor, date);
  return toPage(actor, note.page);
}

export async function docsMeetings(actor: UserActor, date: string): Promise<Meeting[]> {
  const meetings = await dailyMeetings(actor, date).catch(() => []);
  return meetings
    .filter((meeting) => !meeting.isAllDay)
    .map((meeting) => ({ id: meeting.id, title: meeting.subject, start: meeting.startsAt, href: `/calendar?date=${date}` }));
}

export type DocsActivity = { activity: Record<string, Participant[]>; revisions: Record<string, number> };

export async function docsActivity(actor: UserActor, now = new Date()): Promise<DocsActivity> {
  assertDocsRead(actor);
  return withActor(actor, async (db) => {
    const result = await db.query<{ id: string; revision: number; edited_at: Date }>(
      `select p.id, p.revision, p.edited_at from crm.pages p
       where p.workspace_id = $1 and p.archived_at is null and p.edited_by = 'assistant' and p.edited_at > $2
       order by p.edited_at desc limit 20`,
      [actor.workspaceId, new Date(now.getTime() - ACTIVITY_WINDOW_MS)],
    );
    const activity: Record<string, Participant[]> = {};
    const revisions: Record<string, number> = {};
    for (const row of result.rows) {
      activity[row.id] = [ASSISTANT_PARTICIPANT];
      revisions[row.id] = row.revision;
    }
    return { activity, revisions };
  });
}

export async function docsRecordDetails(actor: UserActor, refs: { kind: MentionKind; id: string; name: string }[]): Promise<RecordRef[]> {
  const ids = (kind: MentionKind) => refs.filter((ref) => ref.kind === kind && isUuid(ref.id)).map((ref) => ref.id);
  const details = await withActor(actor, async (db) => {
    const result = await db.query<{ id: string; name: string; detail: string | null }>(
      `select c.id, c.name, c.domain as detail from crm.companies c where c.id = any($2::uuid[]) and c.workspace_id = $1
       union all
       select p.id, trim(concat_ws(' ', p.first_name, p.last_name)), nullif(concat_ws(' at ', nullif(p.job_title, ''), co.name), '')
       from crm.contacts p left join crm.companies co on co.id = p.company_id where p.id = any($3::uuid[]) and p.workspace_id = $1
       union all
       select o.id, o.name, co.name from crm.opportunities o left join crm.companies co on co.id = o.company_id where o.id = any($4::uuid[]) and o.workspace_id = $1`,
      [actor.workspaceId, ids("company"), ids("contact"), ids("opportunity")],
    );
    return new Map(result.rows.map((row) => [row.id, row]));
  });
  return refs.map((ref) => {
    const found = details.get(ref.id);
    return { kind: ref.kind, id: ref.id, name: found?.name || ref.name, detail: found?.detail ?? null };
  });
}
