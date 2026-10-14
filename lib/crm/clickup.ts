import { after } from "next/server";
import type { Db } from "@/lib/db/pool";
import { query } from "@/lib/db/pool";
import {
  claimIntegration,
  clip,
  configuredSiteOrigin,
  ensureIntegration,
  errorText,
  finishIntegration,
  internalAddresses,
  memberActor,
  timeLeft,
  type IntegrationKey,
} from "@/lib/crm/conversations";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { contactHref, companyHref } from "@/lib/crm/hrefs";
import { iso, isUuid } from "@/lib/crm/mutate";
import { canonicalDomain, canonicalEmail } from "@/lib/crm/normalize";
import { assertScope } from "@/lib/crm/scopes";
import { archiveTask, createTask, createTaskInDb, updateTaskInDb } from "@/lib/crm/tasks";
import type { Provenance, Task, TaskWrite, UserActor, WorkspaceRole } from "@/lib/crm/types";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secret";
import {
  CLICKUP_EVENTS,
  ClickUpError,
  clickupClient,
  clickupToken,
  isClickUpId,
  verifyClickUpSignature,
  type ClickUpClient,
  type ClickUpField,
  type ClickUpListChoice,
  type ClickUpListInfo,
  type ClickUpTask,
  type ClickUpTaskWrite,
  type ClickUpTeam,
} from "@/lib/clickup";
import { appTimeZone, zonedParts, zonedTimeToDate } from "@/lib/time";

const SYNC_GAP_MS = 5 * 60 * 1000;
const OVERLAP_MS = 5 * 60 * 1000;
const LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_POLL_PAGES = 20;
const MAX_POLL_LISTS = 100;
const PUSH_BATCH = 20;
const VERIFY_BATCH = 5;
const VERIFY_AFTER_MS = 6 * 60 * 60 * 1000;
const CREATE_CLAIM_MS = 2 * 60 * 1000;
const STEP_RESERVE_MS = 3_000;
const INLINE_BUDGET_MS = 10_000;
const WEBHOOK_BUDGET_MS = 50_000;
export const ECHO_WINDOW_MS = 15_000;
const RECEIPT_TTL_SECONDS = 24 * 60 * 60;
const MAX_WEBHOOK_BYTES = 256 * 1024;
const MAX_HISTORY_ITEMS = 50;
const LINK_FIELD_NAMES = ["orbit", "crm"];
const LINK_FIELD_TYPES = ["short_text", "text", "url", "email"];

export const CLICKUP_NOT_CONFIGURED =
  "Set CLICKUP_API_TOKEN to sync next actions with ClickUp.";
const CLICKUP_NOT_SET_UP = "Choose a ClickUp workspace and lists in Settings first.";

export type ClickUpSyncResult = {
  ran: boolean;
  fetched: number;
  imported: number;
  updated: number;
  pushed: number;
  archived: number;
  failed: number;
  complete: boolean;
  error?: string;
};

export type ClickUpPicker = { lists: ClickUpListChoice[]; listId: string };

export type ClickUpSettingsView = {
  configured: boolean;
  error: string | null;
  user: { username: string | null; email: string | null } | null;
  teams: ClickUpTeam[];
  teamId: string | null;
  lists: ClickUpListChoice[];
  defaultListId: string | null;
  watchedListIds: string[];
  webhookEnabled: boolean;
  siteUrl: string | null;
  lastSyncedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
};

export type ClickUpOptions = {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  deadline?: number;
  origin?: string | null;
};

type Fields = { title: string; dueAt: string | null; done: boolean };

type Snapshot = {
  title?: string;
  dueAt?: string | null;
  done?: boolean;
  remoteUpdatedAt?: number;
  pushedAt?: number;
  creatingAt?: number;
};

type StateRow = {
  user_id: string | null;
  team_id: string | null;
  external_user_id: string | null;
  default_list_id: string | null;
  watched_list_ids: string[] | null;
  last_used_list_id: string | null;
  list_choices: unknown;
  webhook_id: string | null;
  webhook_secret: string | null;
  webhook_scope: string | null;
  last_synced_at: Date | string | null;
  last_attempt_at: Date | string | null;
  last_error: string | null;
};

type ClickUpState = {
  userId: string | null;
  teamId: string | null;
  externalUserId: string | null;
  defaultListId: string | null;
  watchedListIds: string[];
  lastUsedListId: string | null;
  lists: ClickUpListChoice[];
  webhookId: string | null;
  webhookSecret: string | null;
  webhookScope: string | null;
  lastSyncedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
};

type SyncRow = {
  id: string;
  title: string;
  description: string | null;
  due_at: Date | string | null;
  completed_at: Date | string | null;
  archived_at: Date | string | null;
  updated_at: Date | string;
  contact_id: string | null;
  company_id: string | null;
  contact_name: string | null;
  contact_email: string | null;
  company_name: string | null;
  clickup_task_id: string | null;
  clickup_list_id: string | null;
  clickup_url: string | null;
  clickup_sync: Snapshot | null;
};

type Session = {
  api: ClickUpClient;
  state: ClickUpState;
  actor: UserActor;
  origin: string | null;
  deadline?: number;
  lists: Map<string, Promise<ClickUpListInfo>>;
  fields: Map<string, Promise<ClickUpField[]>>;
};

type Schedule = (task: () => Promise<unknown>) => void;

export type ClickUpEvent = {
  event: string;
  taskId: string;
  newestAt: number | null;
};

const SYNC_COLUMNS = `
  t.id, t.title, t.description, t.due_at, t.completed_at, t.archived_at, t.updated_at,
  t.contact_id, t.company_id,
  coalesce(nullif(trim(concat_ws(' ', ct.first_name, ct.last_name)), ''), ct.email, ct.phone) as contact_name,
  ct.email as contact_email,
  co.name as company_name,
  t.clickup_task_id, t.clickup_list_id, t.clickup_url, t.clickup_sync
`;

const SYNC_FROM = `
  from crm.tasks t
  left join crm.contacts ct on ct.id = t.contact_id
  left join crm.companies co on co.id = t.company_id
`;

const DIRTY_SQL = `(
  t.title is distinct from t.clickup_sync->>'title'
  or t.due_at is distinct from (t.clickup_sync->>'dueAt')::timestamptz
  or (t.completed_at is not null) is distinct from (t.clickup_sync->>'done')::boolean
)`;

const PROVENANCE: Provenance = { operation: "sync_clickup", source: "clickup" };

function client(token: string, options: ClickUpOptions) {
  return clickupClient({
    token,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    deadline: options.deadline,
  });
}

