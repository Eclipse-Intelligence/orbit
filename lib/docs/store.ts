import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { iso, isUuid, recordAudit } from "@/lib/crm/mutate";
import { assertScope } from "@/lib/crm/scopes";
import type { Actor, Provenance } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { appendText } from "@/lib/docs/edits";
import { cleanTitle, excerptFrom, lineAround, linkKey, parseDoc, parseLinks, rewriteLinkTitle, wordCount } from "@/lib/docs/markdown";
import {
  DOC_CONTENT_MAX,
  DOC_READ_WINDOW,
  PERSON_VERSION_EVERY_MS,
  VERSION_DAYS_KEPT,
  VERSIONS_KEPT,
  type DocCreateInput,
  type DocDetail,
  type DocEditor,
  type DocEditorRef,
  type DocKind,
  type DocLink,
  type DocListQuery,
  type DocMention,
  type DocMoveResult,
  type DocReference,
  type DocSaveInput,
  type DocSummary,
  type DocTag,
  type DocVersion,
  type DocVersionDetail,
  type DocVisibility,
  type VersionReason,
  type VisibilityChange,
} from "@/lib/docs/types";
import type { MentionKind } from "@/lib/mentions";

export type Stamp = { editor: DocEditor; userId: string | null; agentId: string | null };

export type PageRow = {
  id: string;
  workspace_id: string;
  kind: DocKind;
  title: string;
  daily_date: string | null;
  folder_id: string | null;
  user_id: string | null;
  owner_name: string | null;
  shared: boolean;
  effective_shared: boolean;
  assistant_can_edit: boolean;
  head: string;
  word_count: number;
  revision: number;
  created_at: Date;
  updated_at: Date;
  edited_at: Date;
  edited_by: DocEditor;
  edited_by_user_id: string | null;
  editor_name: string | null;
  edited_by_agent_id: string | null;
  agent_name: string | null;
  versioned_at: Date | null;
  archived_at: Date | null;
  tags: string[];
};

export type FullPageRow = PageRow & { content: string };

const NOT_FOUND = "That doc doesn't exist, or it's private to someone else.";
const DEFAULT_PROVENANCE: Provenance = { operation: "docs" };

const PAGE_FIELDS = `p.id, p.workspace_id, p.kind, p.title, p.daily_date::text as daily_date, p.folder_id, p.user_id,
  coalesce(nullif(owner.full_name, ''), owner.email) as owner_name, p.shared, p.effective_shared, p.assistant_can_edit,
  left(p.content, 800) as head, p.word_count, p.revision, p.created_at, p.updated_at, p.edited_at, p.edited_by,
  p.edited_by_user_id, coalesce(nullif(editor.full_name, ''), editor.email) as editor_name, p.edited_by_agent_id,
  agent.name as agent_name, p.versioned_at, p.archived_at,
  coalesce((select array_agg(t.tag order by t.tag) from crm.page_tags t where t.page_id = p.id), '{}') as tags`;

const PAGE_JOINS = `crm.pages p
  left join crm.profiles owner on owner.id = p.user_id
  left join crm.profiles editor on editor.id = p.edited_by_user_id
  left join crm.agents agent on agent.id = p.edited_by_agent_id`;

export function pageSelect(withContent: boolean) {
  return `select ${PAGE_FIELDS}${withContent ? ", p.content" : ""} from ${PAGE_JOINS}`;
}

export function assertDocsRead(actor: Actor) {
  assertScope(actor.scopes, "docs:read");
}

export function assertDocsWrite(actor: Actor) {
  assertScope(actor.scopes, "docs:write");
}

export function stampFor(actor: Actor, provenance?: Provenance): Stamp {
  if (actor.type === "agent") return { editor: "agent", userId: null, agentId: actor.agentId };
  if (provenance?.source === "assistant") return { editor: "assistant", userId: actor.userId, agentId: null };
  if (provenance?.source === "mcp" || provenance?.source === "api") return { editor: "agent", userId: actor.userId, agentId: null };
  return { editor: "person", userId: actor.userId, agentId: null };
}

export function visibilityOf(shared: boolean, effectiveShared: boolean): DocVisibility {
  if (!effectiveShared) return "private";
  return shared ? "shared" : "shared_by_folder";
}

export function editorRef(editor: DocEditor, userId: string | null, personName: string | null, agentId: string | null, agentName: string | null): DocEditorRef {
  const name =
    editor === "assistant" ? "Orbit assistant" : editor === "agent" ? (agentId ? agentName ?? "Agent" : "MCP") : personName ?? "Someone";
  return { editor, name, userId, personName, agentId };
}

function ownedBy(actor: Actor, userId: string | null) {
  return actor.type === "user" && userId === actor.userId;
}

export function mapPage(actor: Actor, row: PageRow): DocSummary {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    dailyDate: row.daily_date,
    folderId: row.folder_id,
    owner: row.user_id ? { id: row.user_id, name: row.owner_name ?? "Former member" } : null,
    ownedByMe: ownedBy(actor, row.user_id),
    shared: row.shared,
    effectiveShared: row.effective_shared,
    visibility: visibilityOf(row.shared, row.effective_shared),
    assistantCanEdit: row.assistant_can_edit,
    excerpt: excerptFrom(row.head),
    tags: row.tags ?? [],
    wordCount: row.word_count,
    revision: row.revision,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    editedAt: iso(row.edited_at)!,
    lastEditor: editorRef(row.edited_by, row.edited_by_user_id, row.editor_name, row.edited_by_agent_id, row.agent_name),
    archivedAt: iso(row.archived_at),
  };
}

