import { create } from "zustand";
import {
  DocsError,
  type CreateInput,
  type DocsNav,
  type DocsSeed,
  type Folder,
  type NoteTitle,
  type Page,
  type PageFilter,
  type PageSort,
  type PageSummary,
  type Participant,
  type SaveResult,
  type ShareTarget,
  type Visibility,
} from "@/lib/docs/client-types";
import { docsData, refreshDocsActivity, resetDocsConnection } from "@/lib/docs/connection";
import { clearDraft, readDraft, setDraftScope, writeDraft } from "@/lib/docs/drafts";
import { entryCount, excerptFrom, parseTags, rewriteLinkTitle, wordCount } from "@/lib/docs/markdown";
import { listKey } from "@/lib/docs/routes";
import { viewerParticipant } from "@/lib/docs/participants";

export type SaveStatus = "saved" | "pending" | "saving" | "offline" | "error" | "conflict";
export type Rail = "details" | "history";
export type Notice = { id: number; message: string; tone: "status" | "alert"; undo?: () => void };
export type VisibilityPrompt = {
  kind: "page" | "folder";
  id: string;
  name: string;
  destination: string;
  after: Visibility;
  retry: () => Promise<void>;
};

type DocsState = {
  ready: boolean;
  now: string;
  viewer: Participant | null;
  nav: DocsNav | null;
  summaries: Record<string, PageSummary>;
  pages: Record<string, Page>;
  lists: Record<string, string[]>;
  sort: PageSort;
  recent: string[];
  activity: Record<string, Participant[]>;
  titles: Record<string, string>;
  noteTitles: NoteTitle[];
  saves: Record<string, { status: SaveStatus; message?: string }>;
  epochs: Record<string, number>;
  fresh: string | null;
  rail: Rail | null;
  railChosen: boolean;
  focus: boolean;
  notice: Notice | null;
  conflicts: Record<string, Page>;
  visibilityPrompt: VisibilityPrompt | null;
  init: (seed: DocsSeed, nav: DocsNav) => void;
  seed: (initial: { list: PageFilter; summaries: PageSummary[]; page: Page | null }) => void;
  loadList: (list: PageFilter, force?: boolean) => Promise<string[]>;
  loadPage: (id: string, force?: boolean) => Promise<Page | null>;
  prefetch: (ids: string[]) => void;
  refreshNav: () => Promise<void>;
  refreshAfterAgent: () => void;
  refreshTitles: () => Promise<void>;
  editLocal: (id: string, title: string, body: string) => void;
  replaceBody: (page: Page) => void;
  setSave: (id: string, status: SaveStatus, message?: string) => void;
  visit: (id: string) => void;
  createNote: (input?: CreateInput) => Promise<Page | null>;
  openDaily: (date: string) => Promise<Page | null>;
  move: (id: string, folderId: string | null, allowVisibilityChange?: boolean) => Promise<void>;
  share: (target: ShareTarget, visibility: Visibility) => Promise<string | null>;
  archive: (id: string) => Promise<void>;
  setAssistantCanEdit: (id: string, value: boolean) => Promise<void>;
  createFolder: (name: string, parentId: string | null) => Promise<Folder | null>;
  renameFolder: (id: string, name: string) => Promise<string | null>;
  moveFolder: (id: string, parentId: string | null, position: number, allowVisibilityChange?: boolean) => Promise<void>;
  resolveConflict: (id: string, keep: "mine" | "theirs") => void;
  closeVisibilityPrompt: () => void;
  restoreVersion: (pageId: string, versionId: string) => Promise<string | null>;
  setSort: (sort: PageSort) => void;
  setRail: (rail: Rail | null) => void;
  setFocus: (focus: boolean) => void;
  notify: (message: string, options?: { tone?: "status" | "alert"; undo?: () => void }) => void;
  dismissNotice: () => void;
  clearFresh: () => void;
};

type NoteText = { title: string; body: string };
type Acknowledged = NoteText & { revision: number; daily: boolean };
type Queued = NoteText & { renamedFrom: string | null };
type Reader = () => NoteText;

const RECENT_KEY = "orbit-docs-recent";
const SAVE_DELAY_MS = 500;
const UNSAVED = "Your latest changes haven't saved yet, so nothing was restored. Try again once they have.";