function clickupKey(actor: UserActor): IntegrationKey {
  return { workspaceId: actor.workspaceId, source: "clickup", userId: actor.userId };
}

function idle(): ClickUpSyncResult {
  return { ran: false, fetched: 0, imported: 0, updated: 0, pushed: 0, archived: 0, failed: 0, complete: false };
}

function mapChoices(value: unknown): ClickUpListChoice[] {
  if (!Array.isArray(value)) return [];
  const lists: ClickUpListChoice[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.name !== "string") continue;
    lists.push({
      id: item.id,
      name: item.name,
      spaceId: typeof item.spaceId === "string" ? item.spaceId : "",
      spaceName: typeof item.spaceName === "string" ? item.spaceName : "",
      folderId: typeof item.folderId === "string" ? item.folderId : null,
      folderName: typeof item.folderName === "string" ? item.folderName : null,
    });
  }
  return lists;
}

async function readState(db: Db, workspaceId: string): Promise<ClickUpState | null> {
  const result = await db.query<StateRow>(
    `select user_id, team_id, external_user_id, default_list_id, watched_list_ids, last_used_list_id,
            list_choices, webhook_id, webhook_secret, webhook_scope, last_synced_at, last_attempt_at, last_error
     from crm.integration_state
     where workspace_id = $1 and source = 'clickup' and connection_id is null`,
    [workspaceId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    userId: row.user_id,
    teamId: row.team_id,
    externalUserId: row.external_user_id,
    defaultListId: row.default_list_id,
    watchedListIds: row.watched_list_ids ?? [],
    lastUsedListId: row.last_used_list_id,
    lists: mapChoices(row.list_choices),
    webhookId: row.webhook_id,
    webhookSecret: row.webhook_secret,
    webhookScope: row.webhook_scope,
    lastSyncedAt: iso(row.last_synced_at),
    lastAttemptAt: iso(row.last_attempt_at),
    lastError: row.last_error,
  };
}

export async function getClickUpState(actor: UserActor) {
  return withActor(actor, (db) => readState(db, actor.workspaceId));
}

function session(api: ClickUpClient, state: ClickUpState, actor: UserActor, options: ClickUpOptions): Session {
  return {
    api,
    state,
    actor,
    origin: configuredSiteOrigin() ?? options.origin ?? null,
    deadline: options.deadline,
    lists: new Map(),
    fields: new Map(),
  };
}

function cached<T>(map: Map<string, Promise<T>>, key: string, load: () => Promise<T>) {
  let value = map.get(key);
  if (!value) {
    value = load();
    map.set(key, value);
    value.catch(() => map.delete(key));
  }
  return value;
}

export function isDoneStatus(type: string | null | undefined) {
  return type === "done" || type === "closed";
}

export function statusFor(list: ClickUpListInfo, done: boolean) {
  const ordered = [...list.statuses].sort((a, b) => a.orderindex - b.orderindex);
  if (done) return ordered.find((status) => isDoneStatus(status.type))?.status ?? null;
  return (
    ordered.find((status) => status.type === "open")?.status ??
    ordered.find((status) => !isDoneStatus(status.type))?.status ??
    null
  );
}

export function toClickUpDue(dueAt: string | null, timeZone = appTimeZone()) {
  if (!dueAt) return { due_date: null, due_date_time: false };
  const date = new Date(dueAt);
  const parts = zonedParts(date, timeZone);
  const dateOnly = parts.hour === 0 && parts.minute === 0 && parts.second === 0;
  return { due_date: date.getTime(), due_date_time: !dateOnly };
}

export function fromClickUpDue(task: Pick<ClickUpTask, "due_date" | "due_date_time">, timeZone = appTimeZone()) {
  if (task.due_date === null || task.due_date === undefined || task.due_date === "") return null;
  const ms = Number(task.due_date);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  const parts = zonedParts(date, timeZone);
  const dateOnly =
    task.due_date_time === false ||
    (task.due_date_time !== true && parts.minute === 0 && parts.second === 0 && (parts.hour === 0 || parts.hour === 4));
  if (!dateOnly) return date.toISOString();
  return zonedTimeToDate(
    { year: parts.year, month: parts.month, day: parts.day, hour: 0, minute: 0, second: 0 },
    timeZone,
  ).toISOString();
}

function remoteFields(task: ClickUpTask): Fields {
  return {
    title: clip(task.name, 200) ?? "ClickUp task",
    dueAt: fromClickUpDue(task),
    done: isDoneStatus(task.status?.type),
  };
}

function localFields(row: SyncRow): Fields {
  return { title: row.title, dueAt: iso(row.due_at), done: Boolean(row.completed_at) };
}

function same(key: keyof Fields, a: unknown, b: unknown) {
  if (key === "dueAt") {
    const left = typeof a === "string" ? new Date(a).getTime() : null;
    const right = typeof b === "string" ? new Date(b).getTime() : null;
    return left === right;
  }
  return a === b;
}

const KEYS: (keyof Fields)[] = ["title", "dueAt", "done"];

function snapshotOf(row: SyncRow): Snapshot {
  return row.clickup_sync && typeof row.clickup_sync === "object" ? row.clickup_sync : {};
}

function remoteTime(task: ClickUpTask) {
  const value = Number(task.date_updated);
  return Number.isFinite(value) && value > 0 ? value : Date.now();
}

function recordLink(origin: string | null, row: Pick<SyncRow, "contact_id" | "company_id">) {
  if (!origin) return null;
  if (row.contact_id) return `${origin}${contactHref(row.contact_id)}`;
  if (row.company_id) return `${origin}${companyHref(row.company_id)}`;
  return null;
}

export function clickupDescription(origin: string | null, row: SyncRow) {
  const lines: string[] = [];
  if (row.description?.trim()) lines.push(row.description.trim(), "");
  if (row.contact_id && row.contact_name) lines.push(`Contact: ${row.contact_name}`);
  if (row.company_name) lines.push(`Company: ${row.company_name}`);
  const link = recordLink(origin, row);
  if (link) lines.push(`Orbit: ${link}`);
  return lines.join("\n").trim();
}

async function lockClickUpTask(db: Db, workspaceId: string, taskId: string) {
  await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`clickup:${workspaceId}:${taskId}`]);
}

async function readSyncRow(db: Db, id: string, lock = false) {
  if (lock) await db.query("select 1 from crm.tasks where id = $1 for update", [id]);
  const result = await db.query<SyncRow>(`select ${SYNC_COLUMNS} ${SYNC_FROM} where t.id = $1`, [id]);
  return result.rows[0] ?? null;
}

