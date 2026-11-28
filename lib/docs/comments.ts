import { withActor } from "@/lib/crm/context";
import { CrmError, isPgError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import type { Actor, Provenance } from "@/lib/crm/types";
import { anchorBudget, resolveAnchor, type CommentAnchor } from "@/lib/docs/comment-anchor";
import { renderedText } from "@/lib/docs/editor/source-map";
import { anchorSchema, COMMENT_BODY_LIMIT, COMMENT_NAME_LIMIT } from "@/lib/docs/public-comments";
import { assertDocsRead, assertDocsWrite, auditDoc, loadPage } from "@/lib/docs/store";
import type { Db } from "@/lib/db/pool";

export type DocCommentAuthorKind = "visitor" | "person" | "agent";

export type DocComment = {
  id: string;
  parentId: string | null;
  authorName: string;
  authorKind: DocCommentAuthorKind;
  authorUserId: string | null;
  body: string;
  anchor: CommentAnchor | null;
  createdAt: string;
  editedAt: string | null;
  resolved: boolean;
};

type DocCommentThread = { root: DocComment; replies: DocComment[]; orphaned: boolean };

type CommentRow = {
  id: string;
  parent_id: string | null;
  author_name: string;
  author_user_id: string | null;
  author_agent_id: string | null;
  body: string;
  anchor: unknown;
  resolved_at: Date | null;
  root_resolved_at: Date | null;
  created_at: Date;
  edited_at: Date | null;
};

const COLUMNS = `c.id, c.parent_id, c.author_name, c.author_user_id, c.author_agent_id, c.body, c.anchor, c.resolved_at, r.resolved_at as root_resolved_at, c.created_at, c.edited_at`;

const NOT_THERE = "That comment is no longer there.";

function mapComment(row: CommentRow): DocComment {
  const parsed = anchorSchema.safeParse(row.anchor);
  return {
    id: row.id,
    parentId: row.parent_id,
    authorName: row.author_name,
    authorKind: row.author_user_id ? "person" : row.author_agent_id ? "agent" : "visitor",
    authorUserId: row.author_user_id,
    body: row.body,
    anchor: parsed.success ? parsed.data : null,
    createdAt: row.created_at.toISOString(),
    editedAt: row.edited_at ? row.edited_at.toISOString() : null,
    resolved: (row.parent_id ? row.root_resolved_at : row.resolved_at) !== null,
  };
}

function threadsOf(comments: DocComment[], text: string | null = null): DocCommentThread[] {
  const budget = anchorBudget();
  const replies = new Map<string, DocComment[]>();
  for (const comment of comments) {
    if (comment.parentId === null) continue;
    const list = replies.get(comment.parentId);
    if (list) list.push(comment);
    else replies.set(comment.parentId, [comment]);
  }
  const roots = comments.filter((comment) => comment.parentId === null);
  const orphaned = new Set<string>();
  if (text !== null) {
    const order = roots.map((_, index) => index).sort((left, right) => Number(roots[left].resolved) - Number(roots[right].resolved) || left - right);
    for (const index of order) {
      const root = roots[index];
      if (root.anchor !== null && resolveAnchor(text, root.anchor, { budget, fuzzy: !root.resolved }).status === "orphaned") orphaned.add(root.id);
    }
  }
  return roots.map((root) => ({ root, replies: replies.get(root.id) ?? [], orphaned: orphaned.has(root.id) }));
}

export function authorNameOf(actor: Actor) {
  const raw = actor.type === "agent" ? actor.agentName : actor.fullName?.trim() || actor.email.split("@")[0];
  const name = Array.from(raw.replace(/\s+/g, " ").trim() || "Someone")
    .slice(0, COMMENT_NAME_LIMIT)
    .join("")
    .trim();
  return name || "Someone";
}

function checkBody(value: unknown) {
  const body = typeof value === "string" ? value.trim() : "";
  if (body.length === 0) throw new CrmError("invalid_input", "Write a comment.", 400, { field: "body" });
  if (body.length > COMMENT_BODY_LIMIT) throw new CrmError("invalid_input", `A comment is ${COMMENT_BODY_LIMIT} characters at most.`, 400, { field: "body" });
  return body;
}

async function guarded<T>(failure: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isPgError(error) && (error.code === "42501" || error.code === "23514")) throw new CrmError("forbidden", failure, 403);
    throw error;
  }
}

async function openPage(db: Db, actor: Actor, pageId: string) {
  const page = await loadPage(db, actor, pageId);
  if (page.kind !== "note") throw new CrmError("invalid_input", "Daily notes can't have comments.", 400);
  return page;
}

async function loadComment(db: Db, pageId: string, commentId: string, lock = false) {
  if (!isUuid(commentId)) throw new CrmError("not_found", NOT_THERE, 404);
  const result = await db.query<CommentRow>(
    `select ${COLUMNS} from crm.page_comments c left join crm.page_comments r on r.id = c.parent_id
     where c.id = $1 and c.page_id = $2 and c.deleted_at is null and (c.parent_id is null or r.deleted_at is null)${lock ? " for no key update of c" : ""}`,
    [commentId, pageId],
  );
  const row = result.rows[0];
  if (!row) throw new CrmError("not_found", NOT_THERE, 404);
  return row;
}