let noticeId = 0;
let session = 0;
let scope: string | null = null;
let stopActivity: (() => void) | null = null;
let clock: ReturnType<typeof setInterval> | null = null;
const listRequests = new Map<string, Promise<string[]>>();
const pageRequests = new Map<string, Promise<Page | null>>();
const readers = new Map<string, Reader>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const queued = new Map<string, Queued>();
const inflight = new Set<string>();
const running = new Map<string, Promise<void>>();
const retries = new Map<string, number>();
const overwrites = new Set<string>();
const acked = new Map<string, Acknowledged>();
const uncertain = new Map<string, NoteText>();
const resetHandlers = new Set<() => void>();

export function docsScope(seed: Pick<DocsSeed, "workspaceId" | "viewer">) {
  return `${seed.workspaceId}:${seed.viewer.id}`;
}

function recentKey() {
  return scope ? `${RECENT_KEY}:${scope}` : null;
}

function readRecent() {
  const key = recentKey();
  if (!key) return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(0, 20) : [];
  } catch {
    return [];
  }
}

function summaryFrom(page: Page): PageSummary {
  return {
    id: page.id,
    kind: page.kind,
    title: page.title,
    snippet: page.snippet,
    folderId: page.folderId,
    dailyDate: page.dailyDate,
    visibility: page.visibility,
    shared: page.shared,
    owner: page.owner,
    tags: page.tags,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    updatedBy: page.updatedBy,
    wordCount: page.wordCount,
    entryCount: page.entryCount,
  };
}