async function linkedRow(db: Db, workspaceId: string, clickupTaskId: string) {
  const result = await db.query<SyncRow>(
    `select ${SYNC_COLUMNS} ${SYNC_FROM} where t.workspace_id = $1 and t.clickup_task_id = $2`,
    [workspaceId, clickupTaskId],
  );
  return result.rows[0] ?? null;
}

async function recordTaskError(actor: UserActor, taskId: string, message: string) {
  await withActor(actor, (db) =>
    db.query(
      `update crm.tasks
       set clickup_error = $2, clickup_sync = clickup_sync - 'creatingAt'
       where id = $1`,
      [taskId, message.slice(0, 500)],
    ),
  );
}

async function listInfo(s: Session, listId: string) {
  return cached(s.lists, listId, () => s.api.getList(listId));
}

async function linkField(s: Session, listId: string) {
  const fields = await cached(s.fields, listId, () => s.api.getListFields(listId));
  return (
    fields.find(
      (field) =>
        LINK_FIELD_NAMES.includes(field.name.trim().toLowerCase()) && LINK_FIELD_TYPES.includes(field.type),
    ) ?? null
  );
}

async function ownerId(s: Session) {
  if (s.state.externalUserId && /^\d+$/.test(s.state.externalUserId)) return Number(s.state.externalUserId);
  const user = await s.api.getUser();
  s.state.externalUserId = String(user.id);
  await withActor(s.actor, (db) =>
    db.query(
      `update crm.integration_state set external_user_id = $2
       where workspace_id = $1 and source = 'clickup' and connection_id is null`,
      [s.actor.workspaceId, String(user.id)],
    ),
  );
  return user.id;
}

async function archiveDeleted(s: Session, row: SyncRow) {
  if (row.archived_at) return "unchanged" as const;
  await archiveTask(s.actor, row.id, {
    provenance: { operation: "clickup_deleted", source: "clickup", sourceUrl: row.clickup_url },
  });
  await withActor(s.actor, (db) =>
    db.query(
      "update crm.tasks set clickup_error = null, clickup_synced_at = now() where id = $1",
      [row.id],
    ),
  );
  return "archived" as const;
}

async function createRemote(s: Session, taskId: string) {
  const claimed = await withActor(s.actor, async (db) => {
    const result = await db.query<{ id: string }>(
      `update crm.tasks
       set clickup_sync = clickup_sync || jsonb_build_object('creatingAt', $2::bigint)
       where id = $1 and clickup_task_id is null and clickup_list_id is not null and archived_at is null
         and coalesce((clickup_sync->>'creatingAt')::bigint, 0) < $3::bigint
       returning id`,
      [taskId, Date.now(), Date.now() - CREATE_CLAIM_MS],
    );
    if (!result.rows[0]) return null;
    return readSyncRow(db, taskId);
  });
  if (!claimed || !claimed.clickup_list_id) return "unchanged" as const;
  const row = claimed;
  const listId = row.clickup_list_id!;
  try {
    const local = localFields(row);
    const body: ClickUpTaskWrite = {
      name: local.title,
      description: clickupDescription(s.origin, row),
      assignees: [await ownerId(s)],
      ...(local.dueAt ? toClickUpDue(local.dueAt) : {}),
    };
    if (local.done) {
      const status = statusFor(await listInfo(s, listId), true);
      if (status) body.status = status;
    }
    const created = await s.api.createTask(listId, body);
    const field = await linkField(s, listId).catch(() => null);
    const link = recordLink(s.origin, row);
    const value = field?.type === "email" ? (row.contact_email ? canonicalEmail(row.contact_email) : null) : link;
    if (field && value) {
      await s.api.setCustomField(created.id, field.id, value).catch((error: unknown) => {
        console.error("ClickUp custom field update failed", error);
      });
    }
    const pushedAt = Date.now();
    await withActor(s.actor, async (db) => {
      await lockClickUpTask(db, s.actor.workspaceId, created.id);
      await db.query(
        `update crm.tasks
         set clickup_task_id = $2, clickup_url = $3, clickup_list_id = $4, clickup_synced_at = now(),
             clickup_error = null, clickup_sync = $5::jsonb
         where id = $1`,
        [
          row.id,
          created.id,
          clip(created.url, 500),
          created.list?.id ? String(created.list.id) : listId,
          JSON.stringify({ ...local, remoteUpdatedAt: remoteTime(created), pushedAt }),
        ],
      );
    });
    return "pushed" as const;
  } catch (error) {
    await recordTaskError(s.actor, row.id, errorText(error, "Could not create the ClickUp task."));
    throw error;
  }
}

async function updateRemote(s: Session, row: SyncRow) {
  const local = localFields(row);
  const snap = snapshotOf(row);
  const dirty = KEYS.filter((key) => snap[key] === undefined || !same(key, local[key], snap[key]));
  if (dirty.length === 0 || !row.clickup_task_id) return "unchanged" as const;
  try {
    const body: ClickUpTaskWrite = {};
    if (dirty.includes("title")) body.name = local.title;
    if (dirty.includes("dueAt")) Object.assign(body, toClickUpDue(local.dueAt));
    if (dirty.includes("done") && row.clickup_list_id) {
      const status = statusFor(await listInfo(s, row.clickup_list_id), local.done);
      if (!status) throw new ClickUpError("That ClickUp list has no matching status.", 0);
      body.status = status;
    }
    const updated = await s.api.updateTask(row.clickup_task_id, body);
    if (!updated) return archiveDeleted(s, row);
    const next: Snapshot = { remoteUpdatedAt: remoteTime(updated), pushedAt: Date.now() };
    for (const key of dirty) Object.assign(next, { [key]: local[key] });
    await withActor(s.actor, (db) =>
      db.query(
        `update crm.tasks
         set clickup_sync = clickup_sync || $2::jsonb, clickup_synced_at = now(), clickup_error = null,
             clickup_url = coalesce($3, clickup_url)
         where id = $1`,
        [row.id, JSON.stringify(next), clip(updated.url, 500)],
      ),
    );
    return "pushed" as const;
  } catch (error) {
    await recordTaskError(s.actor, row.id, errorText(error, "Could not update the ClickUp task."));
    throw error;
  }
}

async function pushRow(s: Session, taskId: string) {
  const row = await withActor(s.actor, (db) => readSyncRow(db, taskId));
  if (!row || row.archived_at) return "unchanged" as const;
  if (!row.clickup_task_id) return row.clickup_list_id ? createRemote(s, taskId) : ("unchanged" as const);
  return updateRemote(s, row);
}

function customFieldText(task: ClickUpTask) {
  const values: string[] = [];
  for (const field of task.custom_fields ?? []) {
    if (!LINK_FIELD_NAMES.includes(field.name?.trim().toLowerCase() ?? "")) continue;
    if (typeof field.value === "string" && field.value.trim()) values.push(field.value.trim());
  }
  return values;
}