export async function loadPage(db: Db, actor: Actor, id: string, options: { lock?: boolean } = {}) {
  if (!isUuid(id)) throw new CrmError("not_found", NOT_FOUND, 404);
  const result = await db.query<FullPageRow>(
    `${pageSelect(true)} where p.id = $1 and p.workspace_id = $2${options.lock ? " for update of p" : ""}`,
    [id, actor.workspaceId],
  );
  const row = result.rows[0];
  if (!row) throw new CrmError("not_found", NOT_FOUND, 404);
  return row;
}

export function checkTitle(value: unknown, fallback = "") {
  const title = typeof value === "string" ? cleanTitle(value) : fallback;
  if (typeof value === "string" && value.replace(/\s+/g, " ").trim().length > 300) {
    throw new CrmError("invalid_input", "A title can be up to 300 characters. Shorten it and try again.", 400, { field: "title" });
  }
  if (/[[\]|]/.test(title)) {
    throw new CrmError("invalid_input", "A title can't contain [, ] or |, because links use them. Take them out and try again.", 400, { field: "title" });
  }
  return title;
}

export function checkContent(value: unknown) {
  const content = typeof value === "string" ? value.replace(/\r\n?/g, "\n") : "";
  if (content.length > DOC_CONTENT_MAX) {
    throw new CrmError(
      "invalid_input",
      `A doc can hold up to ${DOC_CONTENT_MAX.toLocaleString("en-GB")} characters. This one has ${content.length.toLocaleString("en-GB")}. Split it into two docs.`,
      400,
      { field: "content" },
    );
  }
  return content;
}

type LinkRow = { key: string; pageId: string | null; label: string; heading: string | null };

type LinkPlan = { content: string; links: LinkRow[]; tags: string[]; mentions: DocMention[] };

async function planLinks(db: Db, page: { id: string; workspace_id: string; user_id: string | null }, content: string, depth = 0): Promise<LinkPlan> {
  const parsed = parseDoc(content);
  const raws = [...new Set(parsed.links.flatMap((link) => (link.heading !== null && link.title ? [link.target, link.title] : [link.target])))];
  const found = new Map<string, { key: string; id: string | null; title: string | null }>();
  if (raws.length > 0) {
    const result = await db.query<{ raw: string; key: string; id: string | null; title: string | null }>(
      `select k.raw, lower(k.raw) as key, c.id, c.title
       from unnest($1::text[]) as k(raw)
       left join lateral (
         select t.id, t.title from crm.pages t
         where t.workspace_id = $2 and t.archived_at is null and t.id <> $3 and lower(t.title) = lower(k.raw)
           and (t.effective_shared or t.user_id = $4)
         order by (t.user_id is not distinct from $4) desc, t.effective_shared desc, t.edited_at desc
         limit 1
       ) c on true`,
      [raws, page.workspace_id, page.id, page.user_id],
    );
    for (const row of result.rows) found.set(row.raw, row);
  }
  const sticky = new Map<string, { id: string; title: string }>();
  const unresolved = parsed.links.some((link) => !found.get(link.target)?.id && !(link.heading !== null && found.get(link.title)?.id));
  if (unresolved) {
    const previous = await db.query<{ key: string; id: string; title: string }>(
      `select l.target_key as key, t.id, t.title from crm.page_links l
       join crm.pages t on t.id = l.target_page_id
       where l.page_id = $1 and l.target_kind = 'page' and (t.effective_shared or t.user_id is not distinct from $2)`,
      [page.id, page.user_id],
    );
    for (const row of previous.rows) sticky.set(row.key, { id: row.id, title: row.title });
  }
  let rewritten = content;
  const renames: { from: string; to: string }[] = [];
  const rows = new Map<string, LinkRow>();
  for (const link of parsed.links) {
    const whole = found.get(link.target);
    const byTitle = link.heading !== null ? found.get(link.title) : undefined;
    if (whole?.id) {
      if (!rows.has(whole.key)) rows.set(whole.key, { key: whole.key, pageId: whole.id, label: link.target, heading: link.heading });
      continue;
    }
    if (byTitle?.id) {
      if (!rows.has(byTitle.key)) rows.set(byTitle.key, { key: byTitle.key, pageId: byTitle.id, label: link.target, heading: link.heading });
      continue;
    }
    const keyWhole = whole?.key ?? linkKey(link.target);
    const keyTitle = byTitle?.key ?? linkKey(link.title);
    const kept = sticky.get(keyWhole) ?? (link.heading !== null ? sticky.get(keyTitle) : undefined);
    if (kept) {
      const usedTitle = sticky.get(keyWhole) ? link.target : link.title;
      if (linkKey(kept.title) !== linkKey(usedTitle) && kept.title.trim()) renames.push({ from: usedTitle, to: kept.title });
      const key = sticky.get(keyWhole) ? keyWhole : keyTitle;
      if (!rows.has(key)) rows.set(key, { key, pageId: kept.id, label: link.target, heading: link.heading });
      continue;
    }
    const key = link.heading !== null && link.title ? keyTitle : keyWhole;
    if (!rows.has(key)) rows.set(key, { key, pageId: null, label: link.target, heading: link.heading });
  }
  if (renames.length > 0 && depth === 0) {
    for (const rename of renames) rewritten = rewriteLinkTitle(rewritten, rename.from, rename.to).content;
    if (rewritten !== content) return planLinks(db, page, rewritten, depth + 1);
  }
  return { content: rewritten, links: [...rows.values()], tags: parsed.tags, mentions: parsed.mentions };
}

