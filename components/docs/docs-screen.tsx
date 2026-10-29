"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import Button from "@/components/_ui/button";
import { Kbd } from "@/components/_ui/command";
import SectionHeader from "@/components/crm/section-header";
import type { Viewer } from "@/components/crm/viewer";
import DailyList from "@/components/docs/daily-list";
import DocsNotice from "@/components/docs/docs-notice";
import { ListPane, NoteRow, RowList, SortMenu, SharedGlyph } from "@/components/docs/note-list";
import NoteView from "@/components/docs/note-view";
import { ParticipantAvatar } from "@/components/docs/presence";
import { FolderShare } from "@/components/docs/share-control";
import { navigateWithinDocs, useDocsNav, useDocsNavigate, useDocsNow } from "@/components/docs/use-docs";
import { DocsError, type DailySummary, type Folder, type Page, type PageFilter, type PageSummary, type TagNode } from "@/lib/docs/client-types";
import { entryCount } from "@/lib/docs/markdown";
import { longDay } from "@/lib/docs/format";
import { dailyHref, listHref, listKey, pageHref, parseDocsRoute, sameList } from "@/lib/docs/routes";
import type { DocsInitial } from "@/lib/docs/server";
import { useDocsStore } from "@/stores/docs-store";
import { cn } from "@/lib/utils";
import ChevronLeftIcon from "@/public/assets/images/_common/chevron-left.svg";
import ChevronRightIcon from "@/public/assets/images/_common/chevron-right.svg";
import PlusIcon from "@/public/assets/images/_common/plus.svg";
import SearchIcon from "@/public/assets/images/_common/search.svg";
import DocIcon from "@/public/assets/images/docs/doc.svg";
import HashIcon from "@/public/assets/images/docs/hash.svg";
import LockIcon from "@/public/assets/images/docs/lock.svg";
import SunIcon from "@/public/assets/images/docs/sun.svg";
import FolderIcon from "@/public/assets/images/mail/folder.svg";

const EMPTY: string[] = [];

type LoadError = { id: string; message: string; signIn: boolean };

function loadErrorOf(id: string, error: unknown): LoadError {
  const signIn = error instanceof DocsError && (error.code === "401" || error.code === "unauthorized");
  const text = error instanceof Error && error.message ? error.message : "Docs didn't respond. Try again in a moment.";
  return { id, message: text, signIn };
}

function LoadFailure({ failure, what, onRetry }: { failure: LoadError; what: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 pt-1">
      <h2>{what}</h2>
      <p className="text-subtle">{failure.message}</p>
      {failure.signIn ? (
        <Button variant="primary" size="sm" href="/login">
          Sign in again
        </Button>
      ) : (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

function within(event: MouseEvent<HTMLElement>, href: string) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  if (navigateWithinDocs(href)) event.preventDefault();
}

function DocsSearch({ value, onChange, className, big }: { value: string; onChange: (value: string) => void; className?: string; big?: boolean }) {
  return (
    <form role="search" className={cn("relative w-full", className)} onSubmit={(event) => event.preventDefault()}>
      <label className="contents">
        <span className="sr-only">Search docs</span>
        <SearchIcon aria-hidden className={cn("text-subtle pointer-events-none absolute top-1/2 size-3.5 -translate-y-1/2", big ? "left-3.5" : "left-3")} />
        <input
          type="search"
          data-docs-search=""
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && value) {
              event.preventDefault();
              event.stopPropagation();
              onChange("");
            }
          }}
          placeholder="Search docs"
          autoComplete="off"
          className={cn(
            "placeholder:text-subtle text-foreground ease-power3-out focus-visible:ring-ring/40 w-full rounded-xl bg-white/[0.04] transition-colors duration-150 outline-none focus:bg-white/[0.06] focus-visible:ring-2 [&::-webkit-search-cancel-button]:hidden",
            big ? "h-10 pr-3 pl-10 text-[16px]" : "h-8 pr-20 pl-9 text-[14px]",
          )}
        />
      </label>
      {!big && (
        <span aria-hidden className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-0.5">
          <Kbd>⌘</Kbd>
          <Kbd>⇧</Kbd>
          <Kbd>F</Kbd>
        </span>
      )}
    </form>
  );
}