const RECORD_URL = /\/(contacts|companies)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;
const EMAIL_PATTERN = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

type Link = { contactId: string | null; companyId: string | null };

async function recordById(db: Db, workspaceId: string, kind: string, id: string): Promise<Link | null> {
  if (!isUuid(id)) return null;
  if (kind.toLowerCase() === "contacts") {
    const result = await db.query<{ id: string }>(
      "select id from crm.contacts where id = $1 and workspace_id = $2 and archived_at is null",
      [id, workspaceId],
    );
    return result.rows[0] ? { contactId: id, companyId: null } : null;
  }
  const result = await db.query<{ id: string }>(
    "select id from crm.companies where id = $1 and workspace_id = $2 and archived_at is null",
    [id, workspaceId],
  );
  return result.rows[0] ? { contactId: null, companyId: id } : null;
}

async function recordFromUrls(db: Db, workspaceId: string, text: string) {
  for (const match of text.matchAll(RECORD_URL)) {
    const found = await recordById(db, workspaceId, match[1], match[2].toLowerCase());
    if (found) return found;
  }
  return null;
}

async function contactByEmail(db: Db, workspaceId: string, email: string): Promise<Link | null> {
  const result = await db.query<{ id: string }>(
    `select id from crm.contacts
     where workspace_id = $1 and archived_at is null and normalized_email = $2
     order by created_at limit 1`,
    [workspaceId, email],
  );
  return result.rows[0] ? { contactId: result.rows[0].id, companyId: null } : null;
}

async function companyByDomain(db: Db, workspaceId: string, domain: string): Promise<Link | null> {
  const result = await db.query<{ id: string }>(
    `select id from crm.companies
     where workspace_id = $1 and archived_at is null and domain = $2
     order by created_at limit 1`,
    [workspaceId, domain],
  );
  return result.rows[0] ? { contactId: null, companyId: result.rows[0].id } : null;
}

export async function findClickUpLink(db: Db, workspaceId: string, task: ClickUpTask): Promise<Link | null> {
  for (const value of customFieldText(task)) {
    const byUrl = await recordFromUrls(db, workspaceId, value);
    if (byUrl) return byUrl;
    const email = canonicalEmail(value.replace(/^mailto:/i, ""));
    if (email) {
      const contact = await contactByEmail(db, workspaceId, email);
      if (contact) return contact;
      continue;
    }
    const domain = canonicalDomain(value);
    if (domain) {
      const company = await companyByDomain(db, workspaceId, domain);
      if (company) return company;
    }
  }
  const text = [task.markdown_description, task.text_content, task.description]
    .filter((item): item is string => typeof item === "string" && item.trim() !== "")
    .join("\n")
    .slice(0, 50_000);
  if (!text) return null;
  const byUrl = await recordFromUrls(db, workspaceId, text);
  if (byUrl) return byUrl;
  const members = await internalAddresses(db, workspaceId, []);
  const seen = new Set<string>();
  for (const match of text.matchAll(EMAIL_PATTERN)) {
    const email = canonicalEmail(match[0]);
    if (!email || seen.has(email) || members.isInternal(email)) continue;
    seen.add(email);
    const contact = await contactByEmail(db, workspaceId, email);
    if (contact) return contact;
  }
  return null;
}

function mergeFields(local: Fields, remote: Fields, snap: Snapshot, localTime: number, changedAt: number) {
  const write: TaskWrite = {};
  const next: Snapshot = {};
  for (const key of KEYS) {
    if (same(key, remote[key], local[key])) {
      Object.assign(next, { [key]: remote[key] });
      continue;
    }
    const known = snap[key] !== undefined;
    const remoteChanged = !known || !same(key, remote[key], snap[key]);
    const localChanged = !known || !same(key, local[key], snap[key]);
    if (!remoteChanged) continue;
    if (localChanged && localTime > changedAt) continue;
    if (key === "title") write.title = remote.title;
    if (key === "dueAt") write.dueAt = remote.dueAt;
    if (key === "done") write.completed = remote.done;
    Object.assign(next, { [key]: remote[key] });
  }
  return { write, next };
}

type PullOutcome = "imported" | "updated" | "unchanged" | "ignored" | "archived";

async function pullRemote(s: Session, task: ClickUpTask, watched: Set<string>): Promise<PullOutcome> {
  if (!task?.id || !isClickUpId(String(task.id))) return "ignored";
  const taskId = String(task.id);
  const listId = task.list?.id ? String(task.list.id) : null;
  if (task.archived || (task as { deleted?: boolean }).deleted) {
    const row = await withActor(s.actor, (db) => linkedRow(db, s.actor.workspaceId, taskId));
    return row ? archiveDeleted(s, row) : "ignored";
  }
  const remote = remoteFields(task);
  const changedAt = remoteTime(task);
  return withActor(s.actor, async (db) => {
    await lockClickUpTask(db, s.actor.workspaceId, taskId);
    const linked = await linkedRow(db, s.actor.workspaceId, taskId);
    if (linked) {
      if (linked.archived_at) return "unchanged";
      const row = (await readSyncRow(db, linked.id, true)) ?? linked;
      const snap = snapshotOf(row);
      const listChanged = Boolean(listId && listId !== row.clickup_list_id);
      if (!listChanged && snap.remoteUpdatedAt && changedAt <= snap.remoteUpdatedAt) return "unchanged";
      const { write, next } = mergeFields(
        localFields(row),
        remote,
        snap,
        new Date(row.updated_at).getTime(),
        changedAt,
      );
      const changed = Object.keys(write).length > 0;
      if (changed) await updateTaskInDb(db, s.actor, row.id, write, { ...PROVENANCE, sourceUrl: clip(task.url, 2000) });
      await db.query(
        `update crm.tasks
         set clickup_sync = clickup_sync || $2::jsonb, clickup_synced_at = now(), clickup_error = null,
             clickup_list_id = coalesce($3, clickup_list_id), clickup_url = coalesce($4, clickup_url)
         where id = $1`,
        [
          row.id,
          JSON.stringify({ ...next, remoteUpdatedAt: Math.max(changedAt, snap.remoteUpdatedAt ?? 0) }),
          listId,
          clip(task.url, 500),
        ],
      );
      return changed ? "updated" : "unchanged";
    }
    if (!listId || !watched.has(listId)) return "ignored";
    const creating = await db.query<{ id: string }>(
      `select id from crm.tasks
       where workspace_id = $1 and clickup_task_id is null and clickup_list_id = $2 and title = $3
         and archived_at is null and coalesce((clickup_sync->>'creatingAt')::bigint, 0) >= $4::bigint
       limit 1`,
      [s.actor.workspaceId, listId, remote.title, Date.now() - CREATE_CLAIM_MS],
    );
    if (creating.rows[0]) return "ignored";
    const link = await findClickUpLink(db, s.actor.workspaceId, task);
    if (!link) return "ignored";
    const created = await createTaskInDb(
      db,
      s.actor,
      {
        title: remote.title,
        dueAt: remote.dueAt,
        completed: remote.done,
        contactId: link.contactId,
        companyId: link.contactId ? undefined : link.companyId,
      },
      { operation: "import_clickup", source: "clickup", sourceUrl: clip(task.url, 2000) },
    );
    if (!created) return "ignored";
    await db.query(
      `update crm.tasks
       set clickup_task_id = $2, clickup_list_id = $3, clickup_url = $4, clickup_synced_at = now(),
           clickup_error = null, clickup_sync = $5::jsonb
       where id = $1`,
      [created.id, taskId, listId, clip(task.url, 500), JSON.stringify({ ...remote, remoteUpdatedAt: changedAt })],
    );
    return "imported";
  });
}