async function writeIndex(db: Db, page: { id: string; workspace_id: string }, plan: LinkPlan) {
  await db.query("delete from crm.page_links where page_id = $1", [page.id]);
  await db.query("delete from crm.page_tags where page_id = $1", [page.id]);
  if (plan.links.length > 0) {
    await db.query(
      `insert into crm.page_links (workspace_id, page_id, target_kind, target_key, target_page_id, label, heading)
       select $1, $2, 'page', x.key, x.target, left(x.label, 400), left(x.heading, 400)
       from unnest($3::text[], $4::uuid[], $5::text[], $6::text[]) as x(key, target, label, heading)`,
      [page.workspace_id, page.id, plan.links.map((link) => link.key), plan.links.map((link) => link.pageId), plan.links.map((link) => link.label), plan.links.map((link) => link.heading)],
    );
  }
  if (plan.mentions.length > 0) {
    await db.query(
      `insert into crm.page_links (workspace_id, page_id, target_kind, target_record_id, label)
       select $1, $2, x.kind, x.id, left(x.name, 400)
       from unnest($3::text[], $4::uuid[], $5::text[]) as x(kind, id, name)`,
      [page.workspace_id, page.id, plan.mentions.map((mention) => mention.kind), plan.mentions.map((mention) => mention.id), plan.mentions.map((mention) => mention.name || mention.kind)],
    );
  }
  if (plan.tags.length > 0) {
    await db.query(
      `insert into crm.page_tags (page_id, workspace_id, tag) select $1, $2, x.tag from unnest($3::text[]) as x(tag) on conflict do nothing`,
      [page.id, page.workspace_id, plan.tags],
    );
  }
}

