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
  fetchScheduled,
  postSenderSplit,
  askAi,
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
import AskPanel, { type AskState } from "@/components/mail/ask-panel";
import ScheduledList from "@/components/mail/scheduled-list";
import { setBadge } from "@/components/push/push-client";
import PushPrompt from "@/components/push/push-prompt";
import { OPEN_THREAD_EVENT } from "@/components/push/push-registrar";
import ThreadList from "@/components/mail/thread-list";
import ThreadReader, { type ReaderAction } from "@/components/mail/thread-reader";
import { useComposer } from "@/components/mail/compose-dock";
import { useShortcut } from "@/components/shortcuts/shortcuts-provider";
import { laterOptions } from "@/lib/mail/later";
import { MAIL_SPLITS, SPLIT_LABELS, type MailSplit, type ComposeAccount, type MailDraft, type MailNav, type ThreadDetail, type ThreadSummary } from "@/lib/mail/view";
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

const HOME_VIEW = "inbox:important";

const MORE_VIEWS = [
  { id: "inbox", label: "All inbox" },
  { id: "snoozed", label: "Snoozed" },
  { id: "scheduled", label: "Scheduled" },
  { id: "sent", label: "Sent" },
  { id: "drafts", label: "Drafts" },
  { id: "archive", label: "Archive" },
  { id: "trash", label: "Trash" },
] as const;

function inInbox(view: string) {
  return view === "inbox" || view.startsWith("inbox:");
}

const MOVES = new Set<ReaderAction>(["archive", "trash", "inbox", "snooze"]);
const DONE_LABEL: Record<string, string> = { archive: "Archived.", trash: "Moved to Trash.", inbox: "Moved to Inbox.", snooze: "Snoozed." };
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