function folderMark(folder: Folder, viewerId: string | undefined) {
  if (!folder.shared) return null;
  if (folder.owner.id !== viewerId) {
    return (
      <span className="flex shrink-0 items-center" title={`Shared by ${folder.owner.name}`}>
        <ParticipantAvatar participant={folder.owner} size="xs" />
        <span className="sr-only">Shared by {folder.owner.name}</span>
      </span>
    );
  }
  return <SharedGlyph />;
}

function HomeRow({ icon, label, href, trailing, depth = 0 }: { icon: ReactNode; label: string; href: string; trailing?: ReactNode; depth?: number }) {
  return (
    <li>
      <Link
        href={href}
        onClick={(event) => within(event, href)}
        className="focus-visible:ring-ring/60 flex h-11 items-center gap-3 rounded-xl pr-2 transition-colors duration-150 outline-none focus-visible:ring-2 active:bg-white/[0.05]"
        style={{ paddingLeft: `${0.75 + depth * 1.25}rem` }}
      >
        {icon}
        <span className="text-foreground min-w-0 flex-1 truncate text-[15px]">{label}</span>
        {trailing}
        <ChevronRightIcon aria-hidden className="text-faint size-3 shrink-0" />
      </Link>
    </li>
  );
}

function HomeTags({ tags, depth }: { tags: TagNode[]; depth: number }) {
  return tags.map((tag) => (
    <HomeTag key={tag.path} tag={tag} depth={depth} />
  ));
}

function HomeTag({ tag, depth }: { tag: TagNode; depth: number }) {
  return (
    <>
      <HomeRow
        icon={<HashIcon aria-hidden className="text-subtle size-4 shrink-0" />}
        label={tag.name}
        href={listHref({ kind: "tag", path: tag.path })}
        depth={depth}
        trailing={<span className="caption-style text-subtle tabular-nums">{tag.count}</span>}
      />
      {tag.children.length > 0 && <HomeTags tags={tag.children} depth={depth + 1} />}
    </>
  );
}

