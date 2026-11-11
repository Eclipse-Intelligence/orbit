import { randomBytes } from "node:crypto";
import { CHAT_BODY_MAX, CHAT_CLIENT_KEY_MAX, CHAT_HOOK_NAME_MAX, type ChatHook, type ChatHookSecret, type ChatMessage } from "@/lib/chat/types";
import { broadcastChat, chatBackground, hookCard } from "@/lib/crm/chat";
import { withActor } from "@/lib/crm/context";
import { CrmError, notFound } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import { hashToken } from "@/lib/crm/tokens";
import type { UserActor } from "@/lib/crm/types";
import { query, type Db } from "@/lib/db/pool";

export const HOOK_BODY_MAX_BYTES = 32 * 1024;
export const HOOK_POSTS_PER_MINUTE = 30;
export const HOOK_TITLE_MAX = 200;
export const HOOK_URL_MAX = 2000;
export const HOOK_BLOCK_MAX = 8000;
export const HOOK_DEPTH_MAX = 20;

type Stamp = Date | string;

type HookRow = { id: string; name: string; created_by: string | null; paused_at: Stamp | null; last_used_at: Stamp | null; created_at: Stamp };

type PostRow = {
  status: "ok" | "not_found" | "unauthorised" | "paused" | "rate_limited";
  message_id: string | null;
  conversation_id: string | null;
  author_name: string | null;
  body: string | null;
  hook: { title?: unknown; url?: unknown; block?: unknown } | null;
  created_at: Stamp | null;
  duplicate: boolean;
  member_ids: string[] | null;
};

export type HookPayload = { text: string; title: string | null; url: string | null; block: boolean };

export type HookPostResult = { id: string; conversationId: string; duplicate: boolean };

const HOOK_COLUMNS = "id, name, created_by, paused_at, last_used_at, created_at";
const NUL = /\u0000/g;
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F­؜᠎​-‏‪-‮⁠-⁤⁦-⁯﻿]/g;
const BEARER = /^Bearer\s+(\S+)\s*$/i;

function iso(value: Stamp | null) {
  return value === null ? null : new Date(value).toISOString();
}

function toHook(row: HookRow): ChatHook {
  return {
    id: row.id,
    name: row.name,
    createdBy: row.created_by,
    pausedAt: iso(row.paused_at),
    lastUsedAt: iso(row.last_used_at),
    createdAt: iso(row.created_at)!,
  };
}

function checkId(id: unknown, noun: string): string {
  if (typeof id !== "string" || !isUuid(id)) throw notFound(noun);
  return id.toLowerCase();
}

function cleanHookName(name: unknown) {
  const text = typeof name === "string" ? name.replace(CONTROLS, "").replace(/\s+/g, " ").trim() : "";
  if (!/[\p{L}\p{N}]/u.test(text)) throw new CrmError("invalid_input", "Give the webhook a name.", 400, { field: "name" });
  if (text.length > CHAT_HOOK_NAME_MAX) throw new CrmError("invalid_input", "Keep the name to 80 characters.", 400, { field: "name" });
  return text;
}

export function newHookSecret() {
  const secret = `ohk_${randomBytes(24).toString("base64url")}`;
  return { secret, hash: hashToken(secret) };
}

async function requireRoom(db: Db, roomId: string) {
  const room = await db.query("select 1 from crm.chat_conversations where id = $1 and kind = 'room' and archived_at is null", [roomId]);
  if ((room.rowCount ?? 0) === 0) throw notFound("room");
}

export async function listHooks(actor: UserActor, roomId: string): Promise<ChatHook[]> {
  const id = checkId(roomId, "room");
  return withActor(actor, async (db) => {
    await requireRoom(db, id);
    const result = await db.query<HookRow>(`select ${HOOK_COLUMNS} from crm.chat_hooks where conversation_id = $1 order by created_at, id`, [id]);
    return result.rows.map(toHook);
  });
}