function mailUrl(query: ListQuery, thread: string | null) {
  const params = new URLSearchParams();
  if (query.query) params.set("q", query.query);
  else if (query.view !== HOME_VIEW) params.set("view", query.view);
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
  const { openComposer, sent: sentCount, pickLater, showToast, undoLatest } = useComposer();
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
  const [cursor, setCursor] = useState<string | null>(initialThread?.key ?? null);
  const [open, setOpen] = useState(Boolean(initialThread));
  const [details, setDetails] = useState<Record<string, ThreadDetail>>(initialThread ? { [initialThread.key]: initialThread } : {});
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
  const [search, setSearch] = useState(initialQuery.query);
  const [now, setNow] = useState(initialNow);
  const [syncing, setSyncing] = useState(false);
  const [entered, setEntered] = useState<string | null>(null);
  const request = useRef(0);
  const removing = useRef(new Set<string>());
  const keptUnread = useRef(new Set<string>());
  const loadingMore = useRef(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchInputList = useRef<HTMLInputElement>(null);
  const latest = useRef({ query, page, cursor });

  useEffect(() => {
    latest.current = { query, page, cursor };
  });

  useEffect(() => {
    if (page) storeList(query, page);
  }, [page, query]);

  const importantUnread = nav.splits.filter((row) => row.split === "important").reduce((sum, row) => sum + row.unread, 0);
  useEffect(() => {
    setMailUnread(importantUnread);
    setBadge(importantUnread);
  }, [importantUnread, setMailUnread]);

  useEffect(() => {
    if (initialThread) storeThread(initialThread);
    prefetchThreads(initialPage.threads.slice(0, 4).map((thread) => thread.key));
  }, [initialPage, initialThread]);


  const threads = page?.threads ?? [];
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
    setOpen(false);
    setListError(null);
    if (next.view === "scheduled" && !next.query) {
      setPage({ threads: [], next: null });
      setLoading(false);
      writeUrl(next, null);
      loadScheduled();
      return;
    }
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
      .catch((error: Error) => showToast({ message: error.message, tone: "alert" }))
      .finally(() => {
        loadingMore.current = false;
        if (token === request.current) setLoading(false);
      });
  }

  function restore(thread: ThreadSummary, from: string) {
    setPage((existing) => (existing ? { ...existing, threads: insertByDate(existing.threads, thread) } : existing));
    if (thread.unread && inInbox(from)) setNav((existing) => shiftUnread(existing, thread.sourceId, 1));
  }

  function snooze(keys: string[]) {
    const now = Date.now();
    pickLater({
      title: "Remind me",
      description:
        keys.length > 1
          ? `Orbit moves ${keys.length} conversations out of your inbox and brings them back to the top at this time.`
          : "Orbit moves the conversation out of your inbox and brings it back to the top at this time.",
      options: laterOptions(now),
      now,
      onPick: (at, detail) => (keys.length > 1 ? actMany(keys, "snooze", at, detail) : act(keys[0], "snooze", false, at, detail)),
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
      setOpen(false);
    } else if (thread) {
      setPage((existing) => (existing ? { ...existing, threads: existing.threads.map((item) => (item.key === key ? { ...item, split } : item)) } : existing));
    }
    forgetOtherLists(target);
    showToast({ message: `Email from ${sender} now goes to ${SPLIT_LABELS[split]}.` });
    postSenderSplit(sender, split)
      .then(() => fetchNav().then(setNav).catch(() => null))
      .catch((error: Error) => {
        if (thread && leaves) restore(thread, target.view);
        showToast({ message: error.message, tone: "alert" });
      });
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
      for (const thread of chosen) act(thread.key, action, true);
      window.setTimeout(() => fetchNav().then(setNav).catch(() => null), 1500);
      return;
    }
    const from = target.query ? "search" : target.view;
    const chosenKeys = new Set(chosen.map((thread) => thread.key));
    chosen.forEach((thread) => removing.current.add(thread.key));
    setPage({ ...currentPage!, threads: currentPage!.threads.filter((thread) => !chosenKeys.has(thread.key)) });
    if (latest.current.cursor && chosenKeys.has(latest.current.cursor)) {
      select(null);
      setOpen(false);
    }
    forgetOtherLists(target);
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
              failures.push(error instanceof Error ? error.message : "Outlook refused a change.");
              restore(thread, from);
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
    showToast({
      message: labels[action],
      action:
        action === "inbox"
          ? undefined
          : {
              label: "Undo",
              run: () => {
                void pending.then(() => {
                  chosen.forEach((thread) => restore(thread, from));
                  void runAll((thread) => postAction(thread.key, "inbox", undoFrom)).then(() => {
                    forgetOtherLists(latest.current.query);
                    fetchNav().then(setNav).catch(() => null);
                  });
                });
              },
            },
    });
    void pending
      .then((failures) => {
        if (failures.length) showToast({ message: `${failures.length} of ${count} didn't move. ${failures[0]}`, tone: "alert" });
        fetchNav().then(setNav).catch(() => null);
      })
      .finally(() => chosen.forEach((thread) => removing.current.delete(thread.key)));
  }

  function act(key: string, action: ReaderAction, quiet = false, until?: string, detail?: string) {
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
      if (thread.unread && inInbox(from)) setNav((existing) => shiftUnread(existing, thread.sourceId, -1));
      if (latest.current.cursor === key) {
        const next = remaining[index] ?? remaining[index - 1] ?? null;
        select(next?.key ?? null);
        setOpen(false);
      }
      forgetOtherLists(target);
      const undoable = (inInbox(from) && action !== "inbox") || action === "snooze";
      const undoFrom = action === "snooze" ? "snoozed" : action === "archive" ? "archive" : "trash";
      showToast({
        message: action === "snooze" && detail ? `Back in your inbox ${detail}.` : DONE_LABEL[action],
        action: undoable
          ? {
              label: "Undo",
              run: () => {
                void pendingMove.then(() => {
                  restore(thread, from);
                  postAction(key, "inbox", undoFrom)
                    .then(() => {
                      forgetOtherLists(latest.current.query);
                      fetchNav().then(setNav).catch(() => null);
                    })
                    .catch((error: Error) => showToast({ message: error.message, tone: "alert" }));
                });
              },
            }
          : undefined,
      });
      const pendingMove = postAction(key, action, from, until)
        .then(() => {
          fetchNav().then(setNav).catch(() => null);
        })
        .catch((error: Error) => {
          restore(thread, from);
          showToast({ message: error.message, tone: "alert" });
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
    if (change && inInbox(from)) setNav((existing) => shiftUnread(existing, thread.sourceId, change));
    const undoAction: ReaderAction = action === "read" ? "unread" : action === "unread" ? "read" : action === "flag" ? "unflag" : "flag";
    postAction(key, action, from)
      .then(() => {
        if (!quiet) fetchNav().then(setNav).catch(() => null);
      })
      .catch((error: Error) => {
        setPage((existing) => (existing ? { ...existing, threads: existing.threads.map((item) => (item.key === key ? patchSummary(item, undoAction) : item)) } : existing));
        forgetThread(key);
        fetchDetail(key, true);
        if (change && inInbox(from)) setNav((existing) => shiftUnread(existing, thread.sourceId, -change));
        showToast({ message: error.message, tone: "alert" });
      });
  }

  function sent(key: string) {
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
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ thread?: string; view?: string | null }>).detail;
      if (!detail?.thread) return;
      const current = latest.current.query;
      if (detail.view && (detail.view !== current.view || current.query)) showRef.current({ view: detail.view, account: current.account, query: "" });
      selectRef.current(detail.thread, true);
    };
    window.addEventListener(OPEN_THREAD_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_THREAD_EVENT, onOpen);
  }, []);

  const selectRef = useRef(select);
  useEffect(() => {
    selectRef.current = select;
  });

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
    if ((query.view === "archive" || query.view === "snoozed") && !query.query) return "inbox" as const;
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
    if (selected.size) {
      setSelected(new Set());
      return;
    }
    if (!open) return false;
    setOpen(false);
  });
  const selectedThreads = threads.filter((thread) => selected.has(thread.key));

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
    const ids = splitTabs.map((tab) => tab.id);
    const index = ids.indexOf(query.view);
    show({ ...query, view: ids[index === -1 ? 0 : (index + delta + ids.length) % ids.length], query: "" });
  }

  useShortcut("mail-next-split", () => cycleSplit(1));
  useShortcut("mail-prev-split", () => cycleSplit(-1));
  useShortcut("list-select", () => {
    if (!cursor) return false;
    toggleSelect(cursor);
  });
  useShortcut("list-select-all", () => {
    if (threads.length === 0 || query.view === "scheduled") return false;
    setSelected(new Set(threads.map((thread) => thread.key)));
  });
  useShortcut("mail-archive", () => {
    if (selectedThreads.length) return bulk("archive");
    if (!cursor) return false;
    act(cursor, primaryMove());
  });
  useShortcut("mail-trash", () => {
    if (query.view === "trash" && !query.query) return false;
    if (selectedThreads.length) return bulk("trash");
    if (!cursor) return false;
    act(cursor, "trash");
  });
  useShortcut("mail-read", () => {
    if (selectedThreads.length) return bulk("read");
    if (!current) return false;
    act(current.key, current.unread ? "read" : "unread");
  });
  useShortcut("mail-flag", () => {
    if (selectedThreads.length) return bulk("flag");
    if (!current) return false;
    act(current.key, current.flagged ? "unflag" : "flag");
  });
  useShortcut("mail-undo", () => {
    if (!undoLatest()) return false;
  });
  useShortcut("mail-snooze", () => {
    if (query.view === "snoozed") return false;
    if (selectedThreads.length) return bulk("snooze");
    if (!cursor) return false;
    snooze([cursor]);
  });
  useShortcut("mail-refresh", () => refresh(true));
  function visibleSearch() {
    return window.matchMedia("(min-width: 64rem)").matches ? searchInput.current : searchInputList.current;
  }

  useShortcut("search-list", () => {
    visibleSearch()?.focus();
    visibleSearch()?.select();
  });

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
        className={cn("placeholder:text-subtle text-foreground ease-power3-out w-full rounded-xl bg-white/[0.04] pr-24 pl-9 text-[14px] transition-colors duration-150 outline-none focus:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-ring/40 [&::-webkit-search-cancel-button]:hidden", place === "header" ? "h-8" : "h-9")}
      />
      {search ? (
        <>
        <button
          type="button"
          onClick={() => runAsk(search.trim())}
          aria-label="Ask AI about your email"
          title="Ask AI (⌘ Enter)"
          className="text-primary-foreground absolute top-1/2 right-9 flex h-6 -translate-y-1/2 cursor-pointer items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--primary)_22%,transparent)] px-2 text-[12px] outline-none hover:bg-[color-mix(in_srgb,var(--primary)_32%,transparent)] focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <SparkleIcon aria-hidden className="size-3" />
          Ask
        </button>
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
    : inInbox(query.view)
      ? query.view === HOME_VIEW
        ? "Inbox zero. Nothing important is waiting for you."
        : "Nothing here."
      : activeFolder
        ? `${activeFolder.name} is empty.`
        : `Nothing in ${MORE_VIEWS.find((view) => view.id === query.view)?.label ?? "this folder"}.`;

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
        heading={
          <div className="flex min-w-0 items-center gap-5">
            <h1 className="shrink-0">Mail</h1>
            <div className="hidden min-w-0 flex-1 lg:flex">{searchForm("header")}</div>
          </div>
        }
        action={
          <>
            <Button variant="primary" onClick={() => openComposer()} title="Write an email (C then M)" aria-label="Compose" shortcut={["C", "M"]} className="max-sm:size-[30px] max-sm:p-0">
              <ComposeIcon aria-hidden className="size-3.5 sm:hidden" />
              <span className="max-sm:sr-only">Compose</span>
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
                  <DropdownMenuLabel>Show mail from</DropdownMenuLabel>
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
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className={cn("min-h-0 w-full flex-col md:flex md:w-[20rem] md:shrink-0 lg:w-[25rem] xl:w-[29rem]", open ? "hidden" : "flex")}>
          <div className="flex shrink-0 flex-col gap-2 px-3 pt-2 pb-1.5 lg:pt-3">
            <PushPrompt />
            <div className="lg:hidden">{searchForm("list")}</div>
            <nav
              aria-label="Mail folders"
              className="-mx-1 flex items-center gap-0.5 overflow-x-auto px-1 pr-6 [mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)] [scrollbar-width:none]"
            >
              {splitTabs.map((tab) => {
                const active = !query.query && query.view === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => show({ ...query, view: tab.id, query: "" })}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "ease-power3-out flex h-8 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2.5 text-[13px] transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                      active ? "text-foreground bg-white/[0.07]" : "text-subtle hover:text-foreground hover:bg-white/[0.035]",
                    )}
                  >
                    {tab.label}
                    {tab.unread > 0 && <span className={cn("tabular-nums", tab.split === "important" ? "text-primary-foreground" : "text-soft")}>{tab.unread}</span>}
                  </button>
                );
              })}
              <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-current={moreLabel ? "page" : undefined}
                      className={cn(
                        "ease-power3-out flex h-8 max-w-[12em] shrink-0 cursor-pointer items-center gap-1 rounded-full px-2.5 text-[13px] transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                        moreLabel ? "text-foreground bg-white/[0.07]" : "text-subtle hover:text-foreground hover:bg-white/[0.035]",
                      )}
                    >
                      <FolderIcon aria-hidden className="size-3.5 shrink-0" />
                      <span className="truncate">{moreLabel ?? "More"}</span>
                      <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-[14rem]">
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
                      {folders.length > 0 && <DropdownMenuLabel>Your folders</DropdownMenuLabel>}
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
            </nav>
            {selectedThreads.length > 0 && (
              <div role="toolbar" aria-label="Selected conversations" className="animate-rise-in flex items-center gap-0.5 rounded-xl bg-[color-mix(in_srgb,var(--primary)_12%,transparent)] py-1 pr-1 pl-3">
                <span className="text-foreground mr-auto text-[13px] tabular-nums">{selectedThreads.length} selected</span>
                <Button variant="ghost" size="icon-sm" aria-label={primaryMove() === "inbox" ? "Move to Inbox" : "Archive"} title={primaryMove() === "inbox" ? "Move to Inbox (E)" : "Archive (E)"} onClick={() => bulk("archive")}>
                  {primaryMove() === "inbox" ? <InboxIcon aria-hidden className="size-3.5" /> : <ArchiveIcon aria-hidden className="size-3.5" />}
                </Button>
                {query.view !== "snoozed" && (
                  <Button variant="ghost" size="icon-sm" aria-label="Remind me" title="Remind me (H)" onClick={() => bulk("snooze")}>
                    <ClockIcon aria-hidden className="size-3.5" />
                  </Button>
                )}
                {query.view !== "trash" && (
                  <Button variant="ghost" size="icon-sm" aria-label="Move to Trash" title="Move to Trash (#)" onClick={() => bulk("trash")}>
                    <TrashIcon aria-hidden className="size-3.5" />
                  </Button>
                )}
                <Button variant="ghost" size="icon-sm" aria-label="Mark read or unread" title="Mark read or unread (U)" onClick={() => bulk("read")}>
                  <MailOpenIcon aria-hidden className="size-3.5" />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSelected(new Set(threads.map((thread) => thread.key)))} title="Select all (⌘A)">
                  All
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label="Clear selection" title="Clear (Esc)" onClick={() => setSelected(new Set())}>
                  <svg aria-hidden width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
                    <path d="M6 6 18 18M18 6 6 18" />
                  </svg>
                </Button>
              </div>
            )}
            {query.query && (
              <p role="status" className="caption-style text-subtle px-1">
                {loading && threads.length === 0 ? "Searching…" : `Results for “${query.query}” across every folder${query.account ? ` in ${accountLabel}` : ""}.`}
              </p>
            )}
          </div>
          <div className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-x-none">
            {ask ? (
              <AskPanel ask={ask} now={now} onOpen={(key) => select(key, true)} />
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
                        leftLabel: primaryMove() === "inbox" ? "Inbox" : "Archive",
                        restore: primaryMove() === "inbox",
                        onLeft: (key) => act(key, primaryMove()),
                        rightLabel: query.view === "snoozed" && !query.query ? null : "Remind me",
                        onRight: (key) => {
                          if (query.view !== "snoozed" || query.query) snooze([key]);
                        },
                      }
                }
              />
            )}
          </div>
        </div>
        <div className={cn("min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:my-2 md:mr-2 md:flex md:rounded-2xl md:bg-white/[0.02]", open ? "flex" : "hidden")}>
          <ThreadReader
            key={cursor ?? "none"}
            summary={current}
            detail={detail}
            error={cursor ? (detailErrors[cursor] ?? null) : null}
            own={own}
            view={viewParam}
            accounts={accounts}
            onAction={(action) => {
              if (!cursor) return;
              if (action === "snooze") snooze([cursor]);
              else act(cursor, action);
            }}
            onBack={() => setOpen(false)}
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
            onSent={() => cursor && sent(cursor)}
          />
        </div>
      </div>
    </section>
  );
}
