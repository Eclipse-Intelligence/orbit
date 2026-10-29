import { create } from "zustand";
import {
  DocsError,
  type CreateInput,
  type DocsNav,
  type DocsSeed,
  type Folder,
  type Page,
  type PageFilter,
  type PageSort,
  type PageSummary,
  type Participant,
  type ShareTarget,
  type Visibility,
} from "@/lib/docs/client-types";
import { docsData, refreshDocsActivity } from "@/lib/docs/connection";
import { clearDraft, writeDraft } from "@/lib/docs/drafts";
import { entryCount, excerptFrom, parseTags, wordCount } from "@/lib/docs/markdown";
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
  saves: Record<string, { status: SaveStatus; message?: string }>;
  epochs: Record<string, number>;
  staleEpoch: number;
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
  invalidateOthers: (keepId: string) => void;
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

const RECENT_KEY = "orbit-docs-recent";
const SAVE_DELAY_MS = 500;

function readRecent() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
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

let noticeId = 0;
const listRequests = new Map<string, Promise<string[]>>();
const pageRequests = new Map<string, Promise<Page | null>>();

export const useDocsStore = create<DocsState>((set, get) => ({
  ready: false,
  now: new Date(0).toISOString(),
  viewer: null,
  nav: null,
  summaries: {},
  pages: {},
  lists: {},
  sort: "edited",
  recent: [],
  activity: {},
  titles: {},
  saves: {},
  epochs: {},
  staleEpoch: 0,
  fresh: null,
  rail: null,
  railChosen: false,
  focus: false,
  notice: null,
  conflicts: {},
  visibilityPrompt: null,

  init(seed, nav) {
    if (get().ready) return;
    set({ ready: true, now: seed.now, viewer: viewerParticipant(seed.viewer), nav, recent: readRecent() });
    const start = () => {
      void get().refreshTitles();
      docsData().watchActivity((activity, revisions = {}) => {
        set({ activity });
        const state = get();
        for (const [id, revision] of Object.entries(revisions)) {
          const page = state.pages[id];
          const status = state.saves[id]?.status;
          if (!page || page.revision >= revision || readers.has(id) || queued.has(id) || inflight.has(id) || (status && status !== "saved")) continue;
          void docsData()
            .getPage(id)
            .then((fresh) => {
              if (fresh && !readers.has(id) && !queued.has(id) && !inflight.has(id)) get().replaceBody(fresh);
            })
            .catch(() => {});
        }
      });
    };
    if (window.location.pathname.startsWith("/docs")) start();
    else if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(start, { timeout: 3000 });
    else setTimeout(start, 1500);
    window.setInterval(() => set({ now: new Date().toISOString() }), 30_000);
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
    const request = docsData()
      .listPages(list, get().sort)
      .then((rows) => {
        const ids = rows.map((row) => row.id);
        set((state) => {
          const summaries = { ...state.summaries };
          for (const row of rows) summaries[row.id] = row;
          return { summaries, lists: { ...state.lists, [key]: ids } };
        });
        return ids;
      })
      .finally(() => listRequests.delete(key));
    listRequests.set(key, request);
    return request;
  },

  async loadPage(id, force = false) {
    const cached = get().pages[id];
    if (cached && !force) return cached;
    const running = pageRequests.get(id);
    if (running && !force) return running;
    const request = docsData()
      .getPage(id)
      .then((page) => {
        if (page) set((state) => ({ pages: { ...state.pages, [id]: page }, summaries: { ...state.summaries, [id]: summaryFrom(page) } }));
        return page;
      })
      .finally(() => pageRequests.delete(id));
    pageRequests.set(id, request);
    return request;
  },

  prefetch(ids) {
    for (const id of ids) if (!get().pages[id] && !pageRequests.has(id)) void get().loadPage(id).catch(() => {});
  },

  async refreshNav() {
    const nav = await docsData()
      .nav()
      .catch(() => null);
    if (!nav) return;
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
    const titles = await docsData()
      .resolveTitles()
      .catch(() => null);
    if (!titles) return;
    const current = get().titles;
    const keys = Object.keys(titles);
    if (keys.length === Object.keys(current).length && keys.every((key) => current[key] === titles[key])) return;
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
    set((state) => ({
      pages: { ...state.pages, [page.id]: page },
      summaries: { ...state.summaries, [page.id]: summaryFrom(page) },
      epochs: { ...state.epochs, [page.id]: (state.epochs[page.id] ?? 0) + 1 },
    }));
  },

  invalidateOthers(keepId) {
    set((state) => ({ pages: state.pages[keepId] ? { [keepId]: state.pages[keepId] } : {}, staleEpoch: state.staleEpoch + 1 }));
  },

  setSave(id, status, text) {
    set((state) => (state.saves[id]?.status === status && state.saves[id]?.message === text ? {} : { saves: { ...state.saves, [id]: { status, message: text } } }));
  },

  visit(id) {
    const recent = [id, ...get().recent.filter((item) => item !== id)].slice(0, 20);
    set({ recent });
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    } catch {}
  },

  async createNote(input = {}) {
    try {
      const page = await docsData().createPage(input);
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
    try {
      const page = await docsData().dailyNote(date);
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
    try {
      await docsData().share(target, visibility);
      const ids = Object.keys(get().pages);
      const fresh = await Promise.all(ids.map((id) => docsData().getPage(id)));
      set((state) => {
        const pages = { ...state.pages };
        const summaries = { ...state.summaries };
        for (const page of fresh) {
          if (!page) continue;
          pages[page.id] = { ...page, body: state.pages[page.id]?.body ?? page.body, title: state.pages[page.id]?.title ?? page.title };
          summaries[page.id] = { ...summaryFrom(page), title: summaries[page.id]?.title ?? page.title, snippet: summaries[page.id]?.snippet ?? page.snippet, updatedAt: summaries[page.id]?.updatedAt ?? page.updatedAt };
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
    commitNow(id);
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
      const timer = timers.get(id);
      if (timer) clearTimeout(timer);
      timers.delete(id);
      clearDraft(id);
      get().replaceBody(latest);
      get().setSave(id, "saved");
      return;
    }
    set((state) => ({ pages: state.pages[id] ? { ...state.pages, [id]: { ...state.pages[id], revision: latest.revision } } : state.pages }));
    overwrites.add(id);
    void flush(id, false);
  },

  closeVisibilityPrompt() {
    set({ visibilityPrompt: null });
  },

  async restoreVersion(pageId, versionId) {
    commitNow(pageId);
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

type Reader = () => { title: string; body: string };

const readers = new Map<string, Reader>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const queued = new Map<string, { title: string; body: string; baseRevision: number; renamedFrom: string | null }>();
const inflight = new Set<string>();
const retries = new Map<string, number>();
const overwrites = new Set<string>();

export function scheduleSave(id: string, read: Reader, delay = SAVE_DELAY_MS) {
  readers.set(id, read);
  const store = useDocsStore.getState();
  if (store.saves[id]?.status !== "pending") store.setSave(id, "pending");
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.set(id, setTimeout(() => commitNow(id), delay));
}

export function commitNow(id: string, keepalive = false) {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  const read = readers.get(id);
  if (!read) return;
  readers.delete(id);
  const { title, body } = read();
  const store = useDocsStore.getState();
  const page = store.pages[id];
  if (page && page.title === title && page.body === body && !queued.has(id) && !inflight.has(id)) {
    store.setSave(id, "saved");
    return;
  }
  const baseRevision = page?.revision ?? 0;
  const earlier = queued.get(id)?.renamedFrom ?? null;
  const renamedFrom = earlier ?? (page && page.kind === "note" && page.title.trim() && page.title !== title ? page.title : null);
  writeDraft(id, { title, body, baseRevision, at: Date.now() });
  store.editLocal(id, title, body);
  queued.set(id, { title, body, baseRevision, renamedFrom });
  void flush(id, keepalive);
}

export function commitAll(keepalive = false) {
  for (const id of [...readers.keys()]) commitNow(id, keepalive);
}

async function flush(id: string, keepalive: boolean) {
  if (inflight.has(id) || useDocsStore.getState().conflicts[id]) return;
  const next = queued.get(id);
  if (!next) return;
  queued.delete(id);
  inflight.add(id);
  const store = useDocsStore.getState();
  store.setSave(id, "saving");
  const baseRevision = store.pages[id]?.revision ?? next.baseRevision;
  const daily = store.pages[id]?.kind === "daily";
  let result;
  try {
    result = await docsData().savePage(
      id,
      { ...(daily ? {} : { title: next.title }), body: next.body, baseRevision, ...(overwrites.has(id) ? { overwrite: true } : {}) },
      { keepalive },
    );
  } catch {
    inflight.delete(id);
    if (!queued.has(id)) queued.set(id, next);
    const attempt = (retries.get(id) ?? 0) + 1;
    retries.set(id, attempt);
    useDocsStore.getState().setSave(id, "offline", "Offline. Your changes are kept on this device.");
    setTimeout(() => void flush(id, false), Math.min(30_000, 1_000 * 2 ** attempt));
    return;
  }
  inflight.delete(id);
  retries.delete(id);
  overwrites.delete(id);
  if (!result.ok) {
    if (result.conflict) {
      if (!queued.has(id)) queued.set(id, next);
      const latest = result.conflict;
      useDocsStore.setState((state) => ({ conflicts: { ...state.conflicts, [id]: latest } }));
      useDocsStore.getState().setSave(id, "conflict", result.error);
      return;
    }
    useDocsStore.getState().setSave(id, "error", result.error);
    return;
  }
  clearDraft(id, next);
  const before = useDocsStore.getState().summaries[id];
  const navChanged = !before || before.tags.join(" ") !== result.page.tags.join(" ");
  const renamed = Boolean(next.renamedFrom && next.renamedFrom !== result.page.title);
  useDocsStore.setState((state) => {
    const current = state.pages[id];
    const page = current ? { ...current, revision: result.page.revision, updatedAt: result.page.updatedAt, shared: result.page.shared } : result.page;
    return { pages: { ...state.pages, [id]: page }, summaries: { ...state.summaries, [id]: { ...summaryFrom(page), snippet: result.page.snippet, tags: result.page.tags, title: result.page.title } } };
  });
  const latest = useDocsStore.getState();
  if (queued.has(id)) void flush(id, false);
  else if (!readers.has(id)) latest.setSave(id, "saved");
  void latest.refreshTitles();
  if (renamed) latest.invalidateOthers(id);
  if (navChanged || result.page.kind === "daily") void latest.refreshNav();
}

export function retryOfflineSaves() {
  for (const id of [...queued.keys()]) void flush(id, false);
}
