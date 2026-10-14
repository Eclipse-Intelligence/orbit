import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_BASE_URL = "https://api.clickup.com/api/v2";
const MAX_ATTEMPTS = 4;
const MAX_BACKOFF_MS = 15_000;
const TIMEOUT_MS = 20_000;
const HIERARCHY_TTL_MS = 5 * 60 * 1000;
export const TEAM_TASKS_PAGE_SIZE = 100;

export const CLICKUP_EVENTS = [
  "taskCreated",
  "taskUpdated",
  "taskDeleted",
  "taskStatusUpdated",
  "taskDueDateUpdated",
  "taskMoved",
];

export type ClickUpUser = { id: number; username: string | null; email: string | null };

export type ClickUpTeam = { id: string; name: string };

export type ClickUpStatus = { status: string; type: string; orderindex: number };

export type ClickUpListInfo = {
  id: string;
  name: string;
  statuses: ClickUpStatus[];
  space: { id: string; name?: string } | null;
  folder: { id: string; name?: string; hidden?: boolean } | null;
};

export type ClickUpField = { id: string; name: string; type: string };

export type ClickUpCustomFieldValue = ClickUpField & { value?: unknown };

export type ClickUpTask = {
  id: string;
  name: string;
  description?: string | null;
  markdown_description?: string | null;
  text_content?: string | null;
  status: { status: string; type: string } | null;
  date_updated: string | null;
  due_date: string | null;
  due_date_time?: boolean | null;
  archived?: boolean;
  url: string;
  list: { id: string } | null;
  space?: { id: string } | null;
  custom_fields?: ClickUpCustomFieldValue[];
};

export type ClickUpWebhook = {
  id: string;
  endpoint: string;
  secret?: string;
  space_id?: string | number | null;
  list_id?: string | number | null;
  folder_id?: string | number | null;
  health?: { status: string; fail_count: number };
};

export type ClickUpListChoice = {
  id: string;
  name: string;
  spaceId: string;
  spaceName: string;
  folderId: string | null;
  folderName: string | null;
};

export type ClickUpTaskWrite = {
  name?: string;
  description?: string;
  assignees?: number[];
  due_date?: number | null;
  due_date_time?: boolean;
  status?: string;
  custom_fields?: { id: string; value: unknown }[];
};

export class ClickUpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ClickUpError";
    this.status = status;
  }
}

export type ClickUpClientOptions = {
  token: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
  deadline?: number;
  now?: () => number;
};

export function clickupToken() {
  return process.env.CLICKUP_API_TOKEN?.trim() || null;
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function rateLimitDelay(response: Response, attempt: number, now: number) {
  const reset = Number(response.headers.get("x-ratelimit-reset") ?? Number.NaN);
  if (Number.isFinite(reset) && reset > 0) {
    const resetMs = reset > 1e12 ? reset : reset * 1000;
    return Math.min(Math.max(resetMs - now, 1_000), MAX_BACKOFF_MS);
  }
  const retryAfter = Number(response.headers.get("retry-after") ?? Number.NaN);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(retryAfter * 1000, MAX_BACKOFF_MS);
  }
  return Math.min(1_000 * 2 ** attempt, MAX_BACKOFF_MS);
}

async function errorMessage(response: Response) {
  const body = (await response.json().catch(() => ({}))) as { err?: unknown; ECODE?: unknown };
  const detail = typeof body.err === "string" ? body.err.replace(/\s+/g, " ").slice(0, 200) : "";
  if (response.status === 401) {
    return detail && !/token|oauth|authoriz/i.test(detail)
      ? `ClickUp refused the request: ${detail}`
      : "ClickUp rejected the API token. Check CLICKUP_API_TOKEN.";
  }
  if (response.status === 403) return "ClickUp refused the request. Check the token's access in ClickUp.";
  if (response.status === 429) return "ClickUp is rate limiting Orbit. It will try again on the next sync.";
  return `ClickUp returned ${response.status}${detail ? `: ${detail}` : "."}`;
}

function idPart(value: string | number) {
  return encodeURIComponent(String(value));
}

const hierarchyCache = new Map<string, { at: number; lists: ClickUpListChoice[] }>();

export function clearClickUpCache() {
  hierarchyCache.clear();
}

function listRef(value: unknown): { id: string; name: string } | null {
  if (!value || typeof value !== "object") return null;
  const item = value as { id?: unknown; name?: unknown };
  if (item.id === undefined || item.id === null) return null;
  return { id: String(item.id), name: typeof item.name === "string" ? item.name : String(item.id) };
}