function message(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function sameText(left: NoteText, right: NoteText, daily: boolean) {
  return left.body === right.body && (daily || left.title === right.title);
}

function acknowledgedFrom(page: Page): Acknowledged {
  return { revision: page.revision, title: page.title, body: page.body, daily: page.kind === "daily" };
}

function blank() {
  return {
    ready: false,
    now: new Date(0).toISOString(),
    viewer: null,
    nav: null,
    summaries: {},
    pages: {},
    lists: {},
    sort: "edited" as PageSort,
    recent: [],
    activity: {},
    titles: {},
    noteTitles: [],
    saves: {},
    epochs: {},
    fresh: null,
    rail: null,
    railChosen: false,
    focus: false,
    notice: null,
    conflicts: {},
    visibilityPrompt: null,
  };
}

export const useDocsStore = create<DocsState>((set, get) => ({
  ...blank(),

  init(seed, nav) {
    prepareDocs(seed);
    if (get().ready) return;
    const current = session;
    set({ ready: true, now: seed.now, viewer: viewerParticipant(seed.viewer), nav, recent: readRecent() });
    const start = () => {
      if (current !== session) return;
      void get().refreshTitles();
      stopActivity = docsData().watchActivity((activity, revisions = {}) => {
        if (current !== session) return;
        set({ activity });
        const state = get();
        for (const [id, revision] of Object.entries(revisions)) {
          const page = state.pages[id];
          if (!page || page.revision >= revision || !idle(id)) continue;
          void docsData()
            .getPage(id)
            .then((fresh) => {
              if (current === session && fresh && idle(id)) get().replaceBody(fresh);
            })
            .catch(() => {});
        }
      });
    };
    if (window.location.pathname.startsWith("/docs")) start();
    else if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(start, { timeout: 3000 });
    else setTimeout(start, 1500);
    if (clock) clearInterval(clock);
    clock = setInterval(() => set({ now: new Date().toISOString() }), 30_000);
  },

  seed({ list, summaries, page }) {
    const state = get();
    const key = `${listKey(list)}|${state.sort}`;
    const nextSummaries = { ...state.summaries };
    for (const summary of summaries) if (!nextSummaries[summary.id]) nextSummaries[summary.id] = summary;
    const pages = page && !state.pages[page.id] ? { ...state.pages, [page.id]: page } : state.pages;
    if (page && !nextSummaries[page.id]) nextSummaries[page.id] = summaryFrom(page);
    set({
      summaries: nextSummaries,
      pages,
      lists: state.lists[key] ? state.lists : { ...state.lists, [key]: summaries.map((summary) => summary.id) },
    });
  },

  async loadList(list, force = false) {
    const key = `${listKey(list)}|${get().sort}`;
    const cached = get().lists[key];
    if (cached && !force) return cached;
    const running = listRequests.get(key);
    if (running && !force) return running;
    const current = session;
    const request = docsData()
      .listPages(list, get().sort)
      .then((rows) => {
        const ids = rows.map((row) => row.id);
        if (current !== session) return ids;
        set((state) => {
          const summaries = { ...state.summaries };
          for (const row of rows) summaries[row.id] = row;
          return { summaries, lists: { ...state.lists, [key]: ids } };
        });
        return ids;
      })
      .finally(() => {
        if (listRequests.get(key) === request) listRequests.delete(key);
      });
    listRequests.set(key, request);
    return request;
  },

  async loadPage(id, force = false) {
    const cached = get().pages[id];
    if (cached && !force) return cached;
    const running = pageRequests.get(id);
    if (running && !force) return running;
    const current = session;
    const request = docsData()
      .getPage(id)
      .then((page) => {
        if (current !== session) return page;
        if (page) {
          if (idle(id)) acked.delete(id);
          set((state) => ({ pages: { ...state.pages, [id]: page }, summaries: { ...state.summaries, [id]: summaryFrom(page) } }));
        }
        return page;
      })
      .finally(() => {
        if (pageRequests.get(id) === request) pageRequests.delete(id);
      });
    pageRequests.set(id, request);
    return request;
  },

  prefetch(ids) {
    for (const id of ids) if (!get().pages[id] && !pageRequests.has(id)) void get().loadPage(id).catch(() => {});
  },

  async refreshNav() {
    const current = session;
    const nav = await docsData()
      .nav()
      .catch(() => null);
    if (!nav || current !== session) return;
    if (JSON.stringify(nav) !== JSON.stringify(get().nav)) set({ nav });
  },

  refreshAfterAgent() {
    if (!get().ready) return;
    set({ lists: {} });
    refreshDocsActivity();
    void get().refreshNav();
    void get().refreshTitles();
  },

  async refreshTitles() {
    const current = session;
    const [titles, noteTitles] = await Promise.all([
      docsData()
        .resolveTitles()
        .catch(() => null),
      docsData()
        .noteTitles()
        .catch(() => null),
    ]);
    if (current !== session) return;
    if (noteTitles && JSON.stringify(noteTitles) !== JSON.stringify(get().noteTitles)) set({ noteTitles });
    if (!titles) return;
    const known = get().titles;
    const keys = Object.keys(titles);
    if (keys.length === Object.keys(known).length && keys.every((key) => known[key] === titles[key])) return;
    set({ titles });
  },

  editLocal(id, title, body) {
    set((state) => {
      const page = state.pages[id];
      const summary = state.summaries[id] ?? (page ? summaryFrom(page) : null);
      if (!summary) return {};
      const updatedAt = new Date().toISOString();
      const nextSummary: PageSummary = {
        ...summary,
        title,
        snippet: excerptFrom(body),
        tags: parseTags(body),
        wordCount: wordCount(body),
        entryCount: entryCount(body),
        updatedAt,
        updatedBy: state.viewer ?? summary.updatedBy,
      };
      return {
        summaries: { ...state.summaries, [id]: nextSummary },
        pages: page ? { ...state.pages, [id]: { ...page, ...nextSummary, body } } : state.pages,
        now: updatedAt > state.now ? updatedAt : state.now,
      };
    });
  },

  replaceBody(page) {
    acked.set(page.id, acknowledgedFrom(page));
    uncertain.delete(page.id);
    set((state) => ({
      pages: { ...state.pages, [page.id]: page },
      summaries: { ...state.summaries, [page.id]: summaryFrom(page) },
      epochs: { ...state.epochs, [page.id]: (state.epochs[page.id] ?? 0) + 1 },
    }));
  },

  setSave(id, status, text) {
    set((state) => (state.saves[id]?.status === status && state.saves[id]?.message === text ? {} : { saves: { ...state.saves, [id]: { status, message: text } } }));
  },

  visit(id) {
    const recent = [id, ...get().recent.filter((item) => item !== id)].slice(0, 20);
    set({ recent });
    const key = recentKey();
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify(recent));
    } catch {}
  },

  async createNote(input = {}) {
    const current = session;
    try {
      const page = await docsData().createPage(input);
      if (current !== session) return null;
      set((state) => {
        const lists = { ...state.lists };
        for (const key of Object.keys(lists)) {
          const [list] = key.split("|");
          if (list === "all" || (input.folderId && list === `folder:${input.folderId}`)) lists[key] = [page.id, ...lists[key]];
        }
        return { pages: { ...state.pages, [page.id]: page }, summaries: { ...state.summaries, [page.id]: summaryFrom(page) }, lists, fresh: input.title ? state.fresh : page.id };
      });
      void get().refreshNav();
      void get().refreshTitles();
      return page;
    } catch (error) {
      get().notify(message(error, "Could not create the note."), { tone: "alert" });
      return null;
    }
  },

  async openDaily(date) {
    const current = session;
    try {
      const page = await docsData().dailyNote(date);
      if (current !== session) return null;
      set((state) => ({ pages: state.pages[page.id] ? state.pages : { ...state.pages, [page.id]: page }, summaries: { ...state.summaries, [page.id]: state.summaries[page.id] ?? summaryFrom(page) } }));
      return get().pages[page.id] ?? page;
    } catch (error) {
      get().notify(message(error, "Could not open the daily note."), { tone: "alert" });
      return null;
    }
  },

  async move(id, folderId, allowVisibilityChange = false) {
    try {
      const page = await docsData().movePage(id, folderId, { allowVisibilityChange });
      set((state) => ({ pages: { ...state.pages, [id]: { ...(state.pages[id] ?? page), folderId: page.folderId, shared: page.shared } }, summaries: { ...state.summaries, [id]: { ...summaryFrom(page), updatedAt: state.summaries[id]?.updatedAt ?? page.updatedAt } }, lists: {} }));
      await get().refreshNav();
      const folder = get().nav?.folders.find((item) => item.id === folderId);
      get().notify(folder ? `Moved to ${folder.name}.` : "Moved out of its folder.");
    } catch (error) {
      if (error instanceof DocsError && error.code === "visibility_change") {
        const folder = get().nav?.folders.find((item) => item.id === folderId);
        set({
          visibilityPrompt: {
            kind: "page",
            id,
            name: get().summaries[id]?.title || "Untitled",
            destination: folder?.name ?? "no folder",
            after: error.details?.after === "private" ? "private" : "shared",
            retry: () => get().move(id, folderId, true),
          },
        });
        return;
      }
      get().notify(message(error, "Could not move the note."), { tone: "alert" });
    }
  },

  async share(target, visibility) {
    const current = session;
    try {
      await docsData().share(target, visibility);
      const ids = affectedBy(target);
      const fresh = await Promise.all(ids.map((id) => docsData().getPage(id).catch(() => null)));
      if (current !== session) return null;
      set((state) => {
        const pages = { ...state.pages };
        const summaries = { ...state.summaries };
        for (const page of fresh) {
          if (!page) continue;
          if (pages[page.id]) pages[page.id] = { ...pages[page.id], visibility: page.visibility, shared: page.shared };
          summaries[page.id] = { ...(summaries[page.id] ?? summaryFrom(page)), visibility: page.visibility, shared: page.shared };
        }
        return { pages, summaries, lists: {} };
      });
      await get().refreshNav();
      return null;
    } catch (error) {
      return message(error, "Could not change who can see this.");
    }
  },

  async archive(id) {
    const title = get().summaries[id]?.title || "Untitled";
    await settleSaves(id);
    try {
      await docsData().archivePage(id);
      set((state) => {
        const lists: Record<string, string[]> = {};
        for (const [key, ids] of Object.entries(state.lists)) lists[key] = ids.filter((item) => item !== id);
        const summaries = { ...state.summaries };
        delete summaries[id];
        return { lists, summaries, recent: state.recent.filter((item) => item !== id) };
      });
      void get().refreshNav();
      void get().refreshTitles();
      get().notify(`Archived ${title}.`, {
        undo: () => {
          void docsData()
            .restorePage(id)
            .then((page) => {
              if (idle(id)) acked.delete(id);
              set((state) => ({ summaries: { ...state.summaries, [id]: summaryFrom(page) }, pages: { ...state.pages, [id]: page }, lists: {} }));
              void get().refreshNav();
              void get().refreshTitles();
              get().notify(`Restored ${title}.`);
            })
            .catch((error: unknown) => get().notify(message(error, `Could not restore ${title}.`), { tone: "alert" }));
        },
      });
    } catch (error) {
      get().notify(message(error, "Could not archive the note."), { tone: "alert" });
    }
  },

  async setAssistantCanEdit(id, value) {
    try {
      const page = await docsData().setAssistantCanEdit(id, value);
      set((state) => ({ pages: { ...state.pages, [id]: { ...(state.pages[id] ?? page), assistantCanEdit: page.assistantCanEdit } } }));
    } catch (error) {
      get().notify(message(error, "Could not change the setting."), { tone: "alert" });
    }
  },

  async createFolder(name, parentId) {
    try {
      const folder = await docsData().createFolder(name, parentId);
      await get().refreshNav();
      return folder;
    } catch (error) {
      get().notify(message(error, "Could not create the folder."), { tone: "alert" });
      return null;
    }
  },

  async renameFolder(id, name) {
    try {
      await docsData().renameFolder(id, name);
      await get().refreshNav();
      return null;
    } catch (error) {
      return message(error, "Could not rename the folder.");
    }
  },

  async moveFolder(id, parentId, position, allowVisibilityChange = false) {
    try {
      const folders = await docsData().moveFolder(id, parentId, position, { allowVisibilityChange });
      const nav = get().nav;
      if (nav) set({ nav: { ...nav, folders } });
      set({ lists: {} });
      if (allowVisibilityChange) await get().refreshNav();
    } catch (error) {
      if (error instanceof DocsError && error.code === "visibility_change") {
        const folders = get().nav?.folders ?? [];
        set({
          visibilityPrompt: {
            kind: "folder",
            id,
            name: folders.find((item) => item.id === id)?.name ?? "This folder",
            destination: folders.find((item) => item.id === parentId)?.name ?? "the top level",
            after: error.details?.after === "private" ? "private" : "shared",
            retry: () => get().moveFolder(id, parentId, position, true),
          },
        });
        return;
      }
      get().notify(message(error, "Could not move the folder."), { tone: "alert" });
    }
  },

  resolveConflict(id, keep) {
    const latest = get().conflicts[id];
    if (!latest) return;
    set((state) => {
      const conflicts = { ...state.conflicts };
      delete conflicts[id];
      return { conflicts };
    });
    if (keep === "theirs") {
      queued.delete(id);
      readers.delete(id);
      overwrites.delete(id);
      clearTimer(timers, id);
      clearTimer(retryTimers, id);
      clearDraft(id);
      get().replaceBody(latest);
      get().setSave(id, "saved");
      return;
    }
    acked.set(id, acknowledgedFrom(latest));
    overwrites.add(id);
    void flush(id);
  },

  closeVisibilityPrompt() {
    set({ visibilityPrompt: null });
  },

  async restoreVersion(pageId, versionId) {
    await settleSaves(pageId);
    if (unsaved(pageId)) return UNSAVED;
    try {
      const page = await docsData().restoreVersion(pageId, versionId);
      get().replaceBody(page);
      get().notify("Restored. The version you replaced is in the history.");
      return null;
    } catch (error) {
      return message(error, "Could not restore that version.");
    }
  },

  setSort(sort) {
    set({ sort });
  },

  setRail(rail) {
    set({ rail, railChosen: true });
  },

  setFocus(focus) {
    set({ focus });
  },

  notify(text, options = {}) {
    noticeId += 1;
    set({ notice: { id: noticeId, message: text, tone: options.tone ?? "status", undo: options.undo } });
  },

  dismissNotice() {
    set({ notice: null });
  },

  clearFresh() {
    set({ fresh: null });
  },
}));