function watchedSet(state: ClickUpState) {
  return new Set(state.watchedListIds);
}

async function linkedLists(actor: UserActor) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ clickup_list_id: string }>(
      `select distinct clickup_list_id from crm.tasks
       where workspace_id = $1 and clickup_task_id is not null and clickup_list_id is not null
         and archived_at is null
       limit $2`,
      [actor.workspaceId, MAX_POLL_LISTS],
    );
    return result.rows.map((row) => row.clickup_list_id);
  });
}

async function pushQueue(actor: UserActor) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ id: string }>(
      `select t.id from crm.tasks t
       where t.workspace_id = $1 and t.archived_at is null and t.clickup_list_id is not null
         and (t.clickup_task_id is null or ${DIRTY_SQL})
       order by t.clickup_synced_at asc nulls first, t.updated_at asc
       limit $2`,
      [actor.workspaceId, PUSH_BATCH],
    );
    return result.rows.map((row) => row.id);
  });
}

async function staleLinks(actor: UserActor) {
  return withActor(actor, async (db) => {
    const result = await db.query<SyncRow>(
      `select ${SYNC_COLUMNS} ${SYNC_FROM}
       where t.workspace_id = $1 and t.archived_at is null and t.completed_at is null
         and t.clickup_task_id is not null
         and (t.clickup_synced_at is null or t.clickup_synced_at < now() - make_interval(secs => $2::double precision))
       order by t.clickup_synced_at asc nulls first
       limit $3`,
      [actor.workspaceId, VERIFY_AFTER_MS / 1000, VERIFY_BATCH],
    );
    return result.rows;
  });
}

export async function syncClickUp(
  input: ClickUpOptions & { actor: UserActor; force?: boolean },
): Promise<ClickUpSyncResult> {
  const options = { ...input, deadline: input.deadline ?? Date.now() + WEBHOOK_BUDGET_MS };
  const token = clickupToken();
  if (!token) return { ...idle(), error: CLICKUP_NOT_CONFIGURED };
  const actor = options.actor;
  const state = await getClickUpState(actor);
  if (!state?.teamId) return idle();
  const key = clickupKey(actor);
  const claim = await withActor(actor, (db) => claimIntegration(db, key, Boolean(options.force), SYNC_GAP_MS));
  if (!claim) return idle();
  const started = Date.now();
  const s = session(client(token, options), state, actor, options);
  const result: ClickUpSyncResult = { ...idle(), ran: true };
  let firstError: string | null = null;
  let complete = true;
  const fail = (error: unknown, fallback: string) => {
    firstError ??= errorText(error, fallback);
    result.failed += 1;
  };
  try {
    const since = claim.lastSyncedAt
      ? new Date(claim.lastSyncedAt).getTime() - OVERLAP_MS
      : started - LOOKBACK_MS;
    const watched = watchedSet(state);
    const listIds = [...new Set([...state.watchedListIds, ...(await linkedLists(actor))])].slice(0, MAX_POLL_LISTS);
    if (listIds.length > 0) {
      for (let page = 0; ; page += 1) {
        if (page >= MAX_POLL_PAGES || !timeLeft(options.deadline, STEP_RESERVE_MS)) {
          complete = false;
          break;
        }
        const body = await s.api.teamTasks({ teamId: state.teamId, listIds, updatedAfter: since, page });
        for (const task of body.tasks) {
          result.fetched += 1;
          if (!timeLeft(options.deadline, STEP_RESERVE_MS)) {
            complete = false;
            break;
          }
          try {
            const outcome = await pullRemote(s, task, watched);
            if (outcome === "imported") result.imported += 1;
            else if (outcome === "updated") result.updated += 1;
            else if (outcome === "archived") result.archived += 1;
          } catch (error) {
            fail(error, "Could not sync a ClickUp task.");
          }
        }
        if (body.lastPage || !complete) break;
      }
    }
    for (const id of await pushQueue(actor)) {
      if (!timeLeft(options.deadline, STEP_RESERVE_MS)) {
        complete = false;
        break;
      }
      try {
        const outcome = await pushRow(s, id);
        if (outcome === "pushed") result.pushed += 1;
        else if (outcome === "archived") result.archived += 1;
      } catch (error) {
        fail(error, "Could not update ClickUp.");
      }
    }
    for (const row of await staleLinks(actor)) {
      if (!timeLeft(options.deadline, STEP_RESERVE_MS)) break;
      try {
        const remote = await s.api.getTask(row.clickup_task_id!);
        if (!remote) {
          if ((await archiveDeleted(s, row)) === "archived") result.archived += 1;
          continue;
        }
        const outcome = await pullRemote(s, remote, watched);
        if (outcome === "archived") result.archived += 1;
        else if (outcome === "updated") result.updated += 1;
        await withActor(actor, (db) =>
          db.query("update crm.tasks set clickup_synced_at = now() where id = $1", [row.id]),
        );
      } catch (error) {
        fail(error, "Could not check a ClickUp task.");
      }
    }
    await withActor(actor, (db) =>
      finishIntegration(db, key, { syncedAt: complete ? new Date(started).toISOString() : null, error: firstError }),
    );
    result.complete = complete;
    if (firstError) result.error = firstError;
    return result;
  } catch (error) {
    const message = errorText(error, "Could not sync ClickUp.");
    await withActor(actor, (db) => finishIntegration(db, key, { error: message }));
    return { ...result, error: message };
  }
}