export async function createHook(actor: UserActor, roomId: string, name: unknown): Promise<ChatHookSecret> {
  const id = checkId(roomId, "room");
  const clean = cleanHookName(name);
  const { secret, hash } = newHookSecret();
  return withActor(actor, async (db) => {
    await requireRoom(db, id);
    const result = await db.query<HookRow>(
      `insert into crm.chat_hooks (conversation_id, name, secret_hash, created_by) values ($1, $2, $3, $4) returning ${HOOK_COLUMNS}`,
      [id, clean, hash, actor.userId],
    );
    return { hook: toHook(result.rows[0]), secret };
  });
}

async function changeHook(actor: UserActor, hookId: string, assignments: string, values: unknown[]) {
  const id = checkId(hookId, "webhook");
  return withActor(actor, async (db) => {
    const result = await db.query<HookRow>(`update crm.chat_hooks set ${assignments} where id = $1 returning ${HOOK_COLUMNS}`, [id, ...values]);
    if (!result.rows[0]) throw notFound("webhook");
    return toHook(result.rows[0]);
  });
}

export async function setHookPaused(actor: UserActor, hookId: string, paused: boolean): Promise<ChatHook> {
  return changeHook(actor, hookId, paused ? "paused_at = coalesce(paused_at, now())" : "paused_at = null", []);
}

export async function rotateHookSecret(actor: UserActor, hookId: string): Promise<ChatHookSecret> {
  const { secret, hash } = newHookSecret();
  const hook = await changeHook(actor, hookId, "secret_hash = $2", [hash]);
  return { hook, secret };
}

export async function deleteHook(actor: UserActor, hookId: string): Promise<{ deleted: true }> {
  const id = checkId(hookId, "webhook");
  return withActor(actor, async (db) => {
    const result = await db.query("delete from crm.chat_hooks where id = $1 returning id", [id]);
    if ((result.rowCount ?? 0) === 0) throw notFound("webhook");
    return { deleted: true as const };
  });
}

function cleanText(value: string) {
  return value.replace(NUL, "").replace(/\r\n?/g, "\n").trim();
}

function optionalString(value: unknown, field: string) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new CrmError("invalid_input", `${field} must be a string.`, 400, { field });
  return value;
}

function cleanUrl(value: unknown) {
  const raw = optionalString(value, "url");
  const text = raw?.trim() ?? "";
  if (!text) return null;
  let parsed: URL | null = null;
  try {
    parsed = new URL(text);
  } catch {}
  const normal = parsed?.toString() ?? "";
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password || normal.length > HOOK_URL_MAX) {
    throw new CrmError("invalid_input", "url must be an http or https link up to 2,000 characters, without a username or password.", 400, { field: "url" });
  }
  return normal;
}

function tooDeep(value: unknown) {
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length > 0) {
    const [item, depth] = stack.pop()!;
    if (!item || typeof item !== "object") continue;
    if (depth > HOOK_DEPTH_MAX) return true;
    for (const child of Object.values(item)) stack.push([child, depth + 1]);
  }
  return false;
}

function block(value: unknown) {
  const pretty = cleanText(JSON.stringify(value, null, 2) ?? "");
  const points = Array.from(pretty);
  return points.length > HOOK_BLOCK_MAX ? `${points.slice(0, HOOK_BLOCK_MAX).join("")}\n…` : pretty;
}

const NOT_JSON = "Send a JSON body, for example {\"text\": \"Hello\"}.";

