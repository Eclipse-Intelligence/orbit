"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Button from "@/components/_ui/button";
import { Kbd } from "@/components/_ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/_ui/dropdown-menu";
import { tagBase } from "@/components/beautifui/record-marks";
import SectionHeader from "@/components/crm/section-header";
import type { Viewer } from "@/components/crm/viewer";
import {
  cachedList,
  cachedThread,
  fetchList,
  fetchNav,
  forgetOtherLists,
  forgetThread,
  loadThread,
  postAction,
  prefetchThreads,
  storeList,
  storeThread,
  syncNow,
  type ListQuery,
  type ThreadPage,
} from "@/components/mail/mail-cache";
import ThreadList from "@/components/mail/thread-list";
import ThreadReader, { type ReaderAction } from "@/components/mail/thread-reader";
import { useComposer } from "@/components/mail/compose-dock";
import { useShortcut } from "@/components/shortcuts/shortcuts-provider";
import type { ComposeAccount, MailNav, ThreadDetail, ThreadSummary } from "@/lib/mail/view";
import { cn } from "@/lib/utils";
import { useCompaniesStore } from "@/stores/companies-store";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import SearchIcon from "@/public/assets/images/_common/search.svg";
import FolderIcon from "@/public/assets/images/mail/folder.svg";
import RefreshIcon from "@/public/assets/images/mail/refresh.svg";

const VIEWS = [
  { id: "inbox", label: "Inbox" },
  { id: "sent", label: "Sent" },
  { id: "drafts", label: "Drafts" },
  { id: "archive", label: "Archive" },
  { id: "trash", label: "Trash" },
] as const;

const MOVES = new Set<ReaderAction>(["archive", "trash", "inbox"]);
const DONE_LABEL: Record<string, string> = { archive: "Archived.", trash: "Moved to Trash.", inbox: "Moved to Inbox." };
const POLL_MS = 60_000;
const FIRST_POLL_MS = 12_000;
const MIN_POLL_GAP_MS = 20_000;
const READ_DWELL_MS = 700;

type Toast = { message: string; tone: "status" | "alert"; undo?: () => void };

function MailOverscroll() {
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.overscrollBehaviorX;
    root.style.overscrollBehaviorX = "none";
    document.body.style.overscrollBehaviorX = "none";
    return () => {
      root.style.overscrollBehaviorX = previous;
      document.body.style.overscrollBehaviorX = "";
    };
  }, []);
  return null;
}

function mailUrl(query: ListQuery, thread: string | null) {
  const params = new URLSearchParams();
  if (query.query) params.set("q", query.query);
  else if (query.view !== "inbox") params.set("view", query.view);
  if (query.account) params.set("account", query.account);
  if (thread) params.set("thread", thread);
  const text = params.toString();
  return text ? `/mail?${text}` : "/mail";
}

function insertByDate(threads: ThreadSummary[], thread: ThreadSummary) {
  if (threads.some((item) => item.key === thread.key)) return threads;
  const index = threads.findIndex((item) => (item.latestAt ?? "") < (thread.latestAt ?? ""));
  return index === -1 ? [...threads, thread] : [...threads.slice(0, index), thread, ...threads.slice(index)];
}

function patchDetail(detail: ThreadDetail, action: ReaderAction): ThreadDetail {
  const last = detail.messages.length - 1;
  return {
    ...detail,
    messages: detail.messages.map((message, index) => {
      if (action === "read") return { ...message, isRead: true };
      if (action === "unread" && index === last) return { ...message, isRead: false };
      if (action === "flag" && index === last) return { ...message, isFlagged: true };
      if (action === "unflag") return { ...message, isFlagged: false };
      return message;
    }),
  };
}

function patchSummary(thread: ThreadSummary, action: ReaderAction): ThreadSummary {
  if (action === "read" || action === "unread") return { ...thread, unread: action === "unread" };
  if (action === "flag" || action === "unflag") return { ...thread, flagged: action === "flag" };
  return thread;
}

function shiftUnread(nav: MailNav, sourceId: string, change: number): MailNav {
  return {
    ...nav,
    unread: Math.max(0, nav.unread + change),
    accounts: nav.accounts.map((account) => (account.id === sourceId ? { ...account, unread: Math.max(0, account.unread + change) } : account)),
  };
}