export function clickupClient(options: ClickUpClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const clock = options.now ?? Date.now;
  const base = (options.baseUrl ?? (process.env.CLICKUP_API_BASE_URL?.trim() || DEFAULT_BASE_URL)).replace(/\/+$/, "");

  function remaining() {
    return options.deadline ? options.deadline - clock() : Number.POSITIVE_INFINITY;
  }

  async function request(path: string, init: RequestInit = {}) {
    for (let attempt = 0; ; attempt += 1) {
      if (remaining() < 1_000) throw new ClickUpError("Ran out of time talking to ClickUp.", 0);
      const response = await fetchImpl(`${base}${path}`, {
        ...init,
        headers: {
          authorization: options.token,
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
        signal: AbortSignal.timeout(Math.max(1_000, Math.min(TIMEOUT_MS, remaining()))),
      });
      if (response.status === 429 && attempt < MAX_ATTEMPTS - 1) {
        const delay = rateLimitDelay(response, attempt, clock());
        if (delay > remaining() - 2_000) return response;
        await sleep(delay);
        continue;
      }
      return response;
    }
  }

  async function json<T>(path: string, init?: RequestInit) {
    const response = await request(path, init);
    if (!response.ok) throw new ClickUpError(await errorMessage(response), response.status);
    return (await response.json()) as T;
  }

  async function getUser() {
    const body = await json<{ user: ClickUpUser }>("/user");
    return body.user;
  }

  async function getTeams() {
    const body = await json<{ teams: { id: string | number; name: string }[] }>("/team");
    return (body.teams ?? []).map((team) => ({ id: String(team.id), name: team.name }));
  }

  async function getSpaces(teamId: string) {
    const body = await json<{ spaces: { id: string | number; name: string }[] }>(
      `/team/${idPart(teamId)}/space?archived=false`,
    );
    return (body.spaces ?? []).map((space) => ({ id: String(space.id), name: space.name }));
  }

  async function getFolders(spaceId: string) {
    const body = await json<{
      folders: { id: string | number; name: string; hidden?: boolean; lists?: unknown[] }[];
    }>(`/space/${idPart(spaceId)}/folder?archived=false`);
    return (body.folders ?? []).map((folder) => ({
      id: String(folder.id),
      name: folder.name,
      hidden: Boolean(folder.hidden),
      lists: Array.isArray(folder.lists) ? folder.lists : null,
    }));
  }

  async function getFolderLists(folderId: string) {
    const body = await json<{ lists: unknown[] }>(`/folder/${idPart(folderId)}/list?archived=false`);
    return (body.lists ?? []).map(listRef).filter((item) => item !== null);
  }

  async function getFolderlessLists(spaceId: string) {
    const body = await json<{ lists: unknown[] }>(`/space/${idPart(spaceId)}/list?archived=false`);
    return (body.lists ?? []).map(listRef).filter((item) => item !== null);
  }

  async function hierarchy(teamId: string, fresh = false): Promise<ClickUpListChoice[]> {
    const key = `${base}:${createHash("sha256").update(options.token).digest("hex")}:${teamId}`;
    const cached = hierarchyCache.get(key);
    if (!fresh && cached && clock() - cached.at < HIERARCHY_TTL_MS) return cached.lists;
    const lists: ClickUpListChoice[] = [];
    for (const space of await getSpaces(teamId)) {
      const [folders, loose] = await Promise.all([getFolders(space.id), getFolderlessLists(space.id)]);
      for (const item of loose) {
        lists.push({ id: item.id, name: item.name, spaceId: space.id, spaceName: space.name, folderId: null, folderName: null });
      }
      for (const folder of folders) {
        const inline = folder.lists?.map(listRef).filter((item) => item !== null) ?? [];
        const nested =
          folder.lists && inline.length > 0 && inline.length === folder.lists.length
            ? inline
            : await getFolderLists(folder.id);
        for (const item of nested) {
          lists.push({
            id: item.id,
            name: item.name,
            spaceId: space.id,
            spaceName: space.name,
            folderId: folder.hidden ? null : folder.id,
            folderName: folder.hidden ? null : folder.name,
          });
        }
      }
    }
    hierarchyCache.set(key, { at: clock(), lists });
    return lists;
  }

  async function getList(listId: string) {
    const body = await json<{
      id: string | number;
      name: string;
      statuses?: { status: string; type: string; orderindex: number | string }[];
      space?: { id: string | number; name?: string } | null;
      folder?: { id: string | number; name?: string; hidden?: boolean } | null;
    }>(`/list/${idPart(listId)}`);
    return {
      id: String(body.id),
      name: body.name,
      statuses: (body.statuses ?? []).map((status) => ({
        status: status.status,
        type: status.type,
        orderindex: Number(status.orderindex) || 0,
      })),
      space: body.space ? { id: String(body.space.id), name: body.space.name } : null,
      folder: body.folder ? { id: String(body.folder.id), name: body.folder.name, hidden: body.folder.hidden } : null,
    } satisfies ClickUpListInfo;
  }

  async function getListFields(listId: string) {
    const body = await json<{ fields: ClickUpField[] }>(`/list/${idPart(listId)}/field`);
    return body.fields ?? [];
  }

  async function createTask(listId: string, input: ClickUpTaskWrite) {
    return json<ClickUpTask>(`/list/${idPart(listId)}/task`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async function updateTask(taskId: string, input: ClickUpTaskWrite): Promise<ClickUpTask | null> {
    const response = await request(`/task/${idPart(taskId)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new ClickUpError(await errorMessage(response), response.status);
    return (await response.json()) as ClickUpTask;
  }

  async function getTask(taskId: string): Promise<ClickUpTask | null> {
    const response = await request(`/task/${idPart(taskId)}?include_markdown_description=true`);
    if (response.status === 404) return null;
    if (!response.ok) throw new ClickUpError(await errorMessage(response), response.status);
    return (await response.json()) as ClickUpTask;
  }

  async function setCustomField(taskId: string, fieldId: string, value: unknown) {
    await json<unknown>(`/task/${idPart(taskId)}/field/${idPart(fieldId)}`, {
      method: "POST",
      body: JSON.stringify({ value }),
    });
  }

  async function teamTasks(query: { teamId: string; listIds: string[]; updatedAfter: number; page: number }) {
    const params = new URLSearchParams();
    for (const id of query.listIds) params.append("list_ids[]", id);
    params.set("date_updated_gt", String(Math.max(0, Math.floor(query.updatedAfter))));
    params.set("include_closed", "true");
    params.set("subtasks", "true");
    params.set("include_markdown_description", "true");
    params.set("order_by", "updated");
    params.set("page", String(query.page));
    const body = await json<{ tasks: ClickUpTask[]; last_page?: boolean }>(
      `/team/${idPart(query.teamId)}/task?${params.toString()}`,
    );
    const tasks = body.tasks ?? [];
    return {
      tasks,
      lastPage: typeof body.last_page === "boolean" ? body.last_page : tasks.length < TEAM_TASKS_PAGE_SIZE,
    };
  }

  async function createWebhook(
    teamId: string,
    input: { endpoint: string; events: string[]; space_id?: number; list_id?: number },
  ) {
    const body = await json<{ id: string; webhook: ClickUpWebhook }>(`/team/${idPart(teamId)}/webhook`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    return { id: String(body.id ?? body.webhook?.id), secret: body.webhook?.secret ?? null };
  }

  async function listWebhooks(teamId: string) {
    const body = await json<{ webhooks: ClickUpWebhook[] }>(`/team/${idPart(teamId)}/webhook`);
    return body.webhooks ?? [];
  }

  async function deleteWebhook(webhookId: string) {
    const response = await request(`/webhook/${idPart(webhookId)}`, { method: "DELETE" });
    if (response.status === 404) return false;
    if (!response.ok) throw new ClickUpError(await errorMessage(response), response.status);
    return true;
  }

  return {
    getUser,
    getTeams,
    getSpaces,
    getFolders,
    getFolderLists,
    getFolderlessLists,
    hierarchy,
    getList,
    getListFields,
    createTask,
    updateTask,
    getTask,
    setCustomField,
    teamTasks,
    createWebhook,
    listWebhooks,
    deleteWebhook,
  };
}

export type ClickUpClient = ReturnType<typeof clickupClient>;

export function signClickUpWebhook(secret: string, body: string) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function verifyClickUpSignature(secret: string, body: string, signature: string | null) {
  if (!signature) return false;
  const given = signature.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(given)) return false;
  const expected = Buffer.from(signClickUpWebhook(secret, body), "hex");
  return timingSafeEqual(expected, Buffer.from(given, "hex"));
}

export function isClickUpId(value: string) {
  return /^[A-Za-z0-9_-]{1,100}$/.test(value);
}