export async function listDocComments(actor: Actor, pageId: string): Promise<{ comments: DocComment[]; allowComments: boolean; text: string }> {
  assertDocsRead(actor);
  return withActor(actor, async (db) => {
    const page = await loadPage(db, actor, pageId);
    if (page.kind !== "note") return { comments: [], allowComments: false, text: "" };
    const result = await db.query<CommentRow>(
      `select ${COLUMNS} from crm.page_comments c left join crm.page_comments r on r.id = c.parent_id
       where c.page_id = $1 and c.deleted_at is null and (c.parent_id is null or r.deleted_at is null)
       order by c.created_at, c.id`,
      [page.id],
    );
    return { comments: result.rows.map(mapComment), allowComments: page.allow_comments, text: renderedText(page.content) };
  });
}

export async function replyToDocComment(actor: Actor, pageId: string, commentId: string, input: { body: string }, provenance?: Provenance): Promise<DocComment> {
  assertDocsWrite(actor);
  const body = checkBody(input.body);
  return guarded("Couldn't reply. Try again.", () => withActor(actor, async (db) => {
    const page = await openPage(db, actor, pageId);
    const target = await loadComment(db, page.id, commentId);
    const rootId = target.parent_id ?? target.id;
    const inserted = await db.query<{ id: string }>(
      `insert into crm.page_comments (workspace_id, page_id, parent_id, author_name, author_user_id, author_agent_id, body)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [page.workspace_id, page.id, rootId, authorNameOf(actor), actor.type === "user" ? actor.userId : null, actor.type === "agent" ? actor.agentId : null, body],
    );
    const made = await loadComment(db, page.id, inserted.rows[0].id);
    await auditDoc(db, actor, "page.comment_replied", page, provenance, { commentId: made.id, parentId: rootId });
    return mapComment(made);
  }));
}

export async function setDocCommentResolved(actor: Actor, pageId: string, commentId: string, resolved: boolean, provenance?: Provenance): Promise<DocComment> {
  assertDocsWrite(actor);
  return guarded(resolved ? "Couldn't resolve the comment. Try again." : "Couldn't reopen the comment. Try again.", () => withActor(actor, async (db) => {
    const page = await openPage(db, actor, pageId);
    const target = await loadComment(db, page.id, commentId, true);
    const rootId = target.parent_id ?? target.id;
    const root = target.parent_id ? await loadComment(db, page.id, rootId, true) : target;
    if ((root.resolved_at !== null) === resolved) return mapComment(root);
    await db.query("update crm.page_comments set resolved_at = $2, resolved_by = $3 where id = $1", [rootId, resolved ? new Date() : null, resolved && actor.type === "user" ? actor.userId : null]);
    await auditDoc(db, actor, resolved ? "page.comment_resolved" : "page.comment_reopened", page, provenance, { commentId: rootId });
    return mapComment(await loadComment(db, page.id, rootId));
  }));
}

export async function deleteDocComment(actor: Actor, pageId: string, commentId: string, provenance?: Provenance): Promise<{ id: string; deleted: true }> {
  assertDocsWrite(actor);
  return guarded("Couldn't delete the comment. Try again.", () => withActor(actor, async (db) => {
    const page = await openPage(db, actor, pageId);
    const target = await loadComment(db, page.id, commentId, true);
    await db.query("update crm.page_comments set deleted_at = now() where id = $1", [target.id]);
    await auditDoc(db, actor, "page.comment_deleted", page, provenance, { commentId: target.id, parentId: target.parent_id });
    return { id: target.id, deleted: true };
  }));
}

export type DocCommentView = {
  id: string;
  quote: string | null;
  status: "open" | "resolved";
  orphaned: boolean;
  author: { name: string; kind: DocCommentAuthorKind };
  body: string;
  createdAt: string;
  replies: { id: string; author: { name: string; kind: DocCommentAuthorKind }; body: string; createdAt: string }[];
};

export function commentViews(comments: DocComment[], text: string): DocCommentView[] {
  return threadsOf(comments, text).map((thread) => ({
    id: thread.root.id,
    quote: thread.root.anchor?.quote ?? null,
    status: thread.root.resolved ? "resolved" : "open",
    orphaned: thread.orphaned,
    author: { name: thread.root.authorName, kind: thread.root.authorKind },
    body: thread.root.body,
    createdAt: thread.root.createdAt,
    replies: thread.replies.map((reply) => ({ id: reply.id, author: { name: reply.authorName, kind: reply.authorKind }, body: reply.body, createdAt: reply.createdAt })),
  }));
}

export async function readDocComments(actor: Actor, pageId: string) {
  const { comments, allowComments, text } = await listDocComments(actor, pageId);
  return { allowComments, comments: commentViews(comments, text) };
}