function clearTimer(map: Map<string, ReturnType<typeof setTimeout>>, id: string) {
  const timer = map.get(id);
  if (timer) clearTimeout(timer);
  map.delete(id);
}

function idle(id: string) {
  const state = useDocsStore.getState();
  const status = state.saves[id]?.status;
  return !readers.has(id) && !queued.has(id) && !inflight.has(id) && !state.conflicts[id] && (!status || status === "saved");
}

function unsaved(id: string) {
  return readers.has(id) || queued.has(id) || inflight.has(id) || Boolean(useDocsStore.getState().conflicts[id]);
}

function affectedBy(target: ShareTarget) {
  const state = useDocsStore.getState();
  if (target.kind === "page") return [target.id];
  const folders = state.nav?.folders ?? [];
  const inside = new Set([target.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of folders) {
      if (folder.parentId && inside.has(folder.parentId) && !inside.has(folder.id)) {
        inside.add(folder.id);
        grew = true;
      }
    }
  }
  return Object.values(state.pages)
    .filter((page) => page.folderId && inside.has(page.folderId))
    .map((page) => page.id);
}

function baseFor(id: string) {
  const known = acked.get(id);
  if (known) return known;
  const page = useDocsStore.getState().pages[id];
  if (!page) return null;
  const base = acknowledgedFrom(page);
  acked.set(id, base);
  return base;
}