async function snapshot(
  db: Db,
  page: { id: string; workspace_id: string },
  state: { title: string; content: string },
  reason: VersionReason,
  stamp: Stamp,
  summary: string | null,
) {
  await db.query(
    `insert into crm.page_versions (workspace_id, page_id, title, content, word_count, reason, editor, user_id, agent_id, summary)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [page.workspace_id, page.id, state.title, state.content, wordCount(state.content), reason, stamp.editor, stamp.userId, stamp.agentId, summary ? summary.slice(0, 500) : null],
  );
}

async function pruneVersions(db: Db, pageId: string) {
  await db.query(
    `delete from crm.page_versions where id in (
       select v.id from (
         select id, created_at,
           row_number() over (order by created_at desc) as newest,
           row_number() over (partition by (created_at at time zone 'Europe/London')::date order by created_at desc) as in_day
         from crm.page_versions where page_id = $1
       ) v
       where v.newest > $2 and (v.in_day > 1 or v.created_at < now() - make_interval(days => $3))
     )`,
    [pageId, VERSIONS_KEPT, VERSION_DAYS_KEPT],
  );
}

export async function auditDoc(
  db: Db,
  actor: Actor,
  event: string,
  page: { id: string; title: string; effective_shared: boolean },
  provenance: Provenance | undefined,
  changes: Record<string, unknown>,
  wasShared = page.effective_shared,
) {
  if (!page.effective_shared && !wasShared) return;
  await recordAudit(db, actor, event, "page", page.id, provenance ?? DEFAULT_PROVENANCE, { title: page.title, ...changes });
}

export type CommitOptions = {
  stamp: Stamp;
  provenance?: Provenance;
  reason?: VersionReason;
  summary?: string | null;
  ydoc?: Uint8Array | null;
  baseRevision?: number;
  now?: Date;
};

export async function commitPage(db: Db, actor: Actor, page: FullPageRow, next: { title: string; content: string }, options: CommitOptions) {
  if (options.baseRevision !== undefined && options.baseRevision !== page.revision) {
    throw new CrmError("conflict", "This doc changed since you opened it. Reload it to see the latest, then make your change again.", 409, {
      revision: page.revision,
    });
  }
  if (page.kind === "daily" && next.title !== page.title) {
    throw new CrmError("invalid_input", "A daily note is named after its date, so it can't be renamed.", 400, { field: "title" });
  }
  const contentChanged = next.content !== page.content;
  const plan = contentChanged ? await planLinks(db, page, next.content) : null;
  const content = plan?.content ?? next.content;
  const titleChanged = next.title !== page.title;
  if (!titleChanged && content === page.content && options.ydoc === undefined) return { changed: false, versioned: false };
  const now = options.now ?? new Date();
  const thorough = options.stamp.editor !== "person" || options.reason === "restored" || options.reason === "link_renamed";
  if (thorough) {
    const latest = await db.query<{ title: string; content: string }>(
      "select title, content from crm.page_versions where page_id = $1 order by created_at desc limit 1",
      [page.id],
    );
    const last = latest.rows[0];
    if (!last || last.content !== page.content || last.title !== page.title) {
      await snapshot(db, page, page, "before_agent", { editor: page.edited_by, userId: page.edited_by_user_id, agentId: page.edited_by_agent_id }, null);
    }
  }
  const takeVersion =
    (thorough || titleChanged || !page.versioned_at || now.getTime() - new Date(page.versioned_at).getTime() >= PERSON_VERSION_EVERY_MS) &&
    (titleChanged || content !== page.content);
  await db.query(
    `update crm.pages set title = $2, content = $3, word_count = $4, revision = revision + 1, edited_by = $5, edited_by_user_id = $6,
       edited_by_agent_id = $7, edited_at = $8, versioned_at = case when $9 then $8 else versioned_at end,
       ydoc = case when $10 then $11::bytea else ydoc end
     where id = $1`,
    [
      page.id,
      next.title,
      content,
      wordCount(content),
      options.stamp.editor,
      options.stamp.userId,
      options.stamp.agentId,
      now,
      takeVersion,
      options.ydoc !== undefined,
      options.ydoc ? Buffer.from(options.ydoc) : null,
    ],
  );
  if (plan) await writeIndex(db, page, plan);
  if (takeVersion) {
    const reason = options.reason ?? (titleChanged ? "renamed" : "edited");
    await snapshot(db, page, { title: next.title, content }, reason, options.stamp, options.summary ?? (titleChanged ? `Renamed from ${page.title || "Untitled"}` : null));
    await pruneVersions(db, page.id);
    await auditDoc(db, actor, "page.updated", { ...page, title: next.title }, options.provenance, {
      editor: options.stamp.editor,
      reason,
      ...(titleChanged ? { previousTitle: page.title } : {}),
      ...(options.summary ? { summary: options.summary } : {}),
    });
  }
  return { changed: true, versioned: takeVersion };
}

async function linkingPages(db: Db, pageId: string) {
  const result = await db.query<{ id: string }>(
    `select distinct p.id from crm.page_links l join crm.pages p on p.id = l.page_id
     where l.target_page_id = $1 and p.id <> $1 and p.archived_at is null`,
    [pageId],
  );
  return result.rows.map((row) => row.id);
}

async function detail(db: Db, actor: Actor, row: FullPageRow): Promise<DocDetail> {
  const path = row.folder_id
    ? await db.query<{ id: string; name: string }>(
        `with recursive up as (
           select f.id, f.parent_id, f.name, 0 as depth from crm.page_folders f where f.id = $1
           union all
           select f.id, f.parent_id, f.name, up.depth + 1 from crm.page_folders f join up on f.id = up.parent_id where up.depth < 50
         )
         select id, name from up order by depth desc`,
        [row.folder_id],
      )
    : { rows: [] };
  const links = await db.query<{
    target_kind: string;
    target_key: string | null;
    label: string;
    heading: string | null;
    target_page_id: string | null;
    target_record_id: string | null;
    visible_id: string | null;
    visible_title: string | null;
    archived_at: Date | null;
  }>(
    `select l.target_kind, l.target_key, l.label, l.heading, l.target_page_id, l.target_record_id, t.id as visible_id, t.title as visible_title, t.archived_at
     from crm.page_links l left join crm.pages t on t.id = l.target_page_id
     where l.page_id = $1 order by l.created_at, l.label`,
    [row.id],
  );
  const pageLinks: DocLink[] = [];
  const mentions: DocMention[] = [];
  for (const link of links.rows) {
    if (link.target_kind === "page") {
      const target = link.label.includes("#") && link.heading ? link.label.slice(0, link.label.indexOf("#")).trim() : link.label;
      pageLinks.push({
        title: target,
        heading: link.heading,
        pageId: link.visible_id,
        pageTitle: link.visible_title,
        archived: Boolean(link.archived_at),
      });
    } else if (link.target_record_id) {
      mentions.push({ kind: link.target_kind as MentionKind, id: link.target_record_id, name: link.label });
    }
  }
  const order = new Map<string, number>();
  parseLinks(row.content).forEach((link, index) => {
    for (const key of [linkKey(link.target), linkKey(link.title)]) if (!order.has(key)) order.set(key, index);
  });
  pageLinks.sort((left, right) => (order.get(linkKey(left.title)) ?? Infinity) - (order.get(linkKey(right.title)) ?? Infinity));
  const owner = ownedBy(actor, row.user_id);
  return {
    ...mapPage(actor, row),
    content: row.content,
    path: path.rows,
    links: pageLinks,
    mentions,
    canChangeSharing: row.kind === "note" && (row.shared ? owner : true),
    canChangeAssistantEdit: actor.type === "user",
  };
}

export async function docDetail(db: Db, actor: Actor, id: string) {
  return detail(db, actor, await loadPage(db, actor, id));
}

export async function getDoc(actor: Actor, id: string): Promise<DocDetail> {
  assertDocsRead(actor);
  return withActor(actor, (db) => docDetail(db, actor, id));
}

export async function readDoc(actor: Actor, id: string, offset = 0) {
  assertDocsRead(actor);
  const start = Math.max(0, Math.floor(offset));
  return withActor(actor, async (db) => {
    if (!isUuid(id)) throw new CrmError("not_found", NOT_FOUND, 404);
    const result = await db.query<FullPageRow & { characters: number }>(
      `select ${PAGE_FIELDS}, substr(p.content, $3 + 1, $4) as content, char_length(p.content) as characters
       from ${PAGE_JOINS} where p.id = $1 and p.workspace_id = $2`,
      [id, actor.workspaceId, start, DOC_READ_WINDOW],
    );
    const row = result.rows[0];
    if (!row) throw new CrmError("not_found", NOT_FOUND, 404);
    const end = start + row.content.length;
    return { doc: mapPage(actor, row), offset: start, text: row.content, characters: row.characters, nextOffset: end < row.characters ? end : null };
  });
}

export async function listDocs(actor: Actor, query: DocListQuery = {}): Promise<{ data: DocSummary[]; hasMore: boolean }> {
  assertDocsRead(actor);
  const limit = Math.min(200, Math.max(1, Math.trunc(query.limit ?? 50)));
  const offset = Math.min(10_000, Math.max(0, Math.trunc(query.offset ?? 0)));
  const values: unknown[] = [actor.workspaceId];
  const where = ["p.workspace_id = $1", query.archived ? "p.archived_at is not null" : "p.archived_at is null"];
  if (query.folderId === null) {
    where.push("p.kind = 'note' and (p.folder_id is null or not exists (select 1 from crm.page_folders f where f.id = p.folder_id))");
  } else if (query.folderId) {
    if (!isUuid(query.folderId)) throw new CrmError("not_found", "That folder doesn't exist, or it's private to someone else.", 404);
    values.push(query.folderId);
    where.push(`p.folder_id = $${values.length}`);
  } else if (!query.tag) {
    where.push("p.kind = 'note'");
  }
  if (query.tag) {
    const tag = query.tag.trim().replace(/^#/, "").toLowerCase();
    values.push(tag, `${tag.replace(/[\\%_]/g, (match) => `\\${match}`)}/%`);
    where.push(`exists (select 1 from crm.page_tags t where t.page_id = p.id and (t.tag = $${values.length - 1} or t.tag like $${values.length} escape '\\'))`);
  }
  const order = query.sort === "title" ? "lower(p.title) asc, p.edited_at desc" : query.sort === "created" ? "p.created_at desc" : "p.edited_at desc";
  values.push(limit + 1, offset);
  return withActor(actor, async (db) => {
    const result = await db.query<PageRow>(
      `${pageSelect(false)} where ${where.join(" and ")} order by ${order}, p.id limit $${values.length - 1} offset $${values.length}`,
      values,
    );
    return { data: result.rows.slice(0, limit).map((row) => mapPage(actor, row)), hasMore: result.rows.length > limit };
  });
}

export async function listDocTags(actor: Actor): Promise<DocTag[]> {
  assertDocsRead(actor);
  return withActor(actor, async (db) => {
    const result = await db.query<{ tag: string; count: number }>(
      `select t.tag, count(*)::int as count from crm.page_tags t join crm.pages p on p.id = t.page_id
       where p.workspace_id = $1 and p.archived_at is null group by t.tag order by t.tag`,
      [actor.workspaceId],
    );
    return result.rows;
  });
}

type FolderRow = { id: string; user_id: string | null; effective_shared: boolean; archived_at: Date | null; name: string };

export async function placeableFolder(db: Db, actor: Actor, folderId: string, ownerId: string | null) {
  if (!isUuid(folderId)) throw new CrmError("not_found", "That folder doesn't exist, or it's private to someone else.", 404, { field: "folderId" });
  const result = await db.query<FolderRow>(
    "select id, user_id, effective_shared, archived_at, name from crm.page_folders where id = $1 and workspace_id = $2",
    [folderId, actor.workspaceId],
  );
  const folder = result.rows[0];
  if (!folder) throw new CrmError("not_found", "That folder doesn't exist, or it's private to someone else.", 404, { field: "folderId" });
  if (folder.archived_at) throw new CrmError("invalid_input", `${folder.name} is archived. Restore it first, or choose another folder.`, 400, { field: "folderId" });
  if (!folder.effective_shared && folder.user_id !== ownerId) {
    throw new CrmError("forbidden", `${folder.name} is private to someone else, so only their own docs can go in it.`, 403, { field: "folderId" });
  }
  return folder;
}

export async function createDoc(actor: Actor, input: DocCreateInput, provenance?: Provenance): Promise<DocDetail> {
  assertDocsWrite(actor);
  const title = checkTitle(input.title);
  const content = checkContent(input.content);
  return withActor(actor, async (db) => {
    const folder = input.folderId ? await placeableFolder(db, actor, input.folderId, actor.type === "user" ? actor.userId : null) : null;
    const owner = actor.type === "user" ? actor.userId : folder?.user_id ?? null;
    const shared = owner === null ? true : input.shared === true;
    if (actor.type === "agent" && !shared && !folder?.effective_shared) {
      throw new CrmError("forbidden", "Agent tokens can only create shared docs. Put it in a shared folder or share it.", 403);
    }
    const stamp = stampFor(actor, provenance);
    const inserted = await db.query<{ id: string }>(
      `insert into crm.pages (workspace_id, user_id, folder_id, kind, title, content, word_count, shared, created_by_agent_id, edited_by, edited_by_user_id, edited_by_agent_id, versioned_at)
       values ($1, $2, $3, 'note', $4, '', 0, $5, $6, $7, $8, $9, null) returning id`,
      [actor.workspaceId, owner, folder?.id ?? null, title, shared, actor.type === "agent" ? actor.agentId : null, stamp.editor, stamp.userId, stamp.agentId],
    );
    const row = await loadPage(db, actor, inserted.rows[0].id, { lock: true });
    if (content) {
      const plan = await planLinks(db, row, content);
      await db.query("update crm.pages set content = $2, word_count = $3, versioned_at = now() where id = $1", [row.id, plan.content, wordCount(plan.content)]);
      await writeIndex(db, row, plan);
      await snapshot(db, row, { title, content: plan.content }, "created", stamp, null);
    }
    await auditDoc(db, actor, "page.created", row, provenance, { folderId: row.folder_id, editor: stamp.editor });
    return docDetail(db, actor, row.id);
  });
}

export async function saveDoc(actor: Actor, id: string, input: DocSaveInput, provenance?: Provenance): Promise<DocDetail> {
  assertDocsWrite(actor);
  return withActor(actor, async (db) => {
    const page = await loadPage(db, actor, id, { lock: true });
    if (page.archived_at) throw new CrmError("invalid_input", "This doc is archived. Restore it before editing.", 400);
    if (input.baseRevision !== undefined && input.baseRevision !== page.revision) {
      throw new CrmError("conflict", "This doc changed since you opened it. Reload it to see the latest, then make your change again.", 409, {
        revision: page.revision,
      });
    }
    const title = input.title === undefined ? page.title : checkTitle(input.title);
    const content = input.content === undefined ? page.content : checkContent(input.content);
    if (title !== page.title) {
      await renameInside(db, actor, page, title, stampFor(actor, provenance), provenance);
      const renamed = await loadPage(db, actor, id, { lock: true });
      await commitPage(db, actor, renamed, { title, content }, { stamp: stampFor(actor, provenance), provenance, ydoc: input.ydoc });
    } else {
      await commitPage(db, actor, page, { title, content }, { stamp: stampFor(actor, provenance), provenance, ydoc: input.ydoc });
    }
    return docDetail(db, actor, id);
  });
}

async function renameInside(db: Db, actor: Actor, page: FullPageRow, title: string, stamp: Stamp, provenance?: Provenance) {
  const before = page.title;
  await commitPage(db, actor, page, { title, content: page.content }, { stamp, provenance, reason: "renamed" });
  if (!before.trim() || linkKey(before) === linkKey(title)) return 0;
  let updated = 0;
  for (const linkingId of await linkingPages(db, page.id)) {
    const linking = await loadPage(db, actor, linkingId, { lock: true });
    const rewritten = rewriteLinkTitle(linking.content, before, title);
    if (rewritten.count === 0) continue;
    await commitPage(db, actor, linking, { title: linking.title, content: rewritten.content }, {
      stamp,
      provenance,
      reason: "link_renamed",
      summary: `Updated links to ${title}`,
    });
    updated += 1;
  }
  return updated;
}

export async function renameDoc(actor: Actor, id: string, title: unknown, provenance?: Provenance) {
  assertDocsWrite(actor);
  const next = checkTitle(title);
  return withActor(actor, async (db) => {
    const page = await loadPage(db, actor, id, { lock: true });
    if (page.archived_at) throw new CrmError("invalid_input", "This doc is archived. Restore it before renaming.", 400);
    if (page.kind === "daily") throw new CrmError("invalid_input", "A daily note is named after its date, so it can't be renamed.", 400, { field: "title" });
    const linksUpdated = next === page.title ? 0 : await renameInside(db, actor, page, next, stampFor(actor, provenance), provenance);
    return { doc: await docDetail(db, actor, id), linksUpdated };
  });
}

export async function changeDocContent(
  db: Db,
  actor: Actor,
  page: FullPageRow,
  content: string,
  options: { provenance?: Provenance; summary?: string | null; baseRevision?: number },
) {
  if (page.archived_at) throw new CrmError("invalid_input", "This doc is archived. Restore it before editing.", 400);
  return commitPage(db, actor, page, { title: page.title, content: checkContent(content) }, {
    stamp: stampFor(actor, options.provenance),
    provenance: options.provenance,
    summary: options.summary,
    baseRevision: options.baseRevision,
  });
}

export async function appendToDoc(actor: Actor, id: string, text: string, provenance?: Provenance) {
  assertDocsWrite(actor);
  return withActor(actor, async (db) => {
    const page = await loadPage(db, actor, id, { lock: true });
    await changeDocContent(db, actor, page, appendText(page.content, text), { provenance, summary: "Added to the end" });
    return docDetail(db, actor, id);
  });
}

function visibilityChange(before: DocVisibility, after: DocVisibility): VisibilityChange {
  return { before, after, changed: (before === "private") !== (after === "private") };
}

export function visibilityError(after: DocVisibility, where: string) {
  return new CrmError(
    "visibility_change",
    after === "private"
      ? `Moving it to ${where} makes it private, so teammates and agents will no longer see it. Move it again with allowVisibilityChange set if that's what you want.`
      : `Moving it to ${where} shares it with everyone in the workspace, who can then read and edit it. Move it again with allowVisibilityChange set if that's what you want.`,
    409,
    { after },
  );
}