export default function MailScreen({
  viewer,
  initialNav,
  initialQuery,
  initialPage,
  initialThread,
  initialNow,
  accounts,
}: {
  viewer: Viewer;
  accounts: ComposeAccount[];
  initialNav: MailNav;
  initialQuery: ListQuery;
  initialPage: ThreadPage;
  initialThread: ThreadDetail | null;
  initialNow: number;
}) {
  const { openComposer, sent: sentCount } = useComposer();
  const setMailUnread = useCompaniesStore((state) => state.setMailUnread);
  const [nav, setNav] = useState(initialNav);
  const [query, setQuery] = useState(initialQuery);
  const [page, setPage] = useState<ThreadPage | null>(initialPage);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(initialThread?.key ?? null);
  const [open, setOpen] = useState(Boolean(initialThread));
  const [details, setDetails] = useState<Record<string, ThreadDetail>>(initialThread ? { [initialThread.key]: initialThread } : {});
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
  const [search, setSearch] = useState(initialQuery.query);
  const [toast, setToast] = useState<Toast | null>(null);
  const [now, setNow] = useState(initialNow);
  const [syncing, setSyncing] = useState(false);
  const request = useRef(0);
  const removing = useRef(new Set<string>());
  const keptUnread = useRef(new Set<string>());
  const loadingMore = useRef(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const latest = useRef({ query, page, cursor });

  useEffect(() => {
    latest.current = { query, page, cursor };
  });

  useEffect(() => {
    if (page) storeList(query, page);
  }, [page, query]);

  useEffect(() => {
    setMailUnread(nav.unread);
  }, [nav.unread, setMailUnread]);

  useEffect(() => {
    if (initialThread) storeThread(initialThread);
    prefetchThreads(initialPage.threads.slice(0, 4).map((thread) => thread.key));
  }, [initialPage, initialThread]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), toast.undo ? 6000 : 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const threads = page?.threads ?? [];
  const current = threads.find((thread) => thread.key === cursor) ?? null;
  const detail = cursor ? (details[cursor] ?? null) : null;
  const viewParam = query.query ? "search" : query.view;
  const own = nav.accounts.map((account) => account.email).concat(viewer.email);
  const folders = nav.folders.filter((folder) => folder.role === "other" && (!query.account || folder.sourceId === query.account));
  const activeFolder = query.view.startsWith("folder:") ? nav.folders.find((folder) => `folder:${folder.id}` === query.view) : null;
  const accountLabel = nav.accounts.find((account) => account.id === query.account)?.email ?? "All accounts";

  function writeUrl(next: ListQuery, thread: string | null) {
    window.history.replaceState(window.history.state, "", mailUrl(next, thread));
  }

  function pull(key: string) {
    const hit = cachedThread(key);
    if (hit) setDetails((existing) => (existing[key] === hit ? existing : { ...existing, [key]: hit }));
    return hit;
  }

  function fetchDetail(key: string, fresh = false) {
    loadThread(key, fresh)
      .then((loaded) => {
        setDetails((existing) => ({ ...existing, [key]: loaded }));
        setDetailErrors((existing) => {
          if (!(key in existing)) return existing;
          const next = { ...existing };
          delete next[key];
          return next;
        });
      })
      .catch((error: Error) => setDetailErrors((existing) => ({ ...existing, [key]: error.message })));
  }

  function select(key: string | null, show = false) {
    keptUnread.current.clear();
    setCursor(key);
    if (show) setOpen(true);
    writeUrl(latest.current.query, key);
    if (!key) return;
    if (!pull(key)) fetchDetail(key);
    const list = latest.current.page?.threads ?? [];
    const index = list.findIndex((thread) => thread.key === key);
    prefetchThreads([list[index + 1], list[index + 2], list[index - 1]].filter(Boolean).map((thread) => thread!.key));
  }

  function show(next: ListQuery) {
    const token = ++request.current;
    setQuery(next);
    setCursor(null);
    setOpen(false);
    setListError(null);
    setPage(cachedList(next));
    setLoading(true);
    writeUrl(next, null);
    fetchList(next)
      .then((fresh) => {
        storeList(next, fresh);
        if (token !== request.current) return;
        setPage(fresh);
        prefetchThreads(fresh.threads.slice(0, 4).map((thread) => thread.key));
      })
      .catch((error: Error) => {
        if (token === request.current) setListError(error.message);
      })
      .finally(() => {
        if (token === request.current) setLoading(false);
      });
  }

  function refresh(sync: boolean) {
    const target = latest.current.query;
    const token = request.current;
    setSyncing(true);
    (sync ? syncNow().catch(() => null) : Promise.resolve(null))
      .then(() => Promise.all([fetchList(target), fetchNav()]))
      .then(([fresh, freshNav]) => {
        setNav(freshNav);
        setNow(Date.now());
        if (token !== request.current) return;
        const hidden = new Set(removing.current);
        for (const thread of fresh.threads) {
          const cached = cachedThread(thread.key);
          if (cached && !cached.messages.some((message) => message.id === thread.latestId)) {
            forgetThread(thread.key);
            if (thread.key === latest.current.cursor) fetchDetail(thread.key, true);
          }
        }
        setPage((existing) => {
          const keys = new Set(fresh.threads.map((thread) => thread.key));
          const oldest = fresh.threads[fresh.threads.length - 1]?.latestAt ?? "";
          const tail = (existing?.threads ?? []).filter((thread) => !keys.has(thread.key) && (thread.latestAt ?? "") < oldest);
          return {
            threads: [...fresh.threads, ...tail].filter((thread) => !hidden.has(thread.key)),
            next: tail.length > 0 ? (existing?.next ?? fresh.next) : fresh.next,
          };
        });
      })
      .catch(() => null)
      .finally(() => setSyncing(false));
  }

  function more() {
    const { page: currentPage, query: target } = latest.current;
    if (!currentPage?.next || loadingMore.current) return;
    loadingMore.current = true;
    const token = request.current;
    setLoading(true);
    fetchList(target, currentPage.next)
      .then((older) => {
        if (token !== request.current) return;
        setPage((existing) => ({
          threads: [...(existing?.threads ?? []), ...older.threads.filter((thread) => !existing?.threads.some((item) => item.key === thread.key))],
          next: older.next,
        }));
      })
      .catch((error: Error) => setToast({ message: error.message, tone: "alert" }))
      .finally(() => {
        loadingMore.current = false;
        if (token === request.current) setLoading(false);
      });
  }

  function restore(thread: ThreadSummary, from: string) {
    setPage((existing) => (existing ? { ...existing, threads: insertByDate(existing.threads, thread) } : existing));
    if (thread.unread && from === "inbox") setNav((existing) => shiftUnread(existing, thread.sourceId, 1));
  }

  function act(key: string, action: ReaderAction, quiet = false) {
    const { page: currentPage, query: target } = latest.current;
    const thread = currentPage?.threads.find((item) => item.key === key);
    if (!thread) return;
    const from = target.query ? "search" : target.view;
    if (MOVES.has(action)) {
      const list = currentPage!.threads;
      const index = list.findIndex((item) => item.key === key);
      const remaining = list.filter((item) => item.key !== key);
      removing.current.add(key);
      setPage({ ...currentPage!, threads: remaining });
      if (thread.unread && from === "inbox") setNav((existing) => shiftUnread(existing, thread.sourceId, -1));
      if (latest.current.cursor === key) {
        const next = remaining[index] ?? remaining[index - 1] ?? null;
        select(next?.key ?? null);
        setOpen(false);
      }
      forgetOtherLists(target);
      postAction(key, action, from)
        .then(() => {
          const undo =
            from === "inbox" && action !== "inbox"
              ? () => {
                  restore(thread, from);
                  setToast(null);
                  postAction(key, "inbox", action === "archive" ? "archive" : "trash")
                    .then(() => forgetOtherLists(latest.current.query))
                    .catch((error: Error) => setToast({ message: error.message, tone: "alert" }));
                }
              : undefined;
          setToast({ message: DONE_LABEL[action], tone: "status", undo });
          fetchNav().then(setNav).catch(() => null);
        })
        .catch((error: Error) => {
          restore(thread, from);
          setToast({ message: error.message, tone: "alert" });
        })
        .finally(() => removing.current.delete(key));
      return;
    }
    if (action === "unread") keptUnread.current.add(key);
    const change = action === "read" && thread.unread ? -1 : action === "unread" && !thread.unread ? 1 : 0;
    setPage((existing) => (existing ? { ...existing, threads: existing.threads.map((item) => (item.key === key ? patchSummary(item, action) : item)) } : existing));
    setDetails((existing) => (existing[key] ? { ...existing, [key]: patchDetail(existing[key], action) } : existing));
    const cached = cachedThread(key);
    if (cached) storeThread(patchDetail(cached, action));
    if (change && from === "inbox") setNav((existing) => shiftUnread(existing, thread.sourceId, change));
    const undoAction: ReaderAction = action === "read" ? "unread" : action === "unread" ? "read" : action === "flag" ? "unflag" : "flag";
    postAction(key, action, from)
      .then(() => {
        if (!quiet) fetchNav().then(setNav).catch(() => null);
      })
      .catch((error: Error) => {
        setPage((existing) => (existing ? { ...existing, threads: existing.threads.map((item) => (item.key === key ? patchSummary(item, undoAction) : item)) } : existing));
        forgetThread(key);
        fetchDetail(key, true);
        if (change && from === "inbox") setNav((existing) => shiftUnread(existing, thread.sourceId, -change));
        setToast({ message: error.message, tone: "alert" });
      });
  }

  function sent(key: string) {
    setToast({ message: "Sent.", tone: "status" });
    window.setTimeout(() => {
      forgetThread(key);
      refreshRef.current(true);
      window.setTimeout(() => {
        if (latest.current.cursor === key) fetchDetail(key, true);
      }, 9000);
    }, 2500);
  }

  const actRef = useRef(act);
  useEffect(() => {
    actRef.current = act;
  });
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });

  useEffect(() => {
    if (!cursor || !current?.unread || keptUnread.current.has(cursor)) return;
    const key = cursor;
    const timer = window.setTimeout(() => actRef.current(key, "read", true), READ_DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [cursor, current?.unread]);

  useEffect(() => {
    if (sentCount === 0) return;
    const timer = window.setTimeout(() => refreshRef.current(true), 2500);
    return () => window.clearTimeout(timer);
  }, [sentCount]);

  useEffect(() => {
    let last = 0;
    const tick = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < MIN_POLL_GAP_MS) return;
      last = Date.now();
      refreshRef.current(true);
    };
    const first = window.setTimeout(tick, FIRST_POLL_MS);
    const timer = window.setInterval(tick, POLL_MS);
    window.addEventListener("focus", tick);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
    };
  }, []);

  function step(delta: number) {
    if (threads.length === 0) return;
    const index = threads.findIndex((thread) => thread.key === cursor);
    const nextIndex = index === -1 ? (delta > 0 ? 0 : threads.length - 1) : Math.min(threads.length - 1, Math.max(0, index + delta));
    if (delta > 0 && nextIndex >= threads.length - 5) more();
    select(threads[nextIndex].key);
  }

  function primaryMove() {
    if (query.view === "archive" && !query.query) return "inbox" as const;
    return "archive" as const;
  }

  useShortcut("list-down", () => step(1));
  useShortcut("list-down-arrow", () => step(1));
  useShortcut("list-up", () => step(-1));
  useShortcut("list-up-arrow", () => step(-1));
  useShortcut("list-open", () => {
    if (!cursor) return false;
    setOpen(true);
  });
  useShortcut("back", () => {
    if (!open) return false;
    setOpen(false);
  });
  useShortcut("mail-archive", () => {
    if (!cursor) return false;
    act(cursor, primaryMove());
  });
  useShortcut("mail-trash", () => {
    if (!cursor || (query.view === "trash" && !query.query)) return false;
    act(cursor, "trash");
  });
  useShortcut("mail-read", () => {
    if (!current) return false;
    act(current.key, current.unread ? "read" : "unread");
  });
  useShortcut("mail-flag", () => {
    if (!current) return false;
    act(current.key, current.flagged ? "unflag" : "flag");
  });
  useShortcut("mail-undo", () => {
    if (!toast?.undo) return false;
    toast.undo();
  });
  useShortcut("mail-refresh", () => refresh(true));
  useShortcut("search-list", () => {
    searchInput.current?.focus();
    searchInput.current?.select();
  });

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    const text = search.trim();
    if (text === query.query) return;
    show({ ...query, query: text, view: text ? query.view : query.view });
    searchInput.current?.blur();
  }

  function clearSearch() {
    setSearch("");
    if (query.query) show({ ...query, query: "" });
  }

  const empty = query.query
    ? `No emails match “${query.query}”.`
    : query.view === "inbox"
      ? "Inbox zero. Nothing is waiting for you."
      : activeFolder
        ? `${activeFolder.name} is empty.`
        : `Nothing in ${VIEWS.find((view) => view.id === query.view)?.label ?? "this folder"}.`;

  if (nav.accounts.length === 0) {
    return (
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <SectionHeader title="Mail" viewer={viewer} />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <h2>Bring your mail into Orbit</h2>
          <p className="text-subtle max-w-[28em]">Connect Microsoft in Capture. Orbit copies every folder and keeps it in step with Outlook.</p>
          <Button variant="primary" href="/capture">
            Connect Microsoft
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 touch-pan-y flex-col overscroll-x-none">
      <MailOverscroll />
      <SectionHeader
        title="Mail"
        viewer={viewer}
        action={
          <>
            <Button variant="primary" onClick={() => openComposer()} title="Write an email (C then M)">
              Compose
            </Button>
            {nav.accounts.length > 1 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="secondary" aria-label={`Account: ${accountLabel}`} className="max-w-[16em]">
                    {query.account && <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: tagBase(accountLabel) }} />}
                    <span className="truncate">{accountLabel}</span>
                    <ChevronDownIcon aria-hidden className="text-subtle size-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[15rem]">
                  <DropdownMenuLabel>Show mail from</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={query.account ?? "all"}
                    onValueChange={(value) => {
                      const account = value === "all" ? null : value;
                      const folderGone = activeFolder && account && activeFolder.sourceId !== account;
                      show({ ...query, account, view: folderGone ? "inbox" : query.view });
                    }}
                  >
                    <DropdownMenuRadioItem value="all">
                      <span className="flex-1">All accounts</span>
                      {nav.unread > 0 && <span className="text-subtle tabular-nums">{nav.unread}</span>}
                    </DropdownMenuRadioItem>
                    {nav.accounts.map((account) => (
                      <DropdownMenuRadioItem key={account.id} value={account.id}>
                        <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: tagBase(account.email) }} />
                        <span className="min-w-0 flex-1 truncate">{account.email}</span>
                        {account.unread > 0 && <span className="text-subtle tabular-nums">{account.unread}</span>}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Button
              variant="secondary"
              size="icon"
              aria-label="Check for new mail"
              title="Check for new mail (Shift R)"
              onClick={() => refresh(true)}
              disabled={syncing}
            >
              <RefreshIcon aria-hidden className={cn("size-3.5", syncing && "animate-spin [animation-direction:reverse]")} />
            </Button>
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className={cn("min-h-0 w-full flex-col lg:flex lg:w-[25rem] lg:shrink-0 xl:w-[29rem]", open ? "hidden" : "flex")}>
          <div className="flex shrink-0 flex-col gap-2 px-3 pt-3 pb-2">
            <form role="search" onSubmit={submitSearch} className="relative">
              <label htmlFor="mail-search" className="sr-only">
                Search mail
              </label>
              <SearchIcon aria-hidden className="text-subtle pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2" />
              <input
                ref={searchInput}
                id="mail-search"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && search) {
                    event.preventDefault();
                    clearSearch();
                  }
                }}
                placeholder="Search all mail"
                autoComplete="off"
                className="placeholder:text-subtle text-foreground ease-power3-out h-9 w-full rounded-xl bg-white/[0.04] pr-10 pl-9 text-[14px] transition-colors duration-150 outline-none focus:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-ring/40 [&::-webkit-search-cancel-button]:hidden"
              />
              {search ? (
                <button
                  type="button"
                  onClick={clearSearch}
                  aria-label="Clear search"
                  className="text-subtle hover:text-foreground absolute top-1/2 right-2 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full outline-none hover:bg-white/6 focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  <svg aria-hidden width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
                    <path d="M6 6 18 18M18 6 6 18" />
                  </svg>
                </button>
              ) : (
                <Kbd aria-hidden className="absolute top-1/2 right-2 -translate-y-1/2">
                  /
                </Kbd>
              )}
            </form>
            <nav aria-label="Mail folders" className="-mx-1 flex items-center gap-0.5 overflow-x-auto px-1 [scrollbar-width:none]">
              {VIEWS.map((view) => {
                const active = !query.query && query.view === view.id;
                const count = view.id === "inbox" ? (query.account ? nav.accounts.find((account) => account.id === query.account)?.unread : nav.unread) : 0;
                return (
                  <button
                    key={view.id}
                    type="button"
                    onClick={() => show({ ...query, view: view.id, query: "" })}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "ease-power3-out flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 text-[13px] transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                      active ? "text-foreground bg-white/[0.07]" : "text-subtle hover:text-foreground hover:bg-white/[0.035]",
                    )}
                  >
                    {view.label}
                    {Boolean(count) && <span className="text-soft tabular-nums">{count}</span>}
                  </button>
                );
              })}
              {folders.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-current={activeFolder ? "page" : undefined}
                      className={cn(
                        "ease-power3-out flex h-8 max-w-[12em] shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-[13px] transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                        activeFolder && !query.query ? "text-foreground bg-white/[0.07]" : "text-subtle hover:text-foreground hover:bg-white/[0.035]",
                      )}
                    >
                      <FolderIcon aria-hidden className="size-3.5 shrink-0" />
                      <span className="truncate">{activeFolder && !query.query ? activeFolder.name : "Folders"}</span>
                      <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-[14rem]">
                    <DropdownMenuRadioGroup value={query.query ? "" : query.view} onValueChange={(value) => show({ ...query, view: value, query: "" })}>
                      {folders.map((folder) => (
                        <DropdownMenuRadioItem key={folder.id} value={`folder:${folder.id}`}>
                          <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                          {!query.account && nav.accounts.length > 1 && (
                            <span
                              aria-label={nav.accounts.find((account) => account.id === folder.sourceId)?.email}
                              className="size-1.5 shrink-0 rounded-full"
                              style={{ background: tagBase(nav.accounts.find((account) => account.id === folder.sourceId)?.email ?? "") }}
                            />
                          )}
                          {folder.unread > 0 && <span className="text-subtle tabular-nums">{folder.unread}</span>}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </nav>
            {query.query && (
              <p role="status" className="caption-style text-subtle px-1">
                {loading && threads.length === 0 ? "Searching…" : `Results for “${query.query}” across every folder${query.account ? ` in ${accountLabel}` : ""}.`}
              </p>
            )}
          </div>
          <div className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-x-none">
            {listError && threads.length === 0 ? (
              <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
                <p role="alert" className="text-danger">
                  {listError}
                </p>
                <Button variant="secondary" onClick={() => show(query)}>
                  Try again
                </Button>
              </div>
            ) : (
              <ThreadList
                threads={threads}
                cursor={cursor}
                outgoing={!query.query && (query.view === "sent" || query.view === "drafts")}
                showAccount={!query.account && nav.accounts.length > 1}
                own={own}
                now={now}
                loading={loading}
                more={Boolean(page?.next)}
                empty={empty}
                onOpen={(key) => select(key, true)}
                onHover={(key) => prefetchThreads([key])}
                onMore={more}
                swipe={
                  !query.query && query.view === "drafts"
                    ? null
                    : {
                        leftLabel: primaryMove() === "inbox" ? "Inbox" : "Archive",
                        restore: primaryMove() === "inbox",
                        onLeft: (key) => act(key, primaryMove()),
                        onRight: (key) => {
                          const thread = threads.find((item) => item.key === key);
                          if (thread) act(key, thread.unread ? "read" : "unread");
                        },
                      }
                }
              />
            )}
          </div>
        </div>
        <div className={cn("min-h-0 min-w-0 flex-1 flex-col lg:my-2 lg:mr-2 lg:flex lg:rounded-2xl lg:bg-white/[0.02]", open ? "flex" : "hidden")}>
          <ThreadReader
            key={cursor ?? "none"}
            summary={current}
            detail={detail}
            error={cursor ? (detailErrors[cursor] ?? null) : null}
            own={own}
            view={viewParam}
            accounts={accounts}
            onAction={(action) => cursor && act(cursor, action)}
            onBack={() => setOpen(false)}
            onNext={() => step(1)}
            onSent={() => cursor && sent(cursor)}
          />
        </div>
      </div>
      {toast && (
        <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-4">
          <div
            role={toast.tone}
            className="bg-popover border-line-strong shadow-overlay animate-rise-in pointer-events-auto flex items-center gap-3 rounded-full border py-1.5 pr-1.5 pl-4 text-[13px]"
          >
            <span className={toast.tone === "alert" ? "text-danger" : "text-foreground"}>{toast.message}</span>
            {toast.undo ? (
              <Button variant="ghost" size="sm" onClick={toast.undo} title="Undo (Z)">
                Undo
              </Button>
            ) : (
              <span aria-hidden className="w-2" />
            )}
          </div>
        </div>
      )}
    </section>
  );
}