export async function syncClickUpFor(actor: UserActor, options: ClickUpOptions = {}) {
  if (!clickupToken()) throw new CrmError("invalid_input", CLICKUP_NOT_CONFIGURED, 400);
  const state = await getClickUpState(actor);
  if (!state?.teamId) throw new CrmError("invalid_input", CLICKUP_NOT_SET_UP, 400);
  return syncClickUp({ ...options, actor, force: true });
}

export async function pushClickUpTask(actor: UserActor, taskId: string, options: ClickUpOptions = {}) {
  const token = clickupToken();
  if (!token || !isUuid(taskId)) return "unchanged" as const;
  const state = await getClickUpState(actor);
  if (!state?.teamId) return "unchanged" as const;
  const deadline = options.deadline ?? Date.now() + INLINE_BUDGET_MS;
  const s = session(client(token, { ...options, deadline }), state, actor, { ...options, deadline });
  try {
    return await pushRow(s, taskId);
  } catch (error) {
    console.error("ClickUp push failed", errorText(error, "Could not update ClickUp."));
    return "failed" as const;
  }
}

export async function sendTaskToDefaultList(
  actor: UserActor,
  taskId: string,
  options: ClickUpOptions = {},
) {
  if (!clickupToken() || !isUuid(taskId)) return "unchanged" as const;
  const state = await getClickUpState(actor);
  if (!state?.teamId || !state.defaultListId) return "unchanged" as const;
  if (!state.lists.some((list) => list.id === state.defaultListId)) return "unchanged" as const;
  await withActor(actor, (db) =>
    db.query(
      "update crm.tasks set clickup_list_id = $2 where id = $1 and workspace_id = $3 and clickup_list_id is null",
      [taskId, state.defaultListId, actor.workspaceId],
    ),
  );
  return pushClickUpTask(actor, taskId, options);
}

export async function getClickUpPicker(actor: UserActor): Promise<ClickUpPicker | null> {
  if (!clickupToken()) return null;
  const state = await getClickUpState(actor);
  if (!state?.teamId || state.lists.length === 0) return null;
  const ids = new Set(state.lists.map((list) => list.id));
  const listId =
    [state.lastUsedListId, state.defaultListId].find((id): id is string => Boolean(id && ids.has(id))) ??
    state.lists[0].id;
  return { lists: state.lists, listId };
}

export async function createTaskWithClickUp(
  actor: UserActor,
  input: TaskWrite,
  clickupListId: string | null,
  options: ClickUpOptions & { provenance?: Provenance } = {},
): Promise<{ task: Task; clickupError: string | null }> {
  let listId: string | null = null;
  if (clickupListId && clickupToken()) {
    const state = await getClickUpState(actor);
    if (!state?.teamId) throw new CrmError("invalid_input", CLICKUP_NOT_SET_UP, 400);
    if (!state.lists.some((list) => list.id === clickupListId)) {
      throw new CrmError("invalid_input", "Choose a ClickUp list from your workspace.", 400, {
        field: "clickupListId",
      });
    }
    listId = clickupListId;
  }
  const created = await createTask(actor, input, {
    provenance: options.provenance ?? { operation: "create_task", source: "web" },
  });
  const task = created.body.task;
  if (!listId) return { task, clickupError: null };
  await withActor(actor, async (db) => {
    await db.query("update crm.tasks set clickup_list_id = $2 where id = $1", [task.id, listId]);
    await db.query(
      `update crm.integration_state set last_used_list_id = $2
       where workspace_id = $1 and source = 'clickup' and connection_id is null`,
      [actor.workspaceId, listId],
    );
  });
  const outcome = await pushClickUpTask(actor, task.id, options);
  if (outcome === "failed") {
    const row = await withActor(actor, (db) =>
      db.query<{ clickup_error: string | null }>("select clickup_error from crm.tasks where id = $1", [task.id]),
    );
    return { task: { ...task, clickupListId: listId }, clickupError: row.rows[0]?.clickup_error ?? "Could not reach ClickUp." };
  }
  return { task: { ...task, clickupListId: listId }, clickupError: null };
}

export async function getClickUpSettings(
  actor: UserActor,
  options: ClickUpOptions = {},
): Promise<ClickUpSettingsView> {
  const token = clickupToken();
  const state = await getClickUpState(actor);
  const view: ClickUpSettingsView = {
    configured: Boolean(token),
    error: null,
    user: null,
    teams: [],
    teamId: state?.teamId ?? null,
    lists: state?.lists ?? [],
    defaultListId: state?.defaultListId ?? null,
    watchedListIds: state?.watchedListIds ?? [],
    webhookEnabled: Boolean(state?.webhookId && state.webhookSecret),
    siteUrl: configuredSiteOrigin(),
    lastSyncedAt: state?.lastSyncedAt ?? null,
    lastAttemptAt: state?.lastAttemptAt ?? null,
    lastError: state?.lastError ?? null,
  };
  if (!token) return view;
  const api = client(token, options);
  try {
    const [user, teams] = await Promise.all([api.getUser(), api.getTeams()]);
    view.user = { username: user.username ?? null, email: user.email ?? null };
    view.teams = teams;
    const teamId = view.teamId ?? (teams.length === 1 ? teams[0].id : null);
    view.teamId = teamId;
    if (teamId && teams.some((team) => team.id === teamId)) {
      view.lists = await api.hierarchy(teamId);
      if (state?.teamId === teamId && JSON.stringify(view.lists) !== JSON.stringify(state.lists)) {
        await withActor(actor, (db) =>
          db.query(
            `update crm.integration_state set list_choices = $2::jsonb
             where workspace_id = $1 and source = 'clickup' and connection_id is null`,
            [actor.workspaceId, JSON.stringify(view.lists)],
          ),
        );
      }
    }
  } catch (error) {
    view.error = error instanceof ClickUpError ? error.message : "Could not reach ClickUp.";
  }
  return view;
}

function webhookScope(lists: ClickUpListChoice[], ids: string[]) {
  const chosen = lists.filter((list) => ids.includes(list.id));
  if (chosen.length === 0) return "team";
  if (chosen.length === 1) return `list:${chosen[0].id}`;
  const spaces = new Set(chosen.map((list) => list.spaceId));
  return spaces.size === 1 ? `space:${chosen[0].spaceId}` : "team";
}

function scopeIds(state: Pick<ClickUpState, "watchedListIds" | "defaultListId">) {
  return [...new Set([...state.watchedListIds, ...(state.defaultListId ? [state.defaultListId] : [])])];
}