export async function moveDoc(
  actor: Actor,
  id: string,
  input: { folderId: string | null; allowVisibilityChange?: boolean },
  provenance?: Provenance,
): Promise<DocMoveResult> {
  assertDocsWrite(actor);
  return withActor(actor, async (db) => {
    const page = await loadPage(db, actor, id, { lock: true });
    if (page.kind === "daily") throw new CrmError("invalid_input", "Daily notes stay in Daily notes and can't go in folders.", 400, { field: "folderId" });
    if (page.archived_at) throw new CrmError("invalid_input", "This doc is archived. Restore it before moving it.", 400);
    const folder = input.folderId ? await placeableFolder(db, actor, input.folderId, page.user_id) : null;
    const before = visibilityOf(page.shared, page.effective_shared);
    const afterShared = page.shared || Boolean(folder?.effective_shared);
    const after = visibilityOf(page.shared, afterShared);
    const change = visibilityChange(before, after);
    if (!afterShared && !ownedBy(actor, page.user_id)) {
      throw new CrmError("forbidden", `That would make it private to ${page.owner_name ?? "its owner"}, so only they can move it there.`, 403, { field: "folderId" });
    }
    if (change.changed && !input.allowVisibilityChange) throw visibilityError(after, folder ? folder.name : "no folder");
    if ((page.folder_id ?? null) !== (folder?.id ?? null)) {
      await db.query("update crm.pages set folder_id = $2 where id = $1", [page.id, folder?.id ?? null]);
      await auditDoc(db, actor, "page.moved", { ...page, effective_shared: afterShared }, provenance, { folderId: folder?.id ?? null, previousFolderId: page.folder_id, visibility: after }, page.effective_shared);
    }
    const moved = await loadPage(db, actor, id);
    return { page: mapPage(actor, moved), visibility: change };
  });
}