function DocsHome({ search, onSearch }: { search: string; onSearch: (value: string) => void }) {
  const nav = useDocsNav();
  const viewerId = nav?.viewer.id;
  const today = nav?.todayNote;
  const depthOf = (folder: Folder) => {
    let depth = 0;
    let parent = folder.parentId;
    while (parent && depth < 6) {
      depth += 1;
      parent = nav?.folders.find((item) => item.id === parent)?.parentId ?? null;
    }
    return depth;
  };
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-28 md:hidden">
      <DocsSearch value={search} onChange={onSearch} big />
      {nav && (
        <Link
          href={dailyHref(nav.today)}
          onClick={(event) => within(event, dailyHref(nav.today))}
          className="focus-visible:ring-ring/60 mt-3 flex flex-col gap-2 rounded-2xl bg-white/[0.035] p-4 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)] outline-none focus-visible:ring-2"
        >
          <span className="flex items-center gap-2">
            <SunIcon aria-hidden className="size-4 text-(--tag-amber-text)" />
            <span className="eyebrow-style text-subtle text-[11px]">Today</span>
            <span className="caption-style text-subtle ml-auto flex items-center gap-1">
              <LockIcon aria-hidden className="size-3" />
              {today ? `${today.entries} ${today.entries === 1 ? "entry" : "entries"}` : "Only you"}
            </span>
          </span>
          <span className="text-foreground text-[17px] leading-6 font-semibold tracking-[-0.01em]">{longDay(nav.today)}</span>
          <span className="text-subtle truncate text-[14px] leading-5">{today?.preview || "Jot something down"}</span>
        </Link>
      )}
      <div className="mt-5 flex flex-col gap-5">
        <section className="flex flex-col gap-1">
          <h2 className="eyebrow-style text-subtle px-3 pb-1 text-[11px] font-medium">Folders</h2>
          <ul className="flex flex-col">
            <HomeRow icon={<DocIcon aria-hidden className="text-subtle size-4 shrink-0" />} label="All notes" href={listHref({ kind: "all" }) + "?in=all"} />
            {(nav?.folders ?? []).map((folder) => (
              <HomeRow
                key={folder.id}
                icon={<FolderIcon aria-hidden className="text-subtle size-4 shrink-0" />}
                label={folder.name}
                href={listHref({ kind: "folder", folderId: folder.id })}
                depth={depthOf(folder)}
                trailing={
                  <span className="flex items-center gap-2">
                    {folderMark(folder, viewerId)}
                    <span className="caption-style text-subtle tabular-nums">{folder.noteCount}</span>
                  </span>
                }
              />
            ))}
          </ul>
        </section>
        {(nav?.tags.length ?? 0) > 0 && (
          <section className="flex flex-col gap-1">
            <h2 className="eyebrow-style text-subtle px-3 pb-1 text-[11px] font-medium">Tags</h2>
            <ul className="flex flex-col">
              <HomeTags tags={nav?.tags ?? []} depth={0} />
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

function listTitle(list: PageFilter, folders: Folder[]) {
  if (list.kind === "folder") return folders.find((folder) => folder.id === list.folderId)?.name ?? "Folder";
  if (list.kind === "tag") return `#${list.path}`;
  if (list.kind === "search") return `“${list.query}”`;
  if (list.kind === "daily") return "Daily notes";
  return "All notes";
}

function listIcon(list: PageFilter) {
  if (list.kind === "folder") return FolderIcon;
  if (list.kind === "tag") return HashIcon;
  if (list.kind === "search") return SearchIcon;
  if (list.kind === "daily") return SunIcon;
  return DocIcon;
}

export default function DocsScreen({ viewer, initial }: { viewer: Viewer; initial: DocsInitial }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const route = useMemo(() => parseDocsRoute(pathname, params), [pathname, params]);
  const navigate = useDocsNavigate();
  const nav = useDocsNav();
  const now = useDocsNow();
  const ready = useDocsStore((state) => state.ready);
  const sort = useDocsStore((state) => state.sort);
  const key = `${listKey(route.list)}|${sort}`;
  const storedIds = useDocsStore((state) => state.lists[key]);
  const summaries = useDocsStore((state) => state.summaries);
  const pages = useDocsStore((state) => state.pages);
  const activity = useDocsStore((state) => state.activity);
  const loadList = useDocsStore((state) => state.loadList);
  const loadPage = useDocsStore((state) => state.loadPage);
  const prefetch = useDocsStore((state) => state.prefetch);
  const openDaily = useDocsStore((state) => state.openDaily);
  const visit = useDocsStore((state) => state.visit);
  const createNote = useDocsStore((state) => state.createNote);
  const initialMap = useMemo(() => new Map(initial.summaries.map((summary) => [summary.id, summary])), [initial.summaries]);
  const seeded = useRef(false);
  const setFocus = useDocsStore((state) => state.setFocus);

  useEffect(() => () => setFocus(false), [setFocus]);

  useLayoutEffect(() => {
    if (seeded.current || !ready) return;
    seeded.current = true;
    useDocsStore.getState().seed(initial);
  }, [ready, initial]);

  const fallbackIds = !ready && sameList(initial.list, route.list) && sort === "edited" ? initial.summaries.map((summary) => summary.id) : null;
  const rawIds = storedIds ?? fallbackIds ?? EMPTY;
  const summaryOf = useCallback((id: string): PageSummary | undefined => summaries[id] ?? initialMap.get(id), [summaries, initialMap]);

  const ids = useMemo(() => {
    const present = rawIds.filter((id) => summaryOf(id));
    if (sort !== "edited" || route.list.kind === "search" || route.list.kind === "daily") return present;
    return [...present].sort((left, right) => (summaryOf(right)?.updatedAt ?? "").localeCompare(summaryOf(left)?.updatedAt ?? ""));
  }, [rawIds, summaryOf, sort, route.list.kind]);

  const listLoaded = Boolean(storedIds);
  const routeList = useRef(route.list);
  useLayoutEffect(() => {
    routeList.current = route.list;
  });
  const revalidated = useRef<string | null>(null);
  const [listError, setListError] = useState<LoadError | null>(null);
  const [listAttempt, setListAttempt] = useState(0);
  useEffect(() => {
    if (!ready) return;
    if (listLoaded && revalidated.current === key) return;
    revalidated.current = key;
    let live = true;
    void loadList(routeList.current, listLoaded)
      .then(() => {
        if (live) setListError(null);
      })
      .catch((error: unknown) => {
        if (live) setListError(loadErrorOf(key, error));
      });
    return () => {
      live = false;
    };
  }, [ready, key, listLoaded, loadList, listAttempt]);
  const retryList = useCallback(() => {
    setListError(null);
    revalidated.current = null;
    setListAttempt((value) => value + 1);
  }, []);

  const today = nav?.today ?? "";
  const dailyDate = route.list.kind === "daily" && !route.pageId ? (route.date ?? today) : null;
  const dailyId = useMemo(() => {
    if (!dailyDate) return null;
    if (initial.page?.dailyDate === dailyDate) return initial.page.id;
    for (const summary of Object.values(summaries)) if (summary.dailyDate === dailyDate) return summary.id;
    return null;
  }, [dailyDate, summaries, initial.page]);

  useEffect(() => {
    if (ready && dailyDate && !dailyId) void openDaily(dailyDate);
  }, [ready, dailyDate, dailyId, openDaily]);

  const shownId = route.pageId ?? (dailyDate ? dailyId : (ids[0] ?? null));
  const page: Page | null = shownId ? (pages[shownId] ?? (initial.page?.id === shownId ? initial.page : null)) : null;
  const shownSummary = shownId ? (summaryOf(shownId) ?? (page ?? undefined)) : undefined;

  const [missing, setMissing] = useState<string | null>(null);
  const [pageError, setPageError] = useState<LoadError | null>(null);
  const [errorFor, setErrorFor] = useState(shownId);
  if (errorFor !== shownId) {
    setErrorFor(shownId);
    if (pageError) setPageError(null);
  }
  const pageFailed = Boolean(shownId) && pageError?.id === shownId;
  const shownLoaded = Boolean(shownId && pages[shownId]);
  useEffect(() => {
    if (!ready || !shownId || shownLoaded || pageFailed) return;
    let live = true;
    void loadPage(shownId)
      .then((found) => {
        if (live && !found) setMissing(shownId);
      })
      .catch((error: unknown) => {
        if (live) setPageError(loadErrorOf(shownId, error));
      });
    return () => {
      live = false;
    };
  }, [ready, shownId, shownLoaded, pageFailed, loadPage]);

  useEffect(() => {
    if (ready && route.pageId) visit(route.pageId);
  }, [ready, route.pageId, visit]);

  useEffect(() => {
    if (ready) prefetch(ids.slice(0, 8));
  }, [ready, ids, prefetch]);

  const queryParam = route.list.kind === "search" ? route.list.query : "";
  const [search, setSearch] = useState(queryParam);
  const [seenQuery, setSeenQuery] = useState(queryParam);
  if (seenQuery !== queryParam) {
    setSeenQuery(queryParam);
    setSearch(queryParam);
  }
  const searchTimer = useRef(0);
  function onSearch(value: string) {
    setSearch(value);
    window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      const query = value.trim();
      navigate(query ? listHref({ kind: "search", query }) : "/docs", { replace: route.list.kind === "search" });
    }, 160);
  }

  useEffect(() => {
    if (params.get("search") !== "1") return;
    const field = [...document.querySelectorAll<HTMLInputElement>("[data-docs-search]")].find((item) => item.getClientRects().length > 0);
    field?.focus();
    window.history.replaceState(null, "", "/docs");
  }, [params]);

  const onOpen = useCallback(
    (id: string, href: string, event: MouseEvent<HTMLAnchorElement>) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      navigate(href);
    },
    [navigate],
  );

  const prefetchOne = useCallback((id: string) => prefetch([id]), [prefetch]);

  const onMove = useCallback((id: string) => navigate(pageHref(id, route.list), { replace: true }), [navigate, route.list]);

  async function newNote() {
    const folderId = route.list.kind === "folder" ? route.list.folderId : null;
    const created = await createNote({ folderId });
    if (created) navigate(pageHref(created.id, route.list.kind === "folder" ? route.list : { kind: "all" }));
  }

  const folders = nav?.folders ?? [];
  const list = route.list;
  const folder = list.kind === "folder" ? folders.find((item) => item.id === list.folderId) : undefined;
  const title = listTitle(list, folders);
  const Icon = listIcon(list);
  const level = route.level === "home" && list.kind === "all" && params.get("in") === "all" ? "list" : route.level;
  const listSummaries = ids.map((id) => summaryOf(id)).filter((summary): summary is PageSummary => Boolean(summary));
  const dailyInitial: DailySummary[] = useMemo(
    () =>
      initial.summaries
        .filter((summary) => summary.kind === "daily" && summary.dailyDate && summary.entryCount > 0)
        .map((summary) => ({ date: summary.dailyDate as string, pageId: summary.id, entries: summary.entryCount || entryCount(""), preview: summary.snippet })),
    [initial.summaries],
  );

  const dailyShown = list.kind === "daily" || shownSummary?.kind === "daily";
  const backHref = dailyShown ? listHref({ kind: "daily" }) : list.kind === "all" ? "/docs?in=all" : listHref(list);
  const backLabel = dailyShown ? "Daily notes" : list.kind === "all" ? "All notes" : title;

  const control =
    list.kind === "daily" ? (
      <span className="caption-style text-subtle mr-2 flex items-center gap-1">
        <LockIcon aria-hidden className="size-3" />
        Only you
      </span>
    ) : (
      <>
        {list.kind !== "search" && <SortMenu />}
        {folder && <FolderShare folder={folder} summaries={listSummaries} />}
      </>
    );

  const newNoteButton = (
    <Button variant="primary" shortcut={["C", "N"]} onClick={() => void newNote()} aria-label="New note" title="New note (C then N)" className="max-sm:size-[30px] max-sm:p-0">
      <PlusIcon aria-hidden className="size-3 sm:hidden" />
      <span className="max-sm:sr-only">New note</span>
    </Button>
  );

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className={cn("docs-focus:hidden", level !== "home" && "max-md:hidden")}>
        <SectionHeader
          title="Docs"
          viewer={viewer}
          heading={
            <div className="flex min-w-0 items-center gap-5">
              <h1 className="shrink-0">Docs</h1>
              <div className="hidden min-w-0 flex-1 lg:flex">
                <DocsSearch value={search} onChange={onSearch} className="max-w-[26rem]" />
              </div>
            </div>
          }
          action={newNoteButton}
        />
      </div>

      {level === "list" && (
        <header className="border-border shrink-0 border-b md:hidden">
          <div className="flex items-center gap-2 px-3 py-2.5">
            <Button variant="secondary" size="icon" href="/docs" onClick={(event) => within(event, "/docs")} aria-label="Back to Docs">
              <ChevronLeftIcon aria-hidden className="size-3.5" />
            </Button>
            <h1 className="min-w-0 flex-1 truncate">{title}</h1>
            {folder && <FolderShare folder={folder} summaries={listSummaries} />}
            {list.kind === "daily" ? (
              <Button variant="primary" size="icon" aria-label="Today's daily note" onClick={() => navigate(dailyHref(today))}>
                <SunIcon aria-hidden className="size-3.5" />
              </Button>
            ) : (
              <Button variant="primary" size="icon" aria-label={folder ? `New note in ${folder.name}` : "New note"} onClick={() => void newNote()}>
                <PlusIcon aria-hidden className="size-3.5" />
              </Button>
            )}
          </div>
        </header>
      )}

      <div className="flex min-h-0 flex-1">
        {level === "home" && <DocsHome search={search} onSearch={onSearch} />}
        <ListPane icon={Icon} title={title} count={list.kind === "daily" ? undefined : ids.length} control={control} hiddenOnPhone={level !== "list"}>
          {list.kind === "daily" ? (
            <DailyList selected={dailyDate ?? (page?.kind === "daily" ? page.dailyDate : null)} initial={dailyInitial} />
          ) : (
            <>
              {folder && (
                <p className="caption-style text-subtle flex items-center gap-1.5 px-4 pt-1 pb-2 md:hidden">
                  {folder.shared ? <SharedGlyph /> : <LockIcon aria-hidden className="size-3" />}
                  {folder.shared ? "Shared with workspace" : "Private"} <span aria-hidden>·</span> {ids.length} {ids.length === 1 ? "note" : "notes"}
                </p>
              )}
              {ids.length === 0 && listError?.id === key ? (
                <div className="px-3 py-4">
                  <LoadFailure failure={listError} what="This list didn't load" onRetry={retryList} />
                </div>
              ) : ids.length === 0 ? (
                <div className="flex flex-col items-start gap-3 px-3 py-4">
                  <p className="text-subtle">{list.kind === "search" ? `Nothing matches “${list.query}”.` : "No notes here yet."}</p>
                  {list.kind !== "search" && (
                    <Button variant="secondary" size="sm" onClick={() => void newNote()}>
                      New note
                    </Button>
                  )}
                </div>
              ) : (
                <RowList label={title} onMove={onMove}>
                  {listSummaries.map((summary, index) => {
                    const href = pageHref(summary.id, list);
                    const active = summary.id === shownId;
                    const folderShared = Boolean(summary.folderId && folders.find((item) => item.id === summary.folderId)?.shared);
                    return (
                      <NoteRow
                        key={summary.id}
                        summary={summary}
                        href={href}
                        active={active}
                        wideOnly={!route.pageId}
                        tabbable={shownId ? active : index === 0}
                        writers={activity[summary.id] ?? EMPTY_PEOPLE}
                        now={now}
                        folderShared={folderShared}
                        onOpen={onOpen}
                        onPrefetch={prefetchOne}
                      />
                    );
                  })}
                </RowList>
              )}
            </>
          )}
        </ListPane>
        {pageFailed && pageError && !page ? (
          <section
            aria-label="Note didn't load"
            className={cn("flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-5 pt-5 md:my-2 md:mr-2 md:rounded-2xl md:bg-white/[0.02] md:px-12 md:pt-7", level !== "note" && "max-md:hidden")}
          >
            <div className="note-measure mx-auto flex w-full flex-col items-start gap-5">
              <Button variant="secondary" size="sm" href={backHref} onClick={(event) => within(event, backHref)} className="md:hidden">
                Back to {backLabel}
              </Button>
              <LoadFailure failure={pageError} what="This note didn't load" onRetry={() => setPageError(null)} />
            </div>
          </section>
        ) : (
          <NoteView
            page={page}
            summary={shownSummary ?? null}
            list={list}
            backHref={backHref}
            backLabel={backLabel}
            missing={Boolean(shownId) && missing === shownId && !page}
            empty={!shownId && !dailyDate}
            firstRun={list.kind === "all" && ids.length === 0 && (listLoaded || fallbackIds !== null)}
            onNewNote={() => void newNote()}
            hiddenOnPhone={level !== "note"}
          />
        )}
      </div>
      <DocsNotice />
    </section>
  );
}

const EMPTY_PEOPLE: never[] = [];
