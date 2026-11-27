import { createHash } from "node:crypto";
import { z } from "zod";
import { clientIp } from "@/lib/booking/book";
import { CrmError, isPgError } from "@/lib/crm/errors";
import { query } from "@/lib/db/pool";
import { ANCHOR_CONTEXT, ANCHOR_QUOTE_LIMIT } from "@/lib/docs/comment-anchor";

export const COMMENT_POSTS_PER_MINUTE_PER_IP = 10;
export const COMMENT_POSTS_PER_DAY_PER_PAGE = 200;
export const COMMENT_READS_PER_MINUTE_PER_IP = 120;
export const COMMENT_NAME_LIMIT = 60;
export const COMMENT_BODY_LIMIT = 2000;

const LINK_SHAPE = /^[A-Za-z0-9_-]{3,64}$/;
const KEY_SHAPE = /^[A-Za-z0-9_-]{22,64}$/;
const MINUTE = 60;
const DAY = 86_400;
const INVALID_INPUT = "22023";

export type PublicComment = {
  id: string;
  parentId: string | null;
  authorName: string;
  body: string;
  anchor: { quote: string; prefix: string; suffix: string; at: number } | null;
  createdAt: string;
  editedAt: string | null;
  resolved: boolean;
  mine: boolean;
};

type CommentRow = {
  id: string;
  parent_id: string | null;
  author_name: string;
  body: string;
  anchor: unknown;
  created_at: Date;
  edited_at: Date | null;
  resolved: boolean;
  mine: boolean;
};

const anchorSchema = z.object({
  quote: z.string().min(1).max(ANCHOR_QUOTE_LIMIT),
  prefix: z.string().max(ANCHOR_CONTEXT),
  suffix: z.string().max(ANCHOR_CONTEXT),
  at: z.number().int().min(0).max(10_000_000),
});

const nameSchema = z.string().trim().min(1, "Add your name.").max(COMMENT_NAME_LIMIT, `Use a name of ${COMMENT_NAME_LIMIT} characters or fewer.`);
const bodySchema = z.string().trim().min(1, "Write a comment.").max(COMMENT_BODY_LIMIT, `A comment is ${COMMENT_BODY_LIMIT} characters at most.`);

export const addCommentSchema = z.object({
  name: nameSchema,
  body: bodySchema,
  parentId: z.uuid().nullish(),
  anchor: anchorSchema.nullish(),
});

export const editCommentSchema = z.object({ body: bodySchema });

export function visitorKeyOf(value: string | null | undefined) {
  return value && KEY_SHAPE.test(value) ? value : null;
}

export function hashVisitorKey(key: string) {
  return createHash("sha256").update(key).digest("hex");
}

export function hashClient(headers: Headers) {
  return createHash("sha256").update(clientIp(headers)).digest("hex").slice(0, 32);
}

function mapRow(row: CommentRow): PublicComment {
  const parsed = anchorSchema.safeParse(row.anchor);
  return {
    id: row.id,
    parentId: row.parent_id,
    authorName: row.author_name,
    body: row.body,
    anchor: parsed.success ? parsed.data : null,
    createdAt: row.created_at.toISOString(),
    editedAt: row.edited_at ? row.edited_at.toISOString() : null,
    resolved: row.resolved,
    mine: row.mine,
  };
}

export function isLinkValue(value: string) {
  return LINK_SHAPE.test(value);
}

async function allow(key: string, limit: number, seconds: number) {
  const result = await query<{ allowed: boolean }>("select private.consume_rate_limit($1, $2, $3) as allowed", [key, limit, seconds]);
  return result.rows[0]?.allowed !== false;
}

export async function commentsPageId(value: string) {
  if (!isLinkValue(value)) return null;
  const result = await query<{ page_id: string }>("select page_id from private.public_comment_page($1)", [value]);
  return result.rows[0]?.page_id ?? null;
}

export async function listPublicComments(value: string, key: string | null, client: string): Promise<PublicComment[] | null> {
  if (!isLinkValue(value)) return null;
  if (!(await allow(`doc-comments-read:${client}`, COMMENT_READS_PER_MINUTE_PER_IP, MINUTE))) throw new CrmError("rate_limited", "Too many requests. Wait a minute and try again.", 429);
  const result = await query<CommentRow>("select * from private.public_comments_list($1, $2)", [value, key ? hashVisitorKey(key) : null]);
  if (result.rows.length === 0 && !(await commentsPageId(value))) return null;
  return result.rows.map(mapRow);
}

async function chargePost(value: string, client: string) {
  const pageId = await commentsPageId(value);
  if (!pageId) return false;
  if (!(await allow(`doc-comments-ip:${client}`, COMMENT_POSTS_PER_MINUTE_PER_IP, MINUTE))) throw new CrmError("rate_limited", "Too many comments. Wait a minute and try again.", 429);
  if (!(await allow(`doc-comments-page:${pageId}`, COMMENT_POSTS_PER_DAY_PER_PAGE, DAY))) throw new CrmError("rate_limited", "This doc has had too many comments today. Try again tomorrow.", 429);
  return true;
}

function refused(error: unknown): never {
  if (isPgError(error) && error.code === INVALID_INPUT) throw new CrmError("invalid_input", error.message, 400);
  throw error;
}

export async function addPublicComment(
  value: string,
  key: string,
  client: string,
  input: z.infer<typeof addCommentSchema>,
): Promise<PublicComment | null> {
  if (!isLinkValue(value) || !(await chargePost(value, client))) return null;
  try {
    const result = await query<CommentRow>("select * from private.public_comment_add($1, $2, $3, $4, $5, $6)", [
      value,
      hashVisitorKey(key),
      input.name,
      input.body,
      input.parentId ?? null,
      input.anchor ? JSON.stringify(input.anchor) : null,
    ]);
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  } catch (error) {
    return refused(error);
  }
}

export async function editPublicComment(value: string, key: string, client: string, id: string, body: string): Promise<PublicComment | null> {
  if (!isLinkValue(value) || !(await chargePost(value, client))) return null;
  try {
    const result = await query<CommentRow>("select * from private.public_comment_edit($1, $2, $3, $4)", [value, hashVisitorKey(key), id, body]);
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  } catch (error) {
    return refused(error);
  }
}

export async function deletePublicComment(value: string, key: string, client: string, id: string): Promise<boolean> {
  if (!isLinkValue(value) || !(await chargePost(value, client))) return false;
  const result = await query<{ deleted: boolean }>("select private.public_comment_delete($1, $2, $3) as deleted", [value, hashVisitorKey(key), id]);
  return result.rows[0]?.deleted === true;
}