export async function shareDoc(actor: Actor, id: string, shared: boolean, provenance?: Provenance) {
  assertDocsWrite(actor);
  return withActor(actor, async (db) => {
    const page = await loadPage(db, actor, id, { lock: true });
    if (page.kind === "daily") throw new CrmError("forbidden", "Daily notes are always private, so they can't be shared.", 403);
    if (page.shared === shared) return { doc: await docDetail(db, actor, id), visibility: visibilityChange(visibilityOf(page.shared, page.effective_shared), visibilityOf(page.shared, page.effective_shared)) };
    if (!shared && !ownedBy(actor, page.user_id)) {
      throw new CrmError(
        "forbidden",
        page.user_id ? `Only ${page.owner_name ?? "its owner"} can make this doc private.` : "This doc has no owner, so it can't be made private. A member can copy it into a private doc instead.",
        403,
      );
    }
    await db.query("update crm.pages set shared = $2 where id = $1", [page.id, shared]);
    const after = await loadPage(db, actor, id);
    await auditDoc(db, actor, "page.shared", after, provenance, { shared, visibility: visibilityOf(after.shared, after.effective_shared) }, page.effective_shared);
    return {
      doc: await detail(db, actor, after),
      visibility: visibilityChange(visibilityOf(page.shared, page.effective_shared), visibilityOf(after.shared, after.effective_shared)),
    };
  });
}

