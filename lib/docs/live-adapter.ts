import {
  archiveDocAction,
  createDocAction,
  createFolderAction,
  moveDocAction,
  moveFolderAction,
  renameDocAction,
  renameFolderAction,
  restoreDocAction,
  restoreVersionAction,
  setAssistantCanEditAction,
  shareDocsAction,
} from "@/app/(crm)/docs/actions";
import {
  DocsError,
  type ActivityListener,
  type Backlinks,
  type DailySummary,
  type DocsData,
  type DocsNav,
  type Folder,
  type LinkTarget,
  type Meeting,
  type NoteTitle,
  type Page,
  type PageSummary,
  type Participant,
  type RecordRef,
  type SaveResult,
  type SearchHit,
  type SearchResults,
  type Version,
  type VersionBody,
} from "@/lib/docs/client-types";
import type { DocsActionResult } from "@/lib/docs/http";

type Options = { recordSearch?: (query: string) => Promise<RecordRef[]> };

type ActivityState = { activity: Record<string, Participant[]>; revisions: Record<string, number> };

const ACTIVITY_POLL_MS = 20_000;
const OFFLINE = "Docs couldn't reach Orbit. Check your connection and try again.";

async function failure(response: Response) {
  const payload = (await response.json().catch(() => null)) as { error?: string; code?: string; details?: Record<string, unknown> | null } | null;
  return new DocsError(payload?.error || (response.status === 401 ? "Your session ended. Sign in again." : "Docs didn't respond. Try again in a moment."), payload?.code ?? String(response.status), payload?.details ?? null);
}

async function getJson<T>(url: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  } catch {
    throw new DocsError(OFFLINE, "offline");
  }
  if (!response.ok) throw await failure(response);
  return (await response.json()) as T;
}

async function postJson<T>(url: string, method: "POST" | "PUT", body: unknown, keepalive = false) {
  return fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin", keepalive }).then(async (response) => {
    if (!response.ok) throw await failure(response);
    return (await response.json()) as T;
  });
}

function unwrap<T>(result: DocsActionResult<T>): T {
  if (result.error !== undefined) throw new DocsError(result.error, result.code ?? "error", result.details ?? null);
  return result.data;
}

function query(values: Record<string, string | number | null | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== null && value !== undefined && value !== "") params.set(key, String(value));
  const text = params.toString();
  return text ? `?${text}` : "";
}

function activityPoller() {
  const listeners = new Set<(state: ActivityState) => void>();
  let latest: ActivityState = { activity: {}, revisions: {} };
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function poll() {
    if (running || document.visibilityState !== "visible" || !window.location.pathname.startsWith("/docs")) return;
    running = true;
    try {
      latest = await getJson<ActivityState>("/api/docs/activity");
      for (const listener of listeners) listener(latest);
    } catch {
    } finally {
      running = false;
    }
  }

  function onVisible() {
    if (document.visibilityState === "visible") void poll();
  }

  return {
    subscribe(listener: (state: ActivityState) => void) {
      listeners.add(listener);
      listener(latest);
      if (!timer) {
        timer = setInterval(() => void poll(), ACTIVITY_POLL_MS);
        document.addEventListener("visibilitychange", onVisible);
        void poll();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer) {
          clearInterval(timer);
          timer = null;
          document.removeEventListener("visibilitychange", onVisible);
        }
      };
    },
    refresh: poll,
  };
}

