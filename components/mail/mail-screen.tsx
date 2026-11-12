"use client";

import { Suspense, use, useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { createPortal } from "react-dom";
import Button from "@/components/_ui/button";
import FilterChip from "@/components/_ui/filter-chip";
import { Kbd } from "@/components/_ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/_ui/dropdown-menu";
import Link from "next/link";
import { tagBase } from "@/components/beautifui/record-marks";
import SectionHeader from "@/components/crm/section-header";
import type { Viewer } from "@/components/crm/viewer";
import {
  cachedList,
  cachedThread,
  dwellReadDue,
  fetchList,
  fetchNav,
  fetchScheduled,
  postSenderSplit,
  askAi,
  forgetDwellRead,
  forgetOtherLists,
  forgetThread,
  loadThread,
  noteDwellRead,
  postAction,
  prefetchThreads,
  refreshFailure,
  refreshProblem,
  restoreToList,
  sameList,
  storeList,
  storeThread,
  syncNow,
  type ListQuery,
  type ThreadPage,
} from "@/components/mail/mail-cache";
import AskPanel, { type AskState } from "@/components/mail/ask-panel";
import ScheduledList from "@/components/mail/scheduled-list";
import { setBadge } from "@/components/push/push-client";
import { useTeamUnread } from "@/components/crm/attention";
import PushPrompt from "@/components/push/push-prompt";
import ReconnectNotices, { flagReconnect, flagSyncProblems } from "@/components/mail/reconnect-notice";
import { OPEN_THREAD_EVENT } from "@/components/push/push-registrar";
import ThreadList from "@/components/mail/thread-list";
import ThreadReader, { type ReaderAction } from "@/components/mail/thread-reader";
import UnsubscribeDialog, { unsubscribeToast, type UnsubscribeDone, type UnsubscribeRequest } from "@/components/mail/unsubscribe-dialog";
import { useComposer } from "@/components/mail/compose-dock";
import { watchEdgeSwipe, type EdgeHandlers } from "@/components/mail/swipe";
import { useShortcut } from "@/components/shortcuts/shortcuts-provider";
import { laterOptions } from "@/lib/mail/later";
import { MAIL_SPLITS, SPLIT_LABELS, type MailSplit, type ComposeAccount, type ComposeIntent, type MailDraft, type MailNav, type ThreadDetail, type ThreadSummary } from "@/lib/mail/view";
import { cn } from "@/lib/utils";
import { useCompaniesStore } from "@/stores/companies-store";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import SearchIcon from "@/public/assets/images/_common/search.svg";
import SparkleIcon from "@/public/assets/images/mail/sparkle.svg";
import FolderIcon from "@/public/assets/images/mail/folder.svg";
import RefreshIcon from "@/public/assets/images/mail/refresh.svg";
import ArchiveIcon from "@/public/assets/images/mail/archive.svg";
import ComposeIcon from "@/public/assets/images/mail/compose.svg";
import ClockIcon from "@/public/assets/images/mail/clock.svg";
import InboxIcon from "@/public/assets/images/mail/inbox.svg";
import MailOpenIcon from "@/public/assets/images/mail/mail-open.svg";
import TrashIcon from "@/public/assets/images/mail/trash.svg";
import UnsubscribeIcon from "@/public/assets/images/mail/unsubscribe.svg";
import FlagIcon from "@/public/assets/images/mail/flag.svg";
import CloseIcon from "@/public/assets/images/mail/close.svg";
import { usePullToRefresh } from "@/components/mail/pull-refresh";
import MailShareLive, { useMailShareEvents } from "@/components/mail/share-live";
import { fetchSharedList } from "@/components/mail/share-client";
import SharedList from "@/components/mail/shared-list";
import SharedReader from "@/components/mail/shared-reader";
import { HOME_VIEW, SHARED_VIEW, isSharedView as sharedView, listForThread, mailUrl, sharedCountLabel, sortShared, stepShare } from "@/lib/mail/share-view";
import type { SharedThreadSummary } from "@/lib/mail/share-types";
import UsersIcon from "@/public/assets/images/companies/sidebar/users.svg";

const MORE_VIEWS = [
  { id: "inbox", label: "All inbox" },
  { id: "snoozed", label: "Snoozed" },
  { id: "scheduled", label: "Scheduled" },
  { id: "sent", label: "Sent" },
  { id: "drafts", label: "Drafts" },
  { id: "archive", label: "Archive" },
  { id: "trash", label: "Trash" },
  { id: "junk", label: "Junk" },
] as const;

function inInbox(view: string) {
  return view === "inbox" || view.startsWith("inbox:");
}

const MOVES = new Set<ReaderAction>(["archive", "trash", "inbox", "snooze"]);
const DONE_LABEL: Record<string, string> = { archive: "Archived.", trash: "Moved to Trash.", inbox: "Moved to Inbox.", snooze: "Snoozed." };
const NARROW = "(max-width: 47.99rem)";
const BACK_MS = 200;

type Motion = "open" | "back" | null;

function narrow() {
  return window.matchMedia(NARROW).matches;
}

function pushedThread() {
  const state = window.history.state as { mailThread?: string } | null;
  return Boolean(state?.mailThread);
}
const POLL_MS = 60_000;
const QUESTION = /\?\s*$|^(who|what|when|where|why|how|which|did|does|do|is|are|was|were|has|have|had|can|could|should|would|will|find|show|list|summari[sz]e|tell)\s+\S+\s+\S+/i;
const FIRST_POLL_MS = 12_000;
const MIN_POLL_GAP_MS = 20_000;
const READ_DWELL_MS = 700;


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

const QUICK_ADD_SLOT = "[data-quick-add-slot]";

function watchSlot(notify: () => void) {
  const frame = window.requestAnimationFrame(notify);
  return () => window.cancelAnimationFrame(frame);
}

function ComposeButton({ onCompose }: { onCompose: () => void }) {
  const slot = useSyncExternalStore(watchSlot, () => document.querySelector<HTMLElement>(QUICK_ADD_SLOT), () => null);
  if (!slot) return null;
  return createPortal(
    <span data-compose-fab="" className="contents md:hidden">
      <Button variant="primary" size="md" onClick={onCompose} className="pointer-events-auto h-12 gap-2 px-5 text-[14px] shadow-[0px_8px_24px_0px_rgba(0,0,0,0.45),0px_0px_0px_1px_#0e0e0e,inset_0px_4px_6px_0px_rgba(255,255,255,0.2),inset_0px_0px_0px_1px_rgba(255,255,255,0.15),inset_0px_-8px_14px_0px_rgba(0,0,0,0.15)] md:hidden">
        <ComposeIcon aria-hidden className="size-4" />
        Compose
      </Button>
    </span>,
    slot,
  );
}

type OutgoingThread = { thread: ThreadSummary | null; origin: ListQuery; left: boolean; cleared: boolean };

const UNTRACKED = { undone: () => undefined, delivered: () => undefined };

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

function shiftUnread(nav: MailNav, thread: Pick<ThreadSummary, "sourceId" | "split">, change: number): MailNav {
  const { sourceId, split } = thread;
  return {
    ...nav,
    unread: Math.max(0, nav.unread + change),
    accounts: nav.accounts.map((account) => (account.id === sourceId ? { ...account, unread: Math.max(0, account.unread + change) } : account)),
    folders: nav.folders.map((folder) => (folder.role === "inbox" && folder.sourceId === sourceId ? { ...folder, unread: Math.max(0, folder.unread + change) } : folder)),
    splits: split ? nav.splits.map((row) => (row.sourceId === sourceId && row.split === split ? { ...row, unread: Math.max(0, row.unread + change) } : row)) : nav.splits,
  };
}

const FULL_REFRESH_MS = 5 * 60_000;
const NAV_SETTLE_MS = 1_500;

function NavStream({ promise, onNav }: { promise: Promise<MailNav | null>; onNav: (nav: MailNav | null) => void }) {
  const streamed = use(promise);
  useEffect(() => onNav(streamed), [streamed, onNav]);
  return null;
}

export default function MailScreen({
  viewer,
  initialNav,
  navPromise,
  initialQuery,
  initialPage,
  initialThread,
  initialCompose = null,
  initialNow,
  accounts,
  initialShared = null,
  initialNotes = false,
  linkedShare = null,
  noMailbox = false,
}: {
  noMailbox?: boolean;
  linkedShare?: string | null;
  initialShared?: string | null;
  initialNotes?: boolean;
  viewer: Viewer;
  accounts: ComposeAccount[];
  initialNav: MailNav;
  navPromise?: Promise<MailNav | null>;
  initialQuery: ListQuery;
  initialPage: ThreadPage;
  initialThread: ThreadDetail | null;
  initialCompose?: ComposeIntent | null;
  initialNow: number;
}) {
  const { openComposer, sent: sentCount, pickLater, showToast, dismissToast, undoLatest } = useComposer();
  const [scheduled, setScheduled] = useState<MailDraft[] | null>(null);
  const [ask, setAsk] = useState<AskState | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const askToken = useRef(0);
  const setMailUnread = useCompaniesStore((state) => state.setMailUnread);
  const [nav, setNav] = useState(initialNav);
  const [query, setQuery] = useState(initialQuery);
  const [page, setPage] = useState<ThreadPage | null>(initialPage);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(initialThread?.key ?? initialShared ?? null);
  const [open, setOpen] = useState(Boolean(initialThread || initialShared));
  const [sharedList, setSharedList] = useState<SharedThreadSummary[] | null>(null);
  const [sharedError, setSharedError] = useState<string | null>(null);
  const [notesAsked, setNotesAsked] = useState(initialNotes);
  const [seenLink, setSeenLink] = useState(linkedShare);
  const [details, setDetails] = useState<Record<string, ThreadDetail>>(initialThread ? { [initialThread.key]: initialThread } : {});
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
  const [search, setSearch] = useState(initialQuery.query);
  const [now, setNow] = useState(initialNow);
  const [syncing, setSyncing] = useState(false);
  const [entered, setEntered] = useState<string | null>(null);
  const [unsubscribing, setUnsubscribing] = useState<UnsubscribeRequest | null>(null);
  const [motion, setMotion] = useState<Motion>(null);
  const [peeking, setPeeking] = useState(false);
  const request = useRef(0);
  const removing = useRef(new Set<string>());
  const sendingThreads = useRef(new Map<string, OutgoingThread[]>());
  const keptUnread = useRef(new Set<string>());
  const loadingMore = useRef(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchInputList = useRef<HTMLInputElement>(null);
  const latest = useRef({ query, page, cursor, open });
  const fullRefresh = useRef(0);
  const seenVersion = useRef(initialNav.version);
  const navTimer = useRef<number | null>(null);
  const navAccounts = useRef(nav.accounts);

  useEffect(() => {
    latest.current = { query, page, cursor, open };
    navAccounts.current = nav.accounts;
  });

  useEffect(() => {
    fullRefresh.current = Date.now();
  }, []);

  const receiveNav = useCallback((streamed: MailNav | null) => {
    const apply = (fresh: MailNav) => {
      setNav(fresh);
      seenVersion.current ??= fresh.version;
      const current = latest.current.query;
      if (current.account && !fresh.accounts.some((account) => account.id === current.account)) showRef.current({ ...current, account: null });
    };
    if (streamed) apply(streamed);
    else fetchNav().then(apply).catch(() => null);
  }, []);

  function settleNav() {
    if (navTimer.current) return;
    navTimer.current = window.setTimeout(() => {
      navTimer.current = null;
      fetchNav().then(setNav).catch(() => null);
    }, NAV_SETTLE_MS);
  }

  useEffect(() => {
    if (page) storeList(query, page);
  }, [page, query]);

  const teamUnread = useTeamUnread();
  const importantUnread = nav.splits.filter((row) => row.split === "important").reduce((sum, row) => sum + row.unread, 0);
  useEffect(() => {
    if (nav.partial) return;
    setMailUnread(importantUnread);
    setBadge(importantUnread + teamUnread);
  }, [importantUnread, teamUnread, setMailUnread, nav.partial]);

  useEffect(() => {
    if (initialThread) storeThread(initialThread);
    prefetchThreads(initialPage.threads.slice(0, 4).map((thread) => thread.key));
  }, [initialPage, initialThread]);


  const threads = page?.threads ?? [];
  const inShared = sharedView(query);
  const sharedCount = sharedList?.length ?? 0;
  const sharedTab = sharedCount > 0 || inShared;
  const mailboxless = nav.partial ? noMailbox : nav.accounts.length === 0;
  const sharedSummary = inShared && cursor ? (sharedList?.find((thread) => thread.shareId === cursor) ?? null) : null;
  const current = threads.find((thread) => thread.key === cursor) ?? null;
  const currentIndex = current ? threads.indexOf(current) : -1;
  const detail = cursor ? (details[cursor] ?? null) : null;
  const viewParam = query.query ? "search" : query.view;
  const own = nav.accounts.map((account) => account.email).concat(viewer.email, ...accounts.map((account) => account.email));
  const folders = nav.folders.filter((folder) => folder.role === "other" && (!query.account || folder.sourceId === query.account));
  const activeFolder = query.view.startsWith("folder:") ? nav.folders.find((folder) => `folder:${folder.id}` === query.view) : null;
  const moreLabel = query.query ? null : (MORE_VIEWS.find((view) => view.id === query.view)?.label ?? activeFolder?.name ?? null);
  const splitRows = nav.splits.filter((row) => !query.account || row.sourceId === query.account);
  const splitTabs = MAIL_SPLITS.map((split) => ({
    id: `inbox:${split}`,
    split,
    label: SPLIT_LABELS[split],
    total: splitRows.filter((row) => row.split === split).reduce((sum, row) => sum + row.total, 0),
    unread: splitRows.filter((row) => row.split === split).reduce((sum, row) => sum + row.unread, 0),
  })).filter((tab) => tab.split === "important" || tab.total > 0 || query.view === tab.id);
  const accountLabel =
    nav.accounts.find((account) => account.id === query.account)?.email ??
    (query.account ? (threads.find((thread) => thread.sourceId === query.account)?.account ?? "One account") : "All accounts");

  function writeUrl(next: ListQuery, thread: string | null) {
    const shown = thread && (latest.current.open || !narrow()) ? thread : null;
    window.history.replaceState(window.history.state, "", mailUrl(next, shown));
  }

  function closeReader(animate = true) {
    if (!latest.current.open) return;
    if (narrow() && pushedThread()) {
      window.history.back();
      return;
    }
    latest.current = { ...latest.current, open: false };
    setOpen(false);
    setMotion(animate ? "back" : null);
    settleReader();
    writeUrl(latest.current.query, latest.current.cursor);
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
    const opening = show && Boolean(key) && !latest.current.open;
    if (show && key) {
      latest.current = { ...latest.current, open: true };
      setOpen(true);
    }
    setMotion(opening ? "open" : null);
    if (opening && narrow()) window.history.pushState({ ...window.history.state, mailThread: key }, "", mailUrl(latest.current.query, key));
    else writeUrl(latest.current.query, key);
    if (!key || sharedView(latest.current.query)) return;
    if (!pull(key)) fetchDetail(key);
    const list = latest.current.page?.threads ?? [];
    const index = list.findIndex((thread) => thread.key === key);
    prefetchThreads([list[index + 1], list[index + 2], list[index - 1]].filter(Boolean).map((thread) => thread!.key));
  }

  const sharedToken = useRef(0);
  function loadShared() {
    const token = ++sharedToken.current;
    fetchSharedList()
      .then((list) => {
        if (token !== sharedToken.current) return;
        setSharedList(sortShared(list));
        setSharedError(null);
      })
      .catch((error: Error) => {
        if (token === sharedToken.current) setSharedError(error.message);
      });
  }

  function loadScheduled() {
    fetchScheduled()
      .then(setScheduled)
      .catch((error: Error) => showToast({ message: error.message, tone: "alert" }));
  }

  function show(next: ListQuery) {
    const token = ++request.current;
    setSelected(new Set());
    askToken.current += 1;
    setAsk(null);
    setQuery(next);
    setCursor(null);
    latest.current = { ...latest.current, query: next, cursor: null, open: false };
    setOpen(false);
    setMotion(null);
    setListError(null);
    if (next.view === "scheduled" && !next.query) {
      setPage({ threads: [], next: null });
      setLoading(false);
      writeUrl(next, null);
      loadScheduled();
      return;
    }
    if (sharedView(next)) {
      setPage({ threads: [], next: null });
      setLoading(false);
      writeUrl(next, null);
      loadShared();
      return;
    }
    const cached = cachedList(next);
    setPage(cached ? { ...cached, threads: settleSending(cached.threads) } : null);
    setLoading(true);
    writeUrl(next, null);
    fetchList(next)
      .then((fresh) => {
        storeList(next, fresh);
        if (token !== request.current) return;
        setPage({ ...fresh, threads: settleSending(fresh.threads) });
        prefetchThreads(fresh.threads.slice(0, 4).map((thread) => thread.key));
      })
      .catch((error: Error) => {
        if (token === request.current) setListError(error.message);
      })
      .finally(() => {
        if (token === request.current) setLoading(false);
      });
  }

  function refresh(sync: boolean, poll = false) {
    const target = latest.current.query;
    const token = request.current;
    loadShared();
    if (sharedView(target)) {
      setSyncing(true);
      let failures: string[] = [];
      return (sync
        ? syncNow().then(
            (result) => {
              failures = flagSyncProblems(result.problems ?? [], navAccounts.current);
            },
            (error: unknown) => {
              failures = [refreshFailure(error)];
            },
          )
        : Promise.resolve()
      )
        .then(() => fetchNav().then(setNav))
        .catch(() => null)
        .finally(() => {
          setSyncing(false);
          if (refreshProblem(failures.length ? failures.join("\n") : null)) for (const message of failures) showToast({ message, tone: "alert" });
        });
    }
    setSyncing(true);
    let problems: string[] = [];
    return (sync
      ? syncNow().then(
          (result) => {
            problems = flagSyncProblems(result.problems ?? [], navAccounts.current);
            return result;
          },
          (error: unknown) => {
            problems = [refreshFailure(error)];
            return null;
          },
        )
      : Promise.resolve(null)
    )
      .then((synced) => {
        const unchanged = poll && synced?.version && synced.version === seenVersion.current && Date.now() - fullRefresh.current < FULL_REFRESH_MS;
        if (unchanged) {
          setNow(Date.now());
          return null;
        }
        return Promise.all([fetchList(target), fetchNav().catch(() => null), synced?.version ?? null]);
      })
      .then((loaded) => {
        if (!loaded) return;
        const [fresh, freshNav, version] = loaded;
        fullRefresh.current = Date.now();
        seenVersion.current = version ?? freshNav?.version ?? seenVersion.current;
        if (freshNav) setNav(freshNav);
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
            threads: settleSending([...fresh.threads, ...tail].filter((thread) => !hidden.has(thread.key))),
            next: tail.length > 0 ? (existing?.next ?? fresh.next) : fresh.next,
          };
        });
      })
      .catch((error: unknown) => {
        if (problems.length === 0) problems = [refreshFailure(error)];
      })
      .finally(() => {
        setSyncing(false);
        if (refreshProblem(problems.length ? problems.join("\n") : null)) for (const message of problems) showToast({ message, tone: "alert" });
      });
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
      .catch((error: Error) => showToast({ message: error.message, tone: "alert" }))
      .finally(() => {
        loadingMore.current = false;
        if (token === request.current) setLoading(false);
      });
  }

  function restore(thread: ThreadSummary, origin: ListQuery) {
    if (sameList(latest.current.query, origin)) setPage((existing) => (existing ? { ...existing, threads: insertByDate(existing.threads, thread) } : existing));
    else restoreToList(origin, thread);
    if (thread.unread && !origin.query && inInbox(origin.view)) setNav((existing) => shiftUnread(existing, thread, 1));
  }

  function snooze(keys: string[]) {
    const now = Date.now();
    pickLater({
      title: keys.length > 1 ? `Snooze ${keys.length} until` : "Snooze until",
      options: laterOptions(now),
      now,
      onPick: (at, detail) => (keys.length > 1 ? actMany(keys, "snooze", at, detail) : act(keys[0], "snooze", at, detail)),
    });
  }

  function moveSender(key: string, sender: string, split: MailSplit) {
    const { page: currentPage, query: target } = latest.current;
    const thread = currentPage?.threads.find((item) => item.key === key);
    const leaves = Boolean(thread && target.view.startsWith("inbox:") && !target.query && target.view !== `inbox:${split}`);
    if (thread && leaves) {
      const list = currentPage!.threads;
      const index = list.findIndex((item) => item.key === key);
      const remaining = list.filter((item) => item.key !== key);
      setPage({ ...currentPage!, threads: remaining });
      select(remaining[index]?.key ?? remaining[index - 1]?.key ?? null);
      closeReader();
    } else if (thread) {
      setPage((existing) => (existing ? { ...existing, threads: existing.threads.map((item) => (item.key === key ? { ...item, split } : item)) } : existing));
    }
    forgetOtherLists(target);
    showToast({ message: `${sender} now goes to ${SPLIT_LABELS[split]}.` });
    postSenderSplit(sender, split)
      .then(() => fetchNav().then(setNav).catch(() => null))
      .catch((error: Error) => {
        if (thread && leaves) restore(thread, target);
        if (!flagReconnect(error, { sourceId: thread?.sourceId })) showToast({ message: error.message, tone: "alert" });
      });
  }

  function dropThread(key: string) {
    const { page: currentPage, query: target } = latest.current;
    const thread = currentPage?.threads.find((item) => item.key === key);
    forgetThread(key);
    forgetOtherLists(target);
    if (!thread || !(inInbox(target.view) && !target.query)) return;
    const list = currentPage!.threads;
    const index = list.findIndex((item) => item.key === key);
    const remaining = list.filter((item) => item.key !== key);
    setPage({ ...currentPage!, threads: remaining });
    if (thread.unread) setNav((existing) => shiftUnread(existing, thread, -1));
    if (latest.current.cursor === key) {
      select(remaining[index]?.key ?? remaining[index - 1]?.key ?? null);
      closeReader();
    }
  }

  function finishUnsubscribe(done: UnsubscribeDone) {
    setUnsubscribing(null);
    const toast = unsubscribeToast(done);
    const succeeded = done.blocked || done.mode === "research" || (done.result && ["unsubscribed", "requested", "needs_you"].includes(done.result.outcome));
    const key = done.thread;
    if (key) {
      if (succeeded && done.existing !== "leave" && done.moved > 0) dropThread(key);
      else forgetThread(key);
      if (latest.current.cursor === key) fetchDetail(key, true);
    }
    showToast({
      message: toast.message,
      tone: toast.tone,
      action: toast.url ? { label: "Open page", run: () => window.open(toast.url!, "_blank", "noopener,noreferrer") } : undefined,
    });
    window.setTimeout(() => refreshRef.current(false), 1500);
  }

  function toggleSelect(key: string) {
    setSelected((existing) => {
      const next = new Set(existing);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function actMany(keys: string[], action: ReaderAction, until?: string, detail?: string) {
    const { page: currentPage, query: target } = latest.current;
    const chosen = currentPage?.threads.filter((thread) => keys.includes(thread.key)) ?? [];
    setSelected(new Set());
    if (chosen.length === 0) return;
    if (!MOVES.has(action)) {
      for (const thread of chosen) act(thread.key, action);
      return;
    }
    const from = target.query ? "search" : target.view;
    const chosenKeys = new Set(chosen.map((thread) => thread.key));
    chosen.forEach((thread) => removing.current.add(thread.key));
    setPage({ ...currentPage!, threads: currentPage!.threads.filter((thread) => !chosenKeys.has(thread.key)) });
    const unread = chosen.filter((thread) => thread.unread);
    if (inInbox(from)) setNav((existing) => unread.reduce((shifted, thread) => shiftUnread(shifted, thread, -1), existing));
    else if (action === "inbox") setNav((existing) => unread.reduce((shifted, thread) => shiftUnread(shifted, thread, 1), existing));
    const restored = new Set<string>();
    const putBack = (thread: ThreadSummary) => {
      if (restored.has(thread.key)) return;
      restored.add(thread.key);
      restore(thread, target);
    };
    if (latest.current.cursor && chosenKeys.has(latest.current.cursor)) {
      select(null);
      closeReader();
    }
    forgetOtherLists(target);
    let reconnecting = false;
    const runAll = async (run: (thread: ThreadSummary) => Promise<unknown>) => {
      const failures: string[] = [];
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, chosen.length) }, async () => {
          while (next < chosen.length) {
            const thread = chosen[next++];
            try {
              await run(thread);
            } catch (error) {
              if (flagReconnect(error, { sourceId: thread.sourceId })) reconnecting = true;
              else failures.push(error instanceof Error ? error.message : "Couldn't move it. Try again.");
              putBack(thread);
            }
          }
        }),
      );
      return failures;
    };
    const count = chosen.length;
    const labels: Record<string, string> = {
      archive: `Archived ${count}.`,
      trash: `Moved ${count} to Trash.`,
      inbox: `Moved ${count} to Inbox.`,
      snooze: `Snoozed ${count} until ${detail ?? "later"}.`,
    };
    const pending = runAll((thread) => postAction(thread.key, action, from, until));
    const undoFrom = action === "snooze" ? "snoozed" : action === "archive" ? "archive" : "trash";
    const shown = showToast({
      message: labels[action],
      action:
        action === "inbox"
          ? undefined
          : {
              label: "Undo",
              run: () => {
                void pending.then(() => {
                  chosen.forEach(putBack);
                  void runAll((thread) => postAction(thread.key, "inbox", undoFrom)).then(() => {
                    forgetOtherLists(latest.current.query);
                    settleNav();
                  });
                });
              },
            },
    });
    void pending
      .then((failures) => {
        if (reconnecting) dismissToast(shown);
        if (failures.length) showToast({ message: `${failures.length} of ${count} didn't move. ${failures[0]}`, tone: "alert" });
        settleNav();
      })
      .finally(() => chosen.forEach((thread) => removing.current.delete(thread.key)));
  }

  function act(key: string, action: ReaderAction, until?: string, detail?: string, silent = false) {
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
      if (thread.unread && inInbox(from)) setNav((existing) => shiftUnread(existing, thread, -1));
      else if (thread.unread && action === "inbox") setNav((existing) => shiftUnread(existing, thread, 1));
      let restored = false;
      const putBack = () => {
        if (restored) return;
        restored = true;
        restore(thread, target);
      };
      if (latest.current.cursor === key) {
        const next = remaining[index] ?? remaining[index - 1] ?? null;
        select(next?.key ?? null);
        closeReader();
      }
      forgetOtherLists(target);
      const undoable = (inInbox(from) && action !== "inbox") || action === "snooze";
      const undoFrom = action === "snooze" ? "snoozed" : action === "archive" ? "archive" : "trash";
      const shown = showToast({
        message: action === "snooze" && detail ? `Snoozed until ${detail}.` : DONE_LABEL[action],
        action: undoable
          ? {
              label: "Undo",
              run: () => {
                void pendingMove.then(() => {
                  putBack();
                  postAction(key, "inbox", undoFrom)
                    .then(() => forgetOtherLists(latest.current.query))
                    .catch((error: Error) => {
                      if (!flagReconnect(error, { sourceId: thread.sourceId })) showToast({ message: error.message, tone: "alert" });
                    })
                    .finally(settleNav);
                });
              },
            }
          : undefined,
      });
      const pendingMove = postAction(key, action, from, until)
        .then(() => undefined)
        .catch((error: Error) => {
          putBack();
          if (flagReconnect(error, { sourceId: thread.sourceId })) dismissToast(shown);
          else showToast({ message: error.message, tone: "alert" });
        })
        .finally(() => {
          removing.current.delete(key);
          settleNav();
        });
      return;
    }
    if (action === "unread") {
      keptUnread.current.add(key);
      forgetDwellRead(key);
    }
    const change = action === "read" && thread.unread ? -1 : action === "unread" && !thread.unread ? 1 : 0;
    setPage((existing) => (existing ? { ...existing, threads: existing.threads.map((item) => (item.key === key ? patchSummary(item, action) : item)) } : existing));
    setDetails((existing) => (existing[key] ? { ...existing, [key]: patchDetail(existing[key], action) } : existing));
    const cached = cachedThread(key);
    if (cached) storeThread(patchDetail(cached, action));
    if (change && inInbox(from)) setNav((existing) => shiftUnread(existing, thread, change));
    const undoAction: ReaderAction = action === "read" ? "unread" : action === "unread" ? "read" : action === "flag" ? "unflag" : "flag";
    postAction(key, action, from)
      .catch((error: Error) => {
        setPage((existing) => (existing ? { ...existing, threads: existing.threads.map((item) => (item.key === key ? patchSummary(item, undoAction) : item)) } : existing));
        forgetThread(key);
        fetchDetail(key, true);
        if (change && inInbox(from)) settleNav();
        const handled = flagReconnect(error, { sourceId: thread.sourceId });
        if (!silent && !handled) showToast({ message: error.message, tone: "alert" });
      });
  }

  function settleSending(threads: ThreadSummary[]) {
    const outgoing = sendingThreads.current;
    return threads
      .filter((thread) => !removing.current.has(thread.key))
      .map((thread) => (thread.draft && outgoing.get(thread.key)?.some((entry) => entry.cleared) ? { ...thread, draft: false } : thread));
  }

  function leave(key: string) {
    if (latest.current.cursor !== key) return;
    const list = latest.current.page?.threads ?? [];
    const index = list.findIndex((item) => item.key === key);
    const remaining = list.filter((item) => item.key !== key);
    const next = index === -1 ? null : (remaining[index] ?? remaining[index - 1] ?? null);
    select(next?.key ?? null);
    closeReader();
  }

  function sending(key: string, draftOnly: boolean, others: boolean) {
    const { page: currentPage, query: target } = latest.current;
    const list = currentPage?.threads ?? [];
    const thread = list.find((item) => item.key === key) ?? null;
    const left = Boolean(thread) && !others && (draftOnly || (target.view === "drafts" && !target.query));
    const cleared = Boolean(thread?.draft) && !others && !left;
    const entry: OutgoingThread = { thread, origin: target, left, cleared };
    const outgoing = sendingThreads.current;
    outgoing.set(key, [...(outgoing.get(key) ?? []), entry]);
    if (left) removing.current.add(key);
    if (left || cleared) setPage((existing) => (existing ? { ...existing, threads: settleSending(existing.threads) } : existing));
    if (draftOnly) leave(key);
    let settled = false;
    const finish = () => {
      if (settled) return false;
      settled = true;
      const rest = (outgoing.get(key) ?? []).filter((item) => item !== entry);
      if (rest.length) outgoing.set(key, rest);
      else outgoing.delete(key);
      if (entry.left && !rest.some((item) => item.left)) removing.current.delete(key);
      return true;
    };
    return {
      undone: () => {
        if (!finish() || !entry.thread) return;
        if (entry.left && !removing.current.has(key)) restore(entry.thread, entry.origin);
        else if (entry.cleared) {
          const shown = entry.thread;
          setPage((existing) =>
            existing ? { ...existing, threads: settleSending(existing.threads.map((item) => (item.key === key ? { ...item, draft: shown.draft } : item))) } : existing,
          );
        }
      },
      delivered: () => {
        window.setTimeout(() => {
          finish();
          sent(key);
        }, 2500);
      },
    };
  }

  function sent(key: string, wait = 0) {
    window.setTimeout(() => {
      forgetThread(key);
      void refreshRef.current(true);
      window.setTimeout(() => {
        if (latest.current.cursor === key) fetchDetail(key, true);
      }, 9000);
    }, wait);
  }

  const actRef = useRef(act);
  useEffect(() => {
    actRef.current = act;
  });
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });
  const listScroller = useRef<HTMLDivElement>(null);
  const listBody = useRef<HTMLDivElement>(null);
  const pullMark = useRef<HTMLSpanElement>(null);
  const pullRefresh = useCallback(() => refreshRef.current(true), []);
  usePullToRefresh(listScroller, listBody, pullMark, pullRefresh);

  useEffect(() => {
    if (!cursor || !current?.unread || keptUnread.current.has(cursor) || !dwellReadDue(cursor, current.latestId)) return;
    const key = cursor;
    const latestId = current.latestId;
    const timer = window.setTimeout(() => {
      noteDwellRead(key, latestId);
      actRef.current(key, "read", undefined, undefined, true);
    }, READ_DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [cursor, current?.unread, current?.latestId]);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ thread?: string; view?: string | null }>).detail;
      if (!detail?.thread) return;
      const current = latest.current.query;
      if (detail.view && (detail.view !== current.view || current.query)) showRef.current({ view: detail.view, account: current.account, query: "" });
      else if (listForThread(current)) showRef.current(listForThread(current)!);
      selectRef.current(detail.thread, true);
    };
    window.addEventListener(OPEN_THREAD_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_THREAD_EVENT, onOpen);
  }, []);

  const selectRef = useRef(select);
  useEffect(() => {
    selectRef.current = select;
  });

  if (linkedShare !== seenLink) {
    setSeenLink(linkedShare);
    if (linkedShare) setNotesAsked(initialNotes);
  }

  useEffect(() => {
    if (!linkedShare) return;
    const target = initialShared ?? initialThread?.key ?? null;
    if (!target || target === latest.current.cursor) return;
    if (initialShared) {
      showRef.current({ view: SHARED_VIEW, account: null, query: "" });
    } else if (initialThread) {
      storeThread(initialThread);
      if (sharedView(latest.current.query)) showRef.current({ view: HOME_VIEW, account: null, query: "" });
    }
    selectRef.current(target, true);
  }, [linkedShare, initialShared, initialThread]);

  const readerPane = useRef<HTMLDivElement>(null);
  const backSwiped = useRef(false);
  const edge = useRef<EdgeHandlers>({ enabled: false, onDrag: () => {}, onRelease: () => {} });
  const closeRef = useRef(closeReader);
  useEffect(() => {
    closeRef.current = closeReader;
  });

  useEffect(() => {
    if (initialShared || !new URL(window.location.href).searchParams.has("shared")) return;
    window.history.replaceState(window.history.state, "", mailUrl(initialQuery, initialThread?.key ?? null));
  }, [initialThread, initialShared, initialQuery]);

  useEffect(() => {
    const initialKey = initialThread?.key ?? initialShared;
    if (!initialKey || !narrow() || pushedThread()) return;
    const url = window.location.href;
    window.history.replaceState(window.history.state, "", mailUrl(initialQuery, null));
    window.history.pushState({ ...window.history.state, mailThread: initialKey }, "", url);
  }, [initialThread, initialShared, initialQuery]);

  useEffect(() => {
    const onPop = (event: PopStateEvent) => {
      if (window.location.pathname !== "/mail" || !narrow()) return;
      const uaAnimated = Boolean((event as PopStateEvent & { hasUAVisualTransition?: boolean }).hasUAVisualTransition);
      const params = new URL(window.location.href).searchParams;
      const thread = params.get("thread") ?? params.get("shared");
      if (thread && pushedThread()) {
        if (latest.current.open) return;
        latest.current = { ...latest.current, open: true };
        selectRef.current(thread);
        setOpen(true);
        setMotion(uaAnimated ? null : "open");
        return;
      }
      if (!latest.current.open) return;
      latest.current = { ...latest.current, open: false };
      setOpen(false);
      setMotion(uaAnimated || backSwiped.current ? null : "back");
      backSwiped.current = false;
      setPeeking(false);
      readerPane.current?.style.removeProperty("transform");
      readerPane.current?.style.removeProperty("transition");
      window.history.replaceState(window.history.state, "", mailUrl(latest.current.query, null));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function slideReader(dx: number, duration: number) {
    const element = readerPane.current;
    if (!element) return;
    element.style.transition = duration ? `transform ${duration}ms var(--ease-power3-out)` : "none";
    element.style.transform = dx ? `translate3d(${dx}px, 0, 0)` : "";
  }

  function settleReader() {
    backSwiped.current = false;
    slideReader(0, 0);
    setPeeking(false);
  }

  useEffect(() => {
    edge.current = {
      enabled: open && narrow(),
      width: () => readerPane.current?.offsetWidth ?? window.innerWidth,
      onDrag: (dx) => {
        setPeeking(true);
        slideReader(Math.max(0, dx), 0);
      },
      onRelease: (commit) => {
        const width = readerPane.current?.offsetWidth ?? window.innerWidth;
        slideReader(commit ? width : 0, BACK_MS);
        window.setTimeout(() => {
          if (!commit) {
            settleReader();
            return;
          }
          backSwiped.current = true;
          closeRef.current(false);
        }, BACK_MS);
      },
    };
  });

  useEffect(() => {
    const element = readerPane.current;
    if (!element) return;
    return watchEdgeSwipe(element, () => edge.current);
  }, []);

  const showRef = useRef(show);
  useEffect(() => {
    showRef.current = show;
  });

  useEffect(() => {
    if (sentCount === 0) return;
    const timer = window.setTimeout(() => {
      refreshRef.current(true);
      if (latest.current.query.view === "scheduled") loadScheduledRef.current();
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [sentCount]);

  const loadScheduledRef = useRef(loadScheduled);
  useEffect(() => {
    loadScheduledRef.current = loadScheduled;
  });

  useEffect(() => {
    if (initialQuery.view === "scheduled") loadScheduledRef.current();
  }, [initialQuery.view]);

  const loadSharedRef = useRef(loadShared);
  useEffect(() => {
    loadSharedRef.current = loadShared;
  });

  useEffect(() => {
    loadSharedRef.current();
  }, []);

  const sharedSettle = useRef(0);
  useMailShareEvents(() => {
    window.clearTimeout(sharedSettle.current);
    sharedSettle.current = window.setTimeout(() => loadSharedRef.current(), 400);
  });
  useEffect(() => () => window.clearTimeout(sharedSettle.current), []);

  useEffect(() => {
    let last = 0;
    const tick = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < MIN_POLL_GAP_MS) return;
      last = Date.now();
      refreshRef.current(true, true);
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
    if (inShared) {
      const next = stepShare(sharedList ?? [], cursor, delta);
      if (next) select(next);
      return;
    }
    if (threads.length === 0) return;
    const index = threads.findIndex((thread) => thread.key === cursor);
    const nextIndex = index === -1 ? (delta > 0 ? 0 : threads.length - 1) : Math.min(threads.length - 1, Math.max(0, index + delta));
    if (delta > 0 && nextIndex >= threads.length - 5) more();
    select(threads[nextIndex].key);
  }

  function primaryMove() {
    if ((query.view === "archive" || query.view === "snoozed" || query.view === "junk") && !query.query) return "inbox" as const;
    return "archive" as const;
  }

  useShortcut("list-down", () => step(1));
  useShortcut("list-down-arrow", () => step(1));
  useShortcut("list-up", () => step(-1));
  useShortcut("list-up-arrow", () => step(-1));
  useShortcut("list-open", () => {
    if (!cursor) return false;
    select(cursor, true);
  });
  useShortcut("back", () => {
    if (selected.size) {
      setSelected(new Set());
      return;
    }
    if (!open) return false;
    closeReader();
  });
  const selectedThreads = threads.filter((thread) => selected.has(thread.key));
  const selectionLabel =
    selectedThreads.length === 0 ? "" : selectedThreads.length === threads.length && threads.length > 1 ? `All ${selectedThreads.length} selected` : `${selectedThreads.length} selected`;

  function bulk(action: "archive" | "trash" | "read" | "flag" | "snooze") {
    const keys = selectedThreads.map((thread) => thread.key);
    if (action === "snooze") return snooze(keys);
    if (action === "read") return actMany(keys, selectedThreads.some((thread) => thread.unread) ? "read" : "unread");
    if (action === "flag") return actMany(keys, selectedThreads.some((thread) => !thread.flagged) ? "flag" : "unflag");
    actMany(keys, action === "archive" ? primaryMove() : "trash");
  }

  function cycleSplit(delta: number) {
    const focused = document.activeElement;
    if (focused && focused !== document.body && !focused.closest("[data-mail-row]")) return false;
    const ids = splitTabs.map((tab) => tab.id).concat(sharedTab ? [SHARED_VIEW] : []);
    const index = ids.indexOf(query.view);
    show({ ...query, view: ids[index === -1 ? 0 : (index + delta + ids.length) % ids.length], query: "" });
  }

  useShortcut("mail-next-split", () => cycleSplit(1));
  useShortcut("mail-prev-split", () => cycleSplit(-1));
  useShortcut("list-select", () => {
    if (inShared) return false;
    if (!cursor) return false;
    toggleSelect(cursor);
  });
  useShortcut("list-select-all", () => {
    if (inShared) return false;
    if (threads.length === 0 || query.view === "scheduled") return false;
    setSelected(new Set(threads.map((thread) => thread.key)));
  });
  useShortcut("mail-archive", () => {
    if (inShared) return false;
    if (selectedThreads.length) return bulk("archive");
    if (!cursor) return false;
    act(cursor, primaryMove());
  });
  useShortcut("mail-trash", () => {
    if (inShared) return false;
    if (query.view === "trash" && !query.query) return false;
    if (selectedThreads.length) return bulk("trash");
    if (!cursor) return false;
    act(cursor, "trash");
  });
  useShortcut("mail-read", () => {
    if (inShared) return false;
    if (selectedThreads.length) return bulk("read");
    if (!current) return false;
    act(current.key, current.unread ? "read" : "unread");
  });
  useShortcut("mail-flag", () => {
    if (inShared) return false;
    if (selectedThreads.length) return bulk("flag");
    if (!current) return false;
    act(current.key, current.flagged ? "unflag" : "flag");
  });
  useShortcut("mail-unsubscribe", () => {
    if (inShared) return false;
    if (!cursor || unsubscribing) return false;
    const ownSet = new Set(own.map((item) => item.toLowerCase()));
    if (current?.from && ownSet.has(current.from.address.toLowerCase()) && !detail?.subscription) return false;
    setUnsubscribing({ thread: cursor, mode: "unsubscribe" });
  });
  useShortcut("mail-undo", () => {
    if (!undoLatest()) return false;
  });
  useShortcut("mail-snooze", () => {
    if (inShared) return false;
    if (query.view === "snoozed") return false;
    if (selectedThreads.length) return bulk("snooze");
    if (!cursor) return false;
    snooze([cursor]);
  });
  useShortcut("mail-refresh", () => void refresh(true));
  function visibleSearch() {
    return window.matchMedia("(min-width: 64rem)").matches ? searchInput.current : searchInputList.current;
  }

  useShortcut("search-list", () => {
    visibleSearch()?.focus();
    visibleSearch()?.select();
  });

  function openFromAsk(key: string) {
    const list = listForThread(latest.current.query);
    if (list) show(list);
    select(key, true);
  }

  function runAsk(question: string) {
    const token = ++askToken.current;
    setAsk({ question, result: null, error: null });
    setCursor(null);
    visibleSearch()?.blur();
    askAi(question, query.account)
      .then((result) => {
        if (token === askToken.current) setAsk({ question, result, error: null });
      })
      .catch((error: Error) => {
        if (token === askToken.current) setAsk({ question, result: null, error: error.message });
      });
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    const text = search.trim();
    if (text && QUESTION.test(text)) {
      runAsk(text);
      return;
    }
    setAsk(null);
    if (text === query.query) return;
    show({ ...query, query: text, view: text ? query.view : query.view });
    visibleSearch()?.blur();
  }

  function clearSearch() {
    setSearch("");
    askToken.current += 1;
    setAsk(null);
    if (query.query) show({ ...query, query: "" });
  }

  function searchForm(place: "header" | "list") {
    return (
    <form role="search" onSubmit={submitSearch} className={cn("relative", place === "header" && "w-full max-w-[26rem]")}>
      <label htmlFor={`mail-search-${place}`} className="sr-only">
        Search mail
      </label>
      <SearchIcon aria-hidden className="text-subtle pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2" />
      <input
        ref={place === "header" ? searchInput : searchInputList}
        id={`mail-search-${place}`}
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && search) {
            event.preventDefault();
            clearSearch();
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && search.trim()) {
            event.preventDefault();
            event.stopPropagation();
            runAsk(search.trim());
          }
        }}
        placeholder="Search, or ask a question"
        autoComplete="off"
        className={cn("placeholder:text-subtle text-foreground ease-power3-out bg-surface-field focus:bg-surface-raised w-full rounded-xl pr-24 pl-9 text-[14px] transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 [&::-webkit-search-cancel-button]:hidden", place === "header" ? "h-8" : "h-9")}
      />
      {search ? (
        <>
        <Button
          variant="ghost"
          size="none"
          onClick={() => runAsk(search.trim())}
          aria-label="Ask AI about your email"
          title="Ask AI (⌘ Enter)"
          className="text-primary-foreground hover:text-primary-foreground absolute top-1/2 right-9 h-6 -translate-y-1/2 gap-1 bg-[color-mix(in_srgb,var(--primary)_22%,transparent)] px-2 text-[12px] font-normal hover:bg-[color-mix(in_srgb,var(--primary)_32%,transparent)]"
        >
          <SparkleIcon aria-hidden className="size-3" />
          Ask
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={clearSearch} aria-label="Clear search" className="absolute top-1/2 right-2 -translate-y-1/2">
          <CloseIcon aria-hidden className="size-2.5" />
        </Button>
        </>
      ) : (
        <Kbd aria-hidden className="absolute top-1/2 right-2 -translate-y-1/2">
          /
        </Kbd>
      )}
    </form>
    );
  }

  const empty = query.query
    ? `No emails match “${query.query}”.`
    : query.view === "inbox:important"
      ? "Inbox zero"
      : "Nothing here";

  if (mailboxless && sharedList?.length === 0 && !cursor) {
    return (
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <MailShareLive />
        <SectionHeader title="Mail" viewer={viewer} />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <h2>No mailbox connected</h2>
          <Button variant="primary" href="/settings/email">
            Connect Microsoft
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 touch-pan-y flex-col overscroll-x-none">
      <MailOverscroll />
      <MailShareLive />
      {navPromise && (
        <Suspense fallback={null}>
          <NavStream promise={navPromise} onNav={receiveNav} />
        </Suspense>
      )}
      <SectionHeader
        title="Mail"
        viewer={viewer}
        heading={
          <div className="flex min-w-0 items-center gap-5">
            <h1 className="shrink-0">Mail</h1>
            {!mailboxless && <div className="hidden min-w-0 flex-1 lg:flex">{searchForm("header")}</div>}
          </div>
        }
        action={
          mailboxless ? null : (
          <>
            <Button variant="primary" onClick={() => openComposer()} shortcut={["C", "M"]} className="max-md:hidden">
              Compose
            </Button>
            {nav.accounts.length > 1 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="secondary" aria-label={`Account: ${accountLabel}`} className="max-w-[16em]">
                    {query.account ? (
                      <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: tagBase(accountLabel) }} />
                    ) : (
                      <InboxIcon aria-hidden className="size-3.5 shrink-0 sm:hidden" />
                    )}
                    <span className="truncate max-sm:sr-only">{accountLabel}</span>
                    <ChevronDownIcon aria-hidden className="text-subtle size-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[15rem]">
                  <DropdownMenuRadioGroup
                    value={query.account ?? "all"}
                    onValueChange={(value) => {
                      const account = value === "all" ? null : value;
                      const folderGone = activeFolder && account && activeFolder.sourceId !== account;
                      show({ ...query, account, view: folderGone ? HOME_VIEW : query.view });
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
          )
        }
      />
      <ReconnectNotices accounts={nav.accounts} className="shrink-0 px-3 pt-2 lg:pt-3" onReturn={() => fetchNav().then(setNav).catch(() => null)} />
      <div className="relative flex min-h-0 flex-1 overflow-x-clip">
        <div
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget) setMotion(null);
          }}
          className={cn(
            "min-h-0 w-full flex-col md:flex md:w-[20rem] md:shrink-0 lg:w-[25rem] xl:w-[29rem]",
            open ? (peeking ? "max-md:absolute max-md:inset-0 max-md:flex" : "hidden") : "flex",
            !open && motion === "back" && "max-md:motion-safe:animate-enter-from-left",
          )}
        >
          <div className="flex shrink-0 flex-col gap-2 px-3 pt-2 pb-1.5 lg:pt-3">
            <PushPrompt />
            {mailboxless ? (
              <p className="caption-style text-subtle flex flex-wrap items-center gap-x-1.5 px-1">
                No mailbox connected.
                <Button variant="link" size="none" href="/settings/email" className="caption-style font-normal">
                  Connect Microsoft
                </Button>
              </p>
            ) : (
              <div className="lg:hidden">{searchForm("list")}</div>
            )}
            <div className="relative">
              <p role="status" className="sr-only">
                {selectionLabel}
              </p>
              <nav aria-label="Mail folders" inert={selectedThreads.length > 0} className="-mx-1 flex items-center gap-1">
                <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1 pr-5 [mask-image:linear-gradient(to_right,black_calc(100%-1.25rem),transparent)] [scrollbar-width:none]">
                  {!mailboxless && splitTabs.map((tab) => {
                    const active = !query.query && query.view === tab.id;
                    return (
                      <FilterChip
                        key={tab.id}
                        active={active}
                        aria-current={active ? "page" : undefined}
                        count={tab.unread}
                        countTone={tab.split === "important" ? "primary" : "soft"}
                        onClick={() => show({ ...query, view: tab.id, query: "" })}
                      >
                        {tab.label}
                      </FilterChip>
                    );
                  })}
                  {sharedTab && (
                    <FilterChip
                      active={inShared}
                      aria-current={inShared ? "page" : undefined}
                      aria-label={`Shared, ${sharedCountLabel(sharedCount)}`}
                      count={sharedCount}
                      icon={<UsersIcon aria-hidden className="size-3.5 shrink-0" />}
                      onClick={() => show({ ...query, view: SHARED_VIEW, query: "" })}
                    >
                      Shared
                    </FilterChip>
                  )}
                </div>
                {!mailboxless && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <FilterChip
                      active={Boolean(moreLabel)}
                      aria-current={moreLabel ? "page" : undefined}
                      aria-label={moreLabel ? `More folders: ${moreLabel}` : "More folders"}
                      icon={<FolderIcon aria-hidden className="size-3.5 shrink-0" />}
                      trailing={<ChevronDownIcon aria-hidden className="size-3 shrink-0" />}
                      className="mr-1 max-w-[10em]"
                    >
                      {moreLabel ?? "More"}
                    </FilterChip>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[14rem]">
                    <DropdownMenuRadioGroup value={query.query ? "" : query.view} onValueChange={(value) => show({ ...query, view: value, query: "" })}>
                      {MORE_VIEWS.map((view) => {
                        const count = view.id === "snoozed" ? nav.snoozed : view.id === "scheduled" ? nav.scheduled : 0;
                        return (
                          <DropdownMenuRadioItem key={view.id} value={view.id}>
                            <span className="flex-1">{view.label}</span>
                            {count > 0 && <span className="text-subtle tabular-nums">{count}</span>}
                          </DropdownMenuRadioItem>
                        );
                      })}
                      {folders.length > 0 && <DropdownMenuLabel>Folders</DropdownMenuLabel>}
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
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                      <Link href="/mail/subscriptions">
                        <UnsubscribeIcon aria-hidden className="text-subtle size-3.5" />
                        <span className="flex-1">Subscriptions</span>
                      </Link>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                )}
              </nav>
              {selectedThreads.length > 0 && (
                <div
                  role="toolbar"
                  aria-label="Selected conversations"
                  className="animate-in fade-in-0 zoom-in-[0.98] ease-power3-out absolute inset-x-0 top-1/2 z-10 flex h-11 -translate-y-1/2 items-center gap-0.5 rounded-xl border border-line-subtle bg-[color-mix(in_srgb,var(--primary)_14%,var(--popover))] pr-1 pl-3 shadow-overlay duration-150 md:h-10"
                >
                  <span aria-hidden className="ui-style text-foreground mr-auto min-w-0 truncate tabular-nums">
                    {selectionLabel}
                  </span>
                  {[
                    primaryMove() === "inbox"
                      ? { action: "archive" as const, label: "Move to Inbox", hint: "E", icon: InboxIcon }
                      : { action: "archive" as const, label: "Archive", hint: "E", icon: ArchiveIcon },
                    query.view === "snoozed" ? null : { action: "snooze" as const, label: "Snooze", hint: "H", icon: ClockIcon },
                    selectedThreads.some((thread) => !thread.flagged)
                      ? { action: "flag" as const, label: "Flag", hint: "S", icon: FlagIcon }
                      : { action: "flag" as const, label: "Remove flag", hint: "S", icon: FlagIcon },
                    selectedThreads.some((thread) => thread.unread)
                      ? { action: "read" as const, label: "Mark read", hint: "U", icon: MailOpenIcon }
                      : { action: "read" as const, label: "Mark unread", hint: "U", icon: MailOpenIcon },
                    query.view === "trash" ? null : { action: "trash" as const, label: "Move to Trash", hint: "#", icon: TrashIcon },
                  ]
                    .filter((item) => item !== null)
                    .map((item) => (
                      <Button
                        key={item.label}
                        variant="ghost"
                        size="icon"
                        aria-label={item.label}
                        title={`${item.label} (${item.hint})`}
                        onClick={() => bulk(item.action)}
                        className="max-md:size-9"
                      >
                        <item.icon aria-hidden className="size-4 md:size-3.5" />
                      </Button>
                    ))}
                  {selectedThreads.length < threads.length && (
                    <Button variant="ghost" size="sm" onClick={() => setSelected(new Set(threads.map((thread) => thread.key)))} title="Select all (⌘A)" className="max-md:h-9">
                      All
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" aria-label="Clear selection" title="Clear selection (Esc)" onClick={() => setSelected(new Set())} className="max-md:size-9">
                    <CloseIcon aria-hidden className="size-3" />
                  </Button>
                </div>
              )}
            </div>
            {query.query && (
              <p role="status" className="caption-style text-subtle px-1">
                {loading && threads.length === 0 ? "Searching…" : `Results for “${query.query}” in all folders${query.account ? ` of ${accountLabel}` : ""}`}
              </p>
            )}
          </div>
          <div ref={listScroller} className="relative min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-x-none">
            <span
              ref={pullMark}
              aria-hidden
              className="text-soft data-[ready=true]:text-foreground bg-surface-raised pointer-events-none absolute top-0 left-1/2 z-10 flex size-8 -translate-x-1/2 items-center justify-center rounded-full opacity-0"
            >
              <RefreshIcon className="size-3.5" />
            </span>
            <div ref={listBody}>
            {ask ? (
              <AskPanel ask={ask} now={now} onOpen={openFromAsk} />
            ) : inShared ? (
              <SharedList
                threads={sharedList}
                cursor={cursor}
                viewerId={viewer.id}
                now={now}
                error={sharedError}
                onOpen={(shareId) => select(shareId, true)}
                onRetry={() => loadShared()}
              />
            ) : query.view === "scheduled" && !query.query ? (
              <ScheduledList drafts={scheduled} now={now} onOpen={(draft) => openComposer({ draft })} />
            ) : listError && threads.length === 0 ? (
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
                scope={`${query.view}|${query.account ?? ""}|${query.query}`}
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
                selected={selected}
                onToggle={toggleSelect}
                swipe={
                  !query.query && query.view === "drafts"
                    ? null
                    : {
                        leftLabel: primaryMove() === "inbox" ? "Move to Inbox" : "Archive",
                        restore: primaryMove() === "inbox",
                        onLeft: (key) => act(key, primaryMove()),
                        rightLabel: query.view === "snoozed" && !query.query ? null : "Snooze",
                        onRight: (key) => {
                          if (query.view !== "snoozed" || query.query) snooze([key]);
                        },
                      }
                }
              />
            )}
            </div>
          </div>
        </div>
        <div
          ref={readerPane}
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget) setMotion(null);
          }}
          className={cn(
            "md:bg-surface-panel min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:my-2 md:mr-2 md:flex md:rounded-2xl",
            open ? "flex" : "hidden",
            open && motion === "open" && !inShared && "max-md:motion-safe:animate-enter-from-right",
            peeking && "max-md:bg-background max-md:relative max-md:z-10 max-md:shadow-[-12px_0_32px_rgba(0,0,0,0.45)]",
          )}
        >
          {inShared ? (
            cursor ? (
              <SharedReader
                key={cursor}
                shareId={cursor}
                summary={sharedSummary}
                viewer={{ id: viewer.id, name: viewer.name }}
                notes={notesAsked && cursor === initialShared}
                onBack={() => closeReader()}
                onGone={() => loadShared()}
                onOwner={(threadKey) => {
                  show({ view: HOME_VIEW, account: null, query: "" });
                  select(threadKey, true);
                }}
              />
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
                <p className="text-soft">Nothing open</p>
              </div>
            )
          ) : (
          <ThreadReader
            key={cursor ?? "none"}
            viewer={{ id: viewer.id, name: viewer.name }}
            notes={notesAsked && cursor === initialThread?.key}
            summary={current}
            detail={detail}
            error={cursor ? (detailErrors[cursor] ?? null) : null}
            own={own}
            workspaceName={viewer.workspaceName}
            view={viewParam}
            accounts={accounts}
            compose={initialCompose && cursor === initialThread?.key ? initialCompose : null}
            onAction={(action) => {
              if (!cursor) return;
              if (action === "snooze") snooze([cursor]);
              else act(cursor, action);
            }}
            onBack={() => closeReader()}
            onNext={(swiped) => {
              const next = threads[currentIndex + 1];
              setEntered(next && !swiped ? next.key : null);
              step(1);
            }}
            onPrevious={() => {
              setEntered(null);
              step(-1);
            }}
            previous={currentIndex > 0 ? threads[currentIndex - 1] : null}
            next={currentIndex !== -1 && currentIndex < threads.length - 1 ? threads[currentIndex + 1] : null}
            entered={entered !== null && entered === cursor}
            onSplit={(sender, split) => cursor && moveSender(cursor, sender, split)}
            onUnsubscribe={(mode) => cursor && setUnsubscribing({ thread: cursor, mode })}
            onBlock={() => cursor && setUnsubscribing({ thread: cursor, mode: "block" })}
            onSent={() => cursor && sent(cursor, 2500)}
            onSending={(draftOnly, others) => (cursor ? sending(cursor, draftOnly, others) : UNTRACKED)}
            onLeave={() => cursor && leave(cursor)}
          />
          )}
        </div>
      </div>
      <UnsubscribeDialog
        request={unsubscribing}
        onClose={() => setUnsubscribing(null)}
        onDone={finishUnsubscribe}
      />
      {!open && !mailboxless && <ComposeButton onCompose={() => openComposer()} />}
    </section>
  );
}