export async function setAssistantCanEdit(actor: Actor, id: string, allowed: boolean) {
  assertDocsWrite(actor);
  if (actor.type !== "user") throw new CrmError("forbidden", "Only a person can change whether the assistant edits without asking.", 403);
  return withActor(actor, async (db) => {
    const page = await loadPage(db, actor, id, { lock: true });
    if (page.archived_at) throw new CrmError("invalid_input", "This doc is archived. Restore it first.", 400);
    await db.query("update crm.pages set assistant_can_edit = $2 where id = $1", [page.id, allowed]);
    return docDetail(db, actor, id);
  });
}

export async function assistantMayEdit(actor: Actor, id: string) {
  if (actor.type !== "user" || !isUuid(id)) return false;
  return withActor(actor, async (db) => {
    const result = await db.query<{ ok: boolean }>(
      "select assistant_can_edit and archived_at is null as ok from crm.pages where id = $1 and workspace_id = $2",
      [id, actor.workspaceId],
    );
    return result.rows[0]?.ok === true;
  });
}

export async function lockForAssistant(db: Db, actor: Actor, id: string) {
  const page = await loadPage(db, actor, id, { lock: true });
  if (!page.assistant_can_edit || page.archived_at) {
    throw new CrmError("forbidden", "The assistant isn't allowed to edit this doc without asking any more. Propose the change for approval instead.", 403);
  }
  return page;
}

export async function archiveDoc(actor: Actor, id: string, provenance?: Provenance) {
  assertDocsWrite(actor);
  return withActor(actor, async (db) => {
    const page = await loadPage(db, actor, id, { lock: true });
    if (!page.archived_at) {
      await db.query("update crm.pages set archived_at = now() where id = $1", [page.id]);
      await auditDoc(db, actor, "page.archived", page, provenance, {});
    }
    return docDetail(db, actor, id);
  });
}

export async function restoreDoc(actor: Actor, id: string, provenance?: Provenance) {
  assertDocsWrite(actor);
  return withActor(actor, async (db) => {
    const page = await loadPage(db, actor, id, { lock: true });
    if (!page.archived_at) return docDetail(db, actor, id);
    if (page.folder_id) {
      const folder = await db.query<{ name: string; archived_at: Date | null }>("select name, archived_at from crm.page_folders where id = $1", [page.folder_id]);
      if (folder.rows[0]?.archived_at) throw new CrmError("invalid_input", `It's in ${folder.rows[0].name}, which is archived. Restore that folder first.`, 400);
    }
    await db.query("update crm.pages set archived_at = null where id = $1", [page.id]);
    await auditDoc(db, actor, "page.restored", page, provenance, {});
    return docDetail(db, actor, id);
  });
}

type ReferenceRow = {
  id: string;
  kind: DocKind;
  title: string;
  daily_date: string | null;
  folder_id: string | null;
  folder_name: string | null;
  shared: boolean;
  effective_shared: boolean;
  user_id: string | null;
  edited_at: Date;
  content: string;
};

const REFERENCE_FIELDS = `p.id, p.kind, p.title, p.daily_date::text as daily_date, p.folder_id, f.name as folder_name, p.shared, p.effective_shared,
  p.user_id, p.edited_at, left(p.content, 200000) as content`;

function reference(actor: Actor, row: ReferenceRow, index: number): DocReference {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    dailyDate: row.daily_date,
    folderId: row.folder_id,
    folderName: row.folder_name,
    visibility: visibilityOf(row.shared, row.effective_shared),
    ownedByMe: ownedBy(actor, row.user_id),
    editedAt: iso(row.edited_at)!,
    snippet: index >= 0 ? lineAround(row.content, index) : excerptFrom(row.content),
  };
}

export async function listBacklinks(actor: Actor, id: string): Promise<DocReference[]> {
  assertDocsRead(actor);
  return withActor(actor, async (db) => {
    const page = await loadPage(db, actor, id);
    const result = await db.query<ReferenceRow & { target_key: string }>(
      `select ${REFERENCE_FIELDS}, l.target_key from crm.page_links l
       join crm.pages p on p.id = l.page_id
       left join crm.page_folders f on f.id = p.folder_id
       where l.target_page_id = $1 and p.id <> $1 and p.archived_at is null
       order by p.edited_at desc limit 100`,
      [page.id],
    );
    return result.rows.map((row) => {
      const link = parseLinks(row.content).find((entry) => linkKey(entry.target) === row.target_key || linkKey(entry.title) === row.target_key);
      return reference(actor, row, link?.start ?? -1);
    });
  });
}