export function createLiveDocs(options: Options = {}): DocsData & { refreshActivity: () => Promise<void> } {
  const activity = activityPoller();

  return {
    nav: () => getJson<DocsNav>("/api/docs/nav"),
    listPages(filter, sort = "edited") {
      const params =
        filter.kind === "folder"
          ? { list: "folder", folder: filter.folderId }
          : filter.kind === "tag"
            ? { list: "tag", tag: filter.path }
            : filter.kind === "search"
              ? { list: "search", q: filter.query }
              : { list: filter.kind };
      return getJson<PageSummary[]>(`/api/docs/pages${query({ ...params, sort })}`);
    },
    recent: (limit = 8) => getJson<PageSummary[]>(`/api/docs/recent${query({ limit })}`),
    search: (text) => getJson<SearchResults>(`/api/docs/search${query({ q: text })}`),
    async getPage(id) {
      try {
        return await getJson<Page>(`/api/docs/pages/${encodeURIComponent(id)}`);
      } catch (error) {
        if (error instanceof DocsError && error.code === "not_found") return null;
        throw error;
      }
    },
    async savePage(id, input, saveOptions = {}): Promise<SaveResult> {
      let response: Response;
      try {
        response = await fetch(`/api/docs/pages/${encodeURIComponent(id)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
          credentials: "same-origin",
          keepalive: saveOptions.keepalive === true && input.body.length < 60_000,
        });
      } catch {
        throw new DocsError(OFFLINE, "offline");
      }
      const payload = (await response.json().catch(() => null)) as { page?: Page | null; error?: string; code?: string } | null;
      if (response.ok && payload?.page) return { ok: true, page: payload.page };
      if (response.status === 409 && payload?.code === "conflict") return { ok: false, error: payload.error ?? "Someone else changed this note.", conflict: payload.page ?? undefined };
      if (response.status >= 500 || response.status === 0) throw new DocsError(payload?.error ?? OFFLINE, "offline");
      return { ok: false, error: payload?.error ?? "Couldn't save. Your changes are kept on this device." };
    },
    createPage: async (input) => unwrap(await createDocAction(input)),
    renamePage: async (id, title) => unwrap(await renameDocAction(id, title)).page,
    movePage: async (id, folderId, moveOptions = {}) => unwrap(await moveDocAction(id, folderId, moveOptions.allowVisibilityChange === true)),
    async archivePage(id) {
      unwrap(await archiveDocAction(id));
    },
    restorePage: async (id) => unwrap(await restoreDocAction(id)),
    setAssistantCanEdit: async (id, value) => unwrap(await setAssistantCanEditAction(id, value)),
    createFolder: async (name, parentId) => unwrap(await createFolderAction(name, parentId)) as Folder,
    renameFolder: async (id, name) => unwrap(await renameFolderAction(id, name)),
    moveFolder: async (id, parentId, position, moveOptions = {}) => unwrap(await moveFolderAction(id, parentId, position, moveOptions.allowVisibilityChange === true)),
    async share(target, visibility) {
      unwrap(await shareDocsAction(target, visibility));
    },
    listVersions: (pageId) => getJson<Version[]>(`/api/docs/pages/${encodeURIComponent(pageId)}/versions`),
    versionBody: (pageId, versionId) => getJson<VersionBody>(`/api/docs/pages/${encodeURIComponent(pageId)}/versions/${encodeURIComponent(versionId)}`),
    restoreVersion: async (pageId, versionId) => unwrap(await restoreVersionAction(pageId, versionId)),
    dailyNote: (date) => postJson<Page>(`/api/docs/daily/${encodeURIComponent(date)}`, "POST", {}),
    listDailyNotes: () => getJson<DailySummary[]>("/api/docs/daily"),
    meetingsOn: (date) => getJson<Meeting[]>(`/api/docs/meetings${query({ date })}`).catch(() => []),
    backlinks: (pageId) => getJson<Backlinks>(`/api/docs/pages/${encodeURIComponent(pageId)}/backlinks`),
    linkTargets: (text, fromPageId) => getJson<LinkTarget[]>(`/api/docs/link-targets${query({ q: text, from: fromPageId })}`),
    resolveTitles: () => getJson<Record<string, string>>("/api/docs/titles"),
    noteTitles: () => getJson<NoteTitle[]>("/api/docs/note-titles"),
    recordMentions: (record) => getJson<SearchHit[]>(`/api/docs/mentioning${query({ kind: record.kind, id: record.id })}`),
    searchRecords: async (text) => (options.recordSearch ? options.recordSearch(text).catch(() => []) : []),
    async recordDetails(refs) {
      if (refs.length === 0) return [];
      const found = await getJson<RecordRef[]>(`/api/docs/records${query({ refs: refs.map((ref) => `${ref.kind}:${ref.id}`).join(",") })}`).catch(() => [] as RecordRef[]);
      const byId = new Map(found.map((record) => [record.id, record]));
      return refs.map((ref) => {
        const record = byId.get(ref.id);
        return { kind: ref.kind, id: ref.id, name: record?.name || ref.name, detail: record?.detail ?? null };
      });
    },
    watchPresence(pageId, listener) {
      return activity.subscribe((state) => {
        const writers = state.activity[pageId] ?? [];
        listener(writers.map((participant) => ({ participant, cursor: null, writing: true })));
      });
    },
    watchActivity(listener: ActivityListener) {
      return activity.subscribe((state) => listener(state.activity, state.revisions));
    },
    refreshActivity: activity.refresh,
  };
}