function resetSession() {
  session += 1;
  stopActivity?.();
  stopActivity = null;
  if (clock) clearInterval(clock);
  clock = null;
  for (const timer of [...timers.values(), ...retryTimers.values()]) clearTimeout(timer);
  for (const map of [timers, retryTimers, readers, queued, running, retries, acked, uncertain, listRequests, pageRequests]) map.clear();
  inflight.clear();
  overwrites.clear();
  for (const handler of resetHandlers) handler();
  resetDocsConnection();
  useDocsStore.setState(blank());
}

export function prepareDocs(seed: Pick<DocsSeed, "workspaceId" | "viewer">) {
  if (typeof window === "undefined") return;
  const next = docsScope(seed);
  if (scope === next) return;
  if (scope !== null) resetSession();
  scope = next;
  setDraftScope(next);
}

export function onDocsReset(handler: () => void) {
  resetHandlers.add(handler);
  return () => {
    resetHandlers.delete(handler);
  };
}

export function adoptDraft(page: Page, draft: { baseRevision: number }) {
  acked.set(page.id, { ...acknowledgedFrom(page), revision: draft.baseRevision });
}

export function scheduleSave(id: string, read: Reader, delay = SAVE_DELAY_MS) {
  readers.set(id, read);
  const store = useDocsStore.getState();
  if (store.saves[id]?.status !== "pending") store.setSave(id, "pending");
  clearTimer(timers, id);
  timers.set(
    id,
    setTimeout(() => void commitNow(id), delay),
  );
}