export async function listUnlinkedMentions(actor: Actor, id: string): Promise<DocReference[]> {
  assertDocsRead(actor);
  return withActor(actor, async (db) => {
    const page = await loadPage(db, actor, id);
    const title = page.title.trim();
    if (title.length < 3) return [];
    const result = await db.query<ReferenceRow>(
      `select ${REFERENCE_FIELDS} from crm.pages p
       left join crm.page_folders f on f.id = p.folder_id
       where p.workspace_id = $1 and p.id <> $2 and p.archived_at is null
         and p.search @@ phraseto_tsquery('english', $3)
         and strpos(lower(p.content), lower($3)) > 0
         and not exists (select 1 from crm.page_links l where l.page_id = p.id and l.target_page_id = $2)
       order by p.edited_at desc limit 50`,
      [actor.workspaceId, page.id, title],
    );
    return result.rows.map((row) => reference(actor, row, row.content.toLowerCase().indexOf(title.toLowerCase())));
  });
}

export async function docsMentioning(actor: Actor, target: { kind: MentionKind; id: string }): Promise<DocReference[]> {
  assertDocsRead(actor);
  if (!isUuid(target.id)) return [];
  return withActor(actor, async (db) => {
    const result = await db.query<ReferenceRow>(
      `select ${REFERENCE_FIELDS} from crm.page_links l
       join crm.pages p on p.id = l.page_id
       left join crm.page_folders f on f.id = p.folder_id
       where l.workspace_id = $1 and l.target_kind = $2 and l.target_record_id = $3 and p.archived_at is null
       order by p.edited_at desc limit 100`,
      [actor.workspaceId, target.kind, target.id],
    );
    return result.rows.map((row) => reference(actor, row, row.content.indexOf(`](${target.kind}:${target.id})`)));
  });
}

type VersionRow = {
  id: string;
  page_id: string;
  created_at: Date;
  reason: VersionReason;
  editor: DocEditor;
  user_id: string | null;
  user_name: string | null;
  agent_id: string | null;
  agent_name: string | null;
  title: string;
  summary: string | null;
  word_count: number;
  content?: string;
};

const VERSION_FIELDS = `v.id, v.page_id, v.created_at, v.reason, v.editor, v.user_id, coalesce(nullif(u.full_name, ''), u.email) as user_name,
  v.agent_id, a.name as agent_name, v.title, v.summary, v.word_count`;

const VERSION_JOINS = `crm.page_versions v left join crm.profiles u on u.id = v.user_id left join crm.agents a on a.id = v.agent_id`;

function mapVersion(row: VersionRow): DocVersion {
  return {
    id: row.id,
    pageId: row.page_id,
    createdAt: iso(row.created_at)!,
    reason: row.reason,
    by: editorRef(row.editor, row.user_id, row.user_name, row.agent_id, row.agent_name),
    title: row.title,
    summary: row.summary,
    wordCount: row.word_count,
  };
}

export async function listVersions(actor: Actor, pageId: string, limit = 100): Promise<DocVersion[]> {
  assertDocsRead(actor);
  return withActor(actor, async (db) => {
    const page = await loadPage(db, actor, pageId);
    const result = await db.query<VersionRow>(
      `select ${VERSION_FIELDS} from ${VERSION_JOINS} where v.page_id = $1 order by v.created_at desc limit $2`,
      [page.id, Math.min(500, Math.max(1, Math.trunc(limit)))],
    );
    return result.rows.map(mapVersion);
  });
}

export async function getVersion(actor: Actor, versionId: string): Promise<DocVersionDetail> {
  assertDocsRead(actor);
  if (!isUuid(versionId)) throw new CrmError("not_found", "That version doesn't exist.", 404);
  return withActor(actor, async (db) => {
    const result = await db.query<VersionRow & { content: string }>(
      `select ${VERSION_FIELDS}, v.content from ${VERSION_JOINS} where v.id = $1 and v.workspace_id = $2`,
      [versionId, actor.workspaceId],
    );
    const row = result.rows[0];
    if (!row) throw new CrmError("not_found", "That version doesn't exist.", 404);
    return { ...mapVersion(row), content: row.content };
  });
}

export async function restoreVersion(actor: Actor, pageId: string, versionId: string, provenance?: Provenance) {
  assertDocsWrite(actor);
  if (!isUuid(versionId)) throw new CrmError("not_found", "That version doesn't exist.", 404);
  return withActor(actor, async (db) => {
    const page = await loadPage(db, actor, pageId, { lock: true });
    if (page.archived_at) throw new CrmError("invalid_input", "This doc is archived. Restore it before restoring a version.", 400);
    const version = await db.query<{ title: string; content: string; created_at: Date }>(
      "select title, content, created_at from crm.page_versions where id = $1 and page_id = $2",
      [versionId, page.id],
    );
    const chosen = version.rows[0];
    if (!chosen) throw new CrmError("not_found", "That version isn't one of this doc's versions.", 404);
    const title = page.kind === "daily" ? page.title : chosen.title;
    const summary = `Restored the version from ${new Date(chosen.created_at).toLocaleString("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;
    if (title !== page.title) {
      await renameInside(db, actor, page, title, stampFor(actor, provenance), provenance);
      const renamed = await loadPage(db, actor, pageId, { lock: true });
      await commitPage(db, actor, renamed, { title, content: chosen.content }, { stamp: stampFor(actor, provenance), provenance, reason: "restored", summary });
    } else {
      await commitPage(db, actor, page, { title, content: chosen.content }, { stamp: stampFor(actor, provenance), provenance, reason: "restored", summary });
    }
    return docDetail(db, actor, pageId);
  });
}