export function parseHookBody(raw: string): HookPayload {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CrmError("invalid_input", NOT_JSON, 400);
  }
  if (tooDeep(value)) throw new CrmError("invalid_input", `Keep JSON nesting to ${HOOK_DEPTH_MAX} levels.`, 400);
  if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as { text?: unknown }).text === "string") {
    const input = value as { text: string; title?: unknown; url?: unknown };
    const text = cleanText(input.text);
    if (!text) throw new CrmError("invalid_input", "text is empty.", 400, { field: "text" });
    if (text.length > CHAT_BODY_MAX) throw new CrmError("invalid_input", "Keep text to 10,000 characters.", 400, { field: "text" });
    const title = (optionalString(input.title, "title") ?? "").replace(CONTROLS, " ").replace(/\s+/g, " ").trim();
    if (title.length > HOOK_TITLE_MAX) throw new CrmError("invalid_input", "Keep title to 200 characters.", 400, { field: "title" });
    return { text, title: title || null, url: cleanUrl(input.url), block: false };
  }
  let text: string;
  try {
    text = block(value);
  } catch {
    throw new CrmError("invalid_input", NOT_JSON, 400);
  }
  if (!text) throw new CrmError("invalid_input", NOT_JSON, 400);
  return { text, title: null, url: null, block: true };
}

export function bearerSecret(header: string | null) {
  const match = header ? BEARER.exec(header) : null;
  return match ? match[1] : null;
}

function idempotencyKey(header: string | null) {
  const key = header?.replace(NUL, "").trim() ?? "";
  if (!key) return null;
  return key.length > CHAT_CLIENT_KEY_MAX ? hashToken(key) : key;
}

const REFUSALS = {
  not_found: () => new CrmError("not_found", "This webhook doesn't exist or was deleted.", 404),
  unauthorised: () => new CrmError("unauthorized", "Send this webhook's secret as Authorization: Bearer <secret>.", 401),
  paused: () => new CrmError("conflict", "This webhook is paused. Resume it in the room's settings.", 409),
  rate_limited: () => new CrmError("rate_limited", `This webhook can post ${HOOK_POSTS_PER_MINUTE} messages a minute. Try again shortly.`, 429),
};

export async function postViaHook(
  input: { hookId: string; authorization: string | null; idempotencyKey?: string | null; body: string },
  options: { perMinute?: number; windowSeconds?: number } = {},
): Promise<HookPostResult> {
  if (!isUuid(input.hookId)) throw REFUSALS.not_found();
  const secret = bearerSecret(input.authorization);
  const hash = secret ? hashToken(secret) : null;
  const auth = await query<{ status: PostRow["status"] }>("select private.chat_hook_auth($1, $2) as status", [input.hookId.toLowerCase(), hash]);
  const status = auth.rows[0]?.status ?? "not_found";
  if (status !== "ok") throw REFUSALS[status]();
  const payload = parseHookBody(input.body);
  const result = await query<PostRow>(
    "select status, message_id, conversation_id, author_name, body, hook, created_at, duplicate, member_ids::text[] as member_ids from private.chat_hook_post($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    [
      input.hookId.toLowerCase(),
      hash,
      payload.title,
      payload.text,
      payload.url,
      payload.block,
      idempotencyKey(input.idempotencyKey ?? null),
      options.perMinute ?? HOOK_POSTS_PER_MINUTE,
      options.windowSeconds ?? 60,
    ],
  );
  const row = result.rows[0];
  if (!row) throw REFUSALS.not_found();
  if (row.status !== "ok") throw REFUSALS[row.status]();
  const conversationId = row.conversation_id!;
  if (!row.duplicate) {
    const message: ChatMessage = {
      id: row.message_id!,
      conversationId,
      parentId: null,
      author: { id: null, name: row.author_name ?? "" },
      clientKey: null,
      body: row.body ?? "",
      mentions: [],
      replyCount: 0,
      lastReplyAt: null,
      replyAuthors: [],
      editedAt: null,
      deletedAt: null,
      createdAt: iso(row.created_at)!,
      hook: hookCard(row.hook),
    };
    const members = row.member_ids ?? [];
    chatBackground(() => broadcastChat(members, { type: "message", conversationId, message, root: null }));
  }
  return { id: row.message_id!, conversationId, duplicate: row.duplicate };
}