export function commitNow(id: string, keepalive = false): Promise<void> {
  clearTimer(timers, id);
  const read = readers.get(id);
  if (!read) return inflight.has(id) ? (running.get(id) ?? Promise.resolve()) : Promise.resolve();
  const store = useDocsStore.getState();
  const base = baseFor(id);
  if (!base) {
    const current = session;
    void store
      .loadPage(id)
      .then(() => {
        if (current === session && readers.get(id) === read) void commitNow(id, keepalive);
      })
      .catch(() => store.setSave(id, "offline", "Offline. Your changes are kept on this device."));
    return Promise.resolve();
  }
  readers.delete(id);
  const { title, body } = read();
  if (sameText(base, { title, body }, base.daily) && !queued.has(id) && !inflight.has(id)) {
    if (!store.conflicts[id]) {
      clearDraft(id);
      store.setSave(id, "saved");
    }
    return Promise.resolve();
  }
  const earlier = queued.get(id)?.renamedFrom ?? null;
  const renamedFrom = earlier ?? (!base.daily && base.title.trim() && base.title !== title ? base.title : null);
  writeDraft(id, { title, body, baseRevision: base.revision, at: Date.now() });
  store.editLocal(id, title, body);
  queued.set(id, { title, body, renamedFrom });
  return flush(id, keepalive);
}

export function commitAll(keepalive = false) {
  for (const id of [...readers.keys()]) void commitNow(id, keepalive);
}

export async function settleSaves(id: string) {
  await commitNow(id);
  while (inflight.has(id)) {
    const task = running.get(id);
    if (!task) break;
    await task;
  }
}

function flush(id: string, keepalive = false): Promise<void> {
  if (inflight.has(id)) return running.get(id) ?? Promise.resolve();
  if (useDocsStore.getState().conflicts[id]) return Promise.resolve();
  const next = queued.get(id);
  if (!next) return Promise.resolve();
  const base = baseFor(id);
  if (!base) return Promise.resolve();
  clearTimer(retryTimers, id);
  queued.delete(id);
  inflight.add(id);
  const task = send(id, next, base, keepalive);
  running.set(id, task);
  return task;
}