export async function saveClickUpSettings(
  actor: UserActor,
  input: { teamId: string; defaultListId: string | null; watchedListIds: string[] },
  options: ClickUpOptions = {},
) {
  assertScope(actor.scopes, "admin");
  const token = clickupToken();
  if (!token) throw new CrmError("invalid_input", CLICKUP_NOT_CONFIGURED, 400);
  const api = client(token, options);
  let teams: ClickUpTeam[];
  let lists: ClickUpListChoice[];
  let userId: string;
  try {
    const [user, found] = await Promise.all([api.getUser(), api.getTeams()]);
    userId = String(user.id);
    teams = found;
    if (!teams.some((team) => team.id === input.teamId)) {
      throw new CrmError("invalid_input", "Choose a ClickUp workspace this token can see.", 400, { field: "teamId" });
    }
    lists = await api.hierarchy(input.teamId, true);
  } catch (error) {
    if (error instanceof CrmError) throw error;
    throw new CrmError("upstream_error", error instanceof ClickUpError ? error.message : "Could not reach ClickUp.", 502);
  }
  const ids = new Set(lists.map((list) => list.id));
  const watched = [...new Set(input.watchedListIds.filter(Boolean))];
  if (watched.length > MAX_POLL_LISTS) {
    throw new CrmError("invalid_input", "Choose at most 100 lists to watch.", 400, { field: "watchedListIds" });
  }
  if (watched.some((id) => !ids.has(id))) {
    throw new CrmError("invalid_input", "Choose lists from the selected ClickUp workspace.", 400, {
      field: "watchedListIds",
    });
  }
  const defaultListId = input.defaultListId || null;
  if (defaultListId && !ids.has(defaultListId)) {
    throw new CrmError("invalid_input", "Choose a default list from the selected ClickUp workspace.", 400, {
      field: "defaultListId",
    });
  }
  const before = await getClickUpState(actor);
  const teamChanged = Boolean(before?.teamId && before.teamId !== input.teamId);
  await withActor(actor, async (db) => {
    await ensureIntegration(db, clickupKey(actor));
    await db.query(
      `update crm.integration_state
       set team_id = $2, external_user_id = $3, default_list_id = $4, watched_list_ids = $5::text[],
           list_choices = $6::jsonb, user_id = $7,
           last_used_list_id = case when $8::boolean then null else last_used_list_id end,
           last_synced_at = case when $8::boolean then null else last_synced_at end
       where workspace_id = $1 and source = 'clickup' and connection_id is null`,
      [actor.workspaceId, input.teamId, userId, defaultListId, watched, JSON.stringify(lists), actor.userId, teamChanged],
    );
  });
  let warning: string | null = null;
  if (before?.webhookId) {
    const desired = webhookScope(lists, scopeIds({ watchedListIds: watched, defaultListId }));
    if (teamChanged) {
      await api.deleteWebhook(before.webhookId).catch(() => false);
      await clearWebhook(actor);
      warning = "Instant ClickUp sync was turned off because the workspace changed.";
    } else if (desired !== before.webhookScope) {
      try {
        await enableClickUpWebhook(actor, options.origin ?? "", { ...options, replace: true });
      } catch (error) {
        warning = `Saved, but instant sync could not follow the new lists: ${errorText(error, "Could not reach ClickUp.")}`;
      }
    }
  }
  return { teamId: input.teamId, defaultListId, watchedListIds: watched, warning };
}

async function clearWebhook(actor: UserActor) {
  await withActor(actor, (db) =>
    db.query(
      `update crm.integration_state set webhook_id = null, webhook_secret = null, webhook_scope = null
       where workspace_id = $1 and source = 'clickup' and connection_id is null`,
      [actor.workspaceId],
    ),
  );
}

export async function enableClickUpWebhook(
  actor: UserActor,
  origin: string,
  options: ClickUpOptions & { replace?: boolean } = {},
): Promise<{ enabled: boolean; message: string }> {
  assertScope(actor.scopes, "admin");
  const token = clickupToken();
  if (!token) throw new CrmError("invalid_input", CLICKUP_NOT_CONFIGURED, 400);
  const state = await getClickUpState(actor);
  if (!state?.teamId) throw new CrmError("invalid_input", CLICKUP_NOT_SET_UP, 400);
  if (state.webhookId && state.webhookSecret && !options.replace) {
    return { enabled: true, message: "Instant ClickUp sync is already on." };
  }
  const site = configuredSiteOrigin() ?? origin;
  if (!/^https:\/\//.test(site)) {
    throw new CrmError("invalid_input", "Set SITE_URL to the https address of Orbit before turning on instant sync.", 400);
  }
  const endpoint = `${site}/api/clickup/webhook`;
  const api = client(token, options);
  const scope = webhookScope(state.lists, scopeIds(state));
  let created: { id: string; secret: string | null };
  try {
    for (const hook of await api.listWebhooks(state.teamId)) {
      if (hook.endpoint === endpoint || hook.id === state.webhookId) await api.deleteWebhook(hook.id);
    }
    const [kind, id] = scope.split(":");
    created = await api.createWebhook(state.teamId, {
      endpoint,
      events: CLICKUP_EVENTS,
      ...(kind === "space" ? { space_id: Number(id) } : {}),
      ...(kind === "list" ? { list_id: Number(id) } : {}),
    });
  } catch (error) {
    throw new CrmError("upstream_error", error instanceof ClickUpError ? error.message : "Could not reach ClickUp.", 502);
  }
  if (!created.secret) throw new CrmError("upstream_error", "ClickUp did not return a webhook secret.", 502);
  const secret = created.secret;
  await withActor(actor, async (db) => {
    await ensureIntegration(db, clickupKey(actor));
    await db.query(
      `update crm.integration_state
       set webhook_id = $2, webhook_secret = $3, webhook_scope = $4, user_id = $5
       where workspace_id = $1 and source = 'clickup' and connection_id is null`,
      [actor.workspaceId, created.id.slice(0, 200), encryptSecret(secret), scope, actor.userId],
    );
  });
  return { enabled: true, message: "Instant ClickUp sync is on." };
}

export async function disableClickUpWebhook(actor: UserActor, options: ClickUpOptions = {}) {
  assertScope(actor.scopes, "admin");
  const token = clickupToken();
  const state = await getClickUpState(actor);
  if (token && state?.webhookId) {
    try {
      await client(token, options).deleteWebhook(state.webhookId);
    } catch (error) {
      throw new CrmError("upstream_error", error instanceof ClickUpError ? error.message : "Could not reach ClickUp.", 502);
    }
  }
  await clearWebhook(actor);
  return { message: "Instant ClickUp sync is off. Orbit checks ClickUp every 10 minutes." };
}

type WebhookTarget = {
  workspace_id: string;
  workspace_name: string;
  user_id: string;
  role: WorkspaceRole;
  email: string | null;
  full_name: string | null;
  webhook_id: string | null;
  webhook_secret: string;
};

async function claimReceipt(actor: UserActor, messageId: string) {
  return withActor(actor, async (db) => {
    await db.query(
      `delete from crm.webhook_receipts
       where workspace_id = $1 and source = 'clickup'
         and received_at < now() - make_interval(secs => $2::double precision)`,
      [actor.workspaceId, RECEIPT_TTL_SECONDS],
    );
    const inserted = await db.query(
      `insert into crm.webhook_receipts (workspace_id, source, message_id)
       values ($1, 'clickup', $2)
       on conflict (workspace_id, source, message_id) do nothing
       returning id`,
      [actor.workspaceId, messageId.slice(0, 200)],
    );
    return (inserted.rowCount ?? 0) > 0;
  });
}

export async function receiveClickUpWebhook(
  headers: Headers,
  body: string,
  options: { now?: number } = {},
): Promise<
  | { ok: false; status: number }
  | { ok: true; duplicate: boolean; ignored?: boolean; actor: UserActor; event: ClickUpEvent | null }
> {
  if (!clickupToken()) return { ok: false, status: 404 };
  if (Buffer.byteLength(body) > MAX_WEBHOOK_BYTES) return { ok: false, status: 413 };
  const signature = headers.get("x-signature");
  if (!signature || !/^[0-9a-fA-F]{64}$/.test(signature.trim())) return { ok: false, status: 401 };
  const targets = await query<WebhookTarget>("select * from private.clickup_webhook_targets()");
  let actor: UserActor | null = null;
  let webhookId: string | null = null;
  for (const row of targets.rows) {
    let secret: string;
    try {
      secret = decryptSecret(row.webhook_secret);
    } catch {
      continue;
    }
    if (verifyClickUpSignature(secret, body, signature)) {
      actor = memberActor(row);
      webhookId = row.webhook_id;
      break;
    }
  }
  if (!actor) return { ok: false, status: 401 };
  let payload: { event?: unknown; task_id?: unknown; webhook_id?: unknown; history_items?: unknown };
  try {
    payload = JSON.parse(body);
  } catch {
    return { ok: false, status: 400 };
  }
  const event = typeof payload.event === "string" ? payload.event.slice(0, 100) : "";
  const taskId = typeof payload.task_id === "string" || typeof payload.task_id === "number" ? String(payload.task_id) : "";
  if (!event || !taskId || !isClickUpId(taskId) || (webhookId && payload.webhook_id && String(payload.webhook_id) !== webhookId)) {
    return { ok: true, duplicate: false, ignored: true, actor, event: null };
  }
  const history = Array.isArray(payload.history_items) ? payload.history_items.slice(0, MAX_HISTORY_ITEMS) : [];
  let newestAt: number | null = null;
  const historyIds: string[] = [];
  for (const item of history) {
    if (!item || typeof item !== "object") continue;
    const entry = item as { id?: unknown; date?: unknown };
    if (typeof entry.id === "string" || typeof entry.id === "number") historyIds.push(String(entry.id));
    const date = Number(entry.date);
    if (Number.isFinite(date) && date > 0) newestAt = Math.max(newestAt ?? 0, date);
  }
  const now = options.now ?? Date.now();
  if (newestAt !== null && now - newestAt > RECEIPT_TTL_SECONDS * 1000) {
    return { ok: true, duplicate: false, ignored: true, actor, event: null };
  }
  const receipt = historyIds.length > 0
    ? `${String(payload.webhook_id ?? webhookId ?? "")}:${historyIds.sort().join(",")}`
    : `${String(payload.webhook_id ?? webhookId ?? "")}:${event}:${taskId}`;
  const fresh = await claimReceipt(actor, receipt);
  return { ok: true, duplicate: !fresh, actor, event: { event, taskId, newestAt } };
}

export async function processClickUpEvent(actor: UserActor, event: ClickUpEvent, options: ClickUpOptions = {}) {
  const token = clickupToken();
  if (!token) return "ignored";
  const state = await getClickUpState(actor);
  if (!state?.teamId) return "ignored";
  const s = session(client(token, options), state, actor, options);
  const linked = await withActor(actor, (db) => linkedRow(db, actor.workspaceId, event.taskId));
  if (event.event !== "taskDeleted" && linked && event.newestAt !== null) {
    const pushedAt = snapshotOf(linked).pushedAt;
    if (pushedAt && event.newestAt >= pushedAt - 5_000 && event.newestAt <= pushedAt + ECHO_WINDOW_MS) {
      return "echo";
    }
  }
  if (!linked && event.event === "taskDeleted") return "ignored";
  try {
    const remote = await s.api.getTask(event.taskId);
    if (!remote) return linked ? archiveDeleted(s, linked) : "ignored";
    return await pullRemote(s, remote, watchedSet(state));
  } catch (error) {
    const message = errorText(error, "Could not sync a ClickUp task.");
    await withActor(actor, (db) => finishIntegration(db, clickupKey(actor), { error: message }));
    return "failed";
  }
}

function background(task: () => Promise<unknown>) {
  after(async () => {
    try {
      await task();
    } catch (error) {
      console.error("ClickUp webhook processing failed", error);
    }
  });
}

export async function handleClickUpWebhook(
  request: Request,
  options: ClickUpOptions & { now?: number; schedule?: Schedule } = {},
) {
  const deadline = options.deadline ?? Date.now() + WEBHOOK_BUDGET_MS;
  try {
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > MAX_WEBHOOK_BYTES) return Response.json({ error: "Too large." }, { status: 413 });
    const body = await request.text();
    const received = await receiveClickUpWebhook(request.headers, body, options);
    if (!received.ok) {
      return Response.json({ error: "Webhook not accepted." }, { status: received.status });
    }
    if (received.duplicate) return Response.json({ ok: true, duplicate: true });
    if (!received.event) return Response.json({ ok: true, ignored: true });
    const event = received.event;
    const schedule = options.schedule ?? background;
    schedule(() => processClickUpEvent(received.actor, event, { ...options, deadline }));
    return Response.json({ ok: true });
  } catch (error) {
    console.error("ClickUp webhook failed", error);
    return Response.json({ error: "Try again later." }, { status: 503 });
  }
}

export async function clickupActorFor(members: UserActor[]): Promise<UserActor | null> {
  if (!clickupToken() || members.length === 0) return null;
  const state = await getClickUpState(members[0]);
  if (!state?.teamId) return null;
  return members.find((member) => member.userId === state.userId) ?? members[0];
}