function settled(id: string) {
  inflight.delete(id);
  running.delete(id);
}

async function send(id: string, next: Queued, base: Acknowledged, keepalive: boolean): Promise<void> {
  const current = session;
  useDocsStore.getState().setSave(id, "saving");
  let result: SaveResult;
  try {
    result = await docsData().savePage(
      id,
      { ...(base.daily ? {} : { title: next.title }), body: next.body, baseRevision: base.revision, ...(overwrites.has(id) ? { overwrite: true } : {}) },
      { keepalive },
    );
  } catch {
    if (current !== session) return;
    settled(id);
    if (!queued.has(id)) queued.set(id, next);
    uncertain.set(id, next);
    const attempt = (retries.get(id) ?? 0) + 1;
    retries.set(id, attempt);
    useDocsStore.getState().setSave(id, "offline", "Offline. Your changes are kept on this device.");
    retryTimers.set(
      id,
      setTimeout(() => void flush(id), Math.min(30_000, 1_000 * 2 ** attempt)),
    );
    return;
  }
  if (current !== session) return;
  settled(id);
  retries.delete(id);
  if (result.ok) return acknowledge(id, next, base, result.page);
  const latest = result.conflict;
  if (latest) {
    const attempt = uncertain.get(id);
    uncertain.delete(id);
    if (sameText(next, latest, base.daily)) return acknowledge(id, next, base, latest);
    if (attempt && sameText(attempt, latest, base.daily)) {
      acked.set(id, { ...acknowledgedFrom(latest), daily: base.daily });
      if (!queued.has(id)) queued.set(id, next);
      return flush(id);
    }
    if (!queued.has(id)) queued.set(id, next);
    overwrites.delete(id);
    useDocsStore.setState((state) => ({ conflicts: { ...state.conflicts, [id]: latest } }));
    useDocsStore.getState().setSave(id, "conflict", result.error);
    return;
  }
  uncertain.delete(id);
  const newer = queued.has(id);
  if (!newer) queued.set(id, next);
  useDocsStore.getState().setSave(id, "error", result.error);
  if (newer) return flush(id);
}

function acknowledge(id: string, sent: Queued, previous: Acknowledged, saved: Page): Promise<void> {
  overwrites.delete(id);
  uncertain.delete(id);
  acked.set(id, { revision: saved.revision, title: sent.title, body: sent.body, daily: previous.daily });
  const draft = readDraft(id);
  if (draft && (draft.body !== sent.body || draft.title !== sent.title)) writeDraft(id, { ...draft, baseRevision: saved.revision });
  else clearDraft(id);
  const navChanged = parseTags(previous.body).join(" ") !== saved.tags.join(" ");
  const titleChanged = previous.title !== saved.title;
  const renamedFrom = sent.renamedFrom && sent.renamedFrom !== saved.title ? sent.renamedFrom : null;
  useDocsStore.setState((state) => {
    const current = state.pages[id];
    const page = current ? { ...current, revision: saved.revision, updatedAt: saved.updatedAt, shared: saved.shared } : saved;
    return { pages: { ...state.pages, [id]: page }, summaries: { ...state.summaries, [id]: { ...summaryFrom(page), snippet: saved.snippet, tags: saved.tags, title: saved.title } } };
  });
  const store = useDocsStore.getState();
  if (titleChanged) void store.refreshTitles();
  if (renamedFrom) refreshLinked(id, renamedFrom, saved.title);
  if (navChanged || saved.kind === "daily") void store.refreshNav();
  if (queued.has(id)) return flush(id);
  if (!readers.has(id)) store.setSave(id, "saved");
  return Promise.resolve();
}

function refreshLinked(renamedId: string, from: string, to: string) {
  const current = session;
  for (const page of Object.values(useDocsStore.getState().pages)) {
    if (page.id === renamedId || !idle(page.id) || rewriteLinkTitle(page.body, from, to).count === 0) continue;
    void docsData()
      .getPage(page.id)
      .then((fresh) => {
        if (current === session && fresh && idle(page.id)) useDocsStore.getState().replaceBody(fresh);
      })
      .catch(() => {});
  }
}

export function retryOfflineSaves() {
  for (const id of [...queued.keys()]) void flush(id);
}
