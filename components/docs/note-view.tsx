"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import Button from "@/components/_ui/button";
import { Sheet, SheetCloseButton, SheetContent, SheetDescription, SheetTitle } from "@/components/_ui/sheet";
import { useShortcut } from "@/components/shortcuts/shortcuts-provider";
import { HistoryRail, VersionBanner, VersionPreview, useVersions, type Selected } from "@/components/docs/history";
import MoreMenu from "@/components/docs/more-menu";
import NoteEditor, { editorView, focusNoteText, noteTitle, scheduleNoteSave, setNoteTitle } from "@/components/docs/note-editor";
import NoteRail from "@/components/docs/note-rail";
import { ParticipantAvatar, PresenceStack } from "@/components/docs/presence";
import { PageShare } from "@/components/docs/share-control";
import { navigateWithinDocs, useDocsNav, useDocsNavigate, useDocsNow, useMedia } from "@/components/docs/use-docs";
import type { Meeting, Page, PageFilter, PageSummary, Presence } from "@/lib/docs/client-types";
import { docsData } from "@/lib/docs/connection";
import { localTime, shiftDate } from "@/lib/docs/daily";
import { clockTime, createdLabel, editedLabel, longDay, shortDay } from "@/lib/docs/format";
import { dailyHref, listHref } from "@/lib/docs/routes";
import { useDocsStore } from "@/stores/docs-store";
import { cn } from "@/lib/utils";
import ChevronLeftIcon from "@/public/assets/images/_common/chevron-left.svg";
import ChevronRightIcon from "@/public/assets/images/_common/chevron-right.svg";
import CollapseIcon from "@/public/assets/images/docs/collapse.svg";
import DocIcon from "@/public/assets/images/docs/doc.svg";
import ExpandIcon from "@/public/assets/images/docs/expand.svg";
import HashIcon from "@/public/assets/images/docs/hash.svg";
import HistoryIcon from "@/public/assets/images/docs/history.svg";
import PanelRightIcon from "@/public/assets/images/docs/panel-right.svg";
import SunIcon from "@/public/assets/images/docs/sun.svg";
import FolderIcon from "@/public/assets/images/mail/folder.svg";

function ToolButton({ label, pressed, onClick, children, shortcut }: { label: string; pressed?: boolean; onClick: () => void; children: ReactNode; shortcut?: string }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(pressed && "text-foreground bg-white/[0.07]")}
    >
      {children}
    </Button>
  );
}

function within(event: MouseEvent<HTMLElement>, href: string) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  if (navigateWithinDocs(href)) event.preventDefault();
}

function contextFor(page: { kind: string; folderId: string | null; dailyDate: string | null }, list: PageFilter, folders: { id: string; name: string }[]) {
  if (page.kind === "daily") return { label: "Daily notes", href: listHref({ kind: "daily" }), icon: SunIcon };
  if (list.kind === "tag") return { label: `#${list.path}`, href: listHref(list), icon: HashIcon };
  if (list.kind === "search") return { label: "Search", href: listHref(list), icon: DocIcon };
  const folder = page.folderId ? folders.find((item) => item.id === page.folderId) : undefined;
  if (folder) return { label: folder.name, href: listHref({ kind: "folder", folderId: folder.id }), icon: FolderIcon };
  return { label: "All notes", href: "/docs", icon: DocIcon };
}

function TitleField({ page, inputRef, replaced }: { page: Page; inputRef: RefObject<HTMLTextAreaElement | null>; replaced: boolean }) {
  const [value, setValue] = useState(() => (replaced ? page.title : (noteTitle(page.id) ?? page.title)));
  const fresh = useDocsStore((state) => state.fresh === page.id);
  const clearFresh = useDocsStore((state) => state.clearFresh);
  useEffect(() => {
    if (!fresh) return;
    inputRef.current?.focus();
    clearFresh();
  }, [fresh, clearFresh, inputRef]);
  useLayoutEffect(() => {
    const field = inputRef.current;
    if (!field) return;
    const measure = () => {
      field.style.height = "auto";
      if (field.scrollHeight) field.style.height = `${field.scrollHeight}px`;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(field);
    return () => observer.disconnect();
  }, [value, inputRef]);
  return (
    <textarea
      ref={inputRef}
      rows={1}
      value={value}
      aria-label="Title"
      placeholder="Untitled"
      spellCheck
      onChange={(event) => {
        const next = event.target.value.replace(/\n/g, " ");
        setValue(next);
        setNoteTitle(page.id, next);
        scheduleNoteSave(page.id, page);
      }}
      onKeyDown={(event) => {
        const field = event.currentTarget;
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          focusNoteText("start");
        }
        if (event.key === "ArrowDown" && field.selectionStart === field.value.length) {
          event.preventDefault();
          focusNoteText("start");
        }
      }}
      className="note-title placeholder:text-faint block w-full resize-none overflow-hidden bg-transparent outline-none"
    />
  );
}

function ConflictNotice({ id }: { id: string }) {
  const latest = useDocsStore((state) => state.conflicts[id]);
  const resolve = useDocsStore((state) => state.resolveConflict);
  if (!latest) return null;
  return (
    <div role="alert" className="mt-2 mb-6 flex w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-(--tag-amber-bg) px-3.5 py-2.5">
      <p className="ui-style text-soft min-w-0 flex-1">
        {latest.updatedBy.name} changed this note while you were editing. Your text is still here and hasn&apos;t been saved.
      </p>
      <span className="flex shrink-0 items-center gap-2">
        <Button variant="primary" size="sm" onClick={() => resolve(id, "mine")}>
          Keep mine
        </Button>
        <Button variant="secondary" size="sm" onClick={() => resolve(id, "theirs")}>
          Use theirs
        </Button>
      </span>
      <p className="caption-style text-subtle w-full">Keep mine saves your text as a new version, so theirs stays in the history.</p>
    </div>
  );
}

function SaveState({ id }: { id: string }) {
  const save = useDocsStore((state) => state.saves[id]);
  if (!save) return null;
  if (save.status === "conflict") {
    return <span className="text-(--tag-amber-text)">Not saved</span>;
  }
  if (save.status === "error") {
    return (
      <span role="alert" className="text-danger">
        {save.message ?? "Couldn't save. Your changes are kept on this device."}
      </span>
    );
  }
  return (
    <span role="status" className={cn(save.status === "offline" ? "text-(--tag-amber-text)/80" : "text-faint")}>
      {save.status === "offline" ? (save.message ?? "Offline. Kept on this device.") : save.status === "saved" ? "Saved" : "Saving"}
    </span>
  );
}

function Dot() {
  return (
    <span aria-hidden className="text-faint">
      ·
    </span>
  );
}

function NoteMeta({ page, summary }: { page: Page; summary: PageSummary }) {
  const now = useDocsNow();
  return (
    <div className="text-subtle mt-3 mb-7 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-5 max-md:mb-5">
      <span className="flex items-center gap-1.5">
        <ParticipantAvatar participant={page.createdBy} size="xs" />
        {page.createdBy.name}
      </span>
      <Dot />
      <span>{createdLabel(page.createdAt, now)}</span>
      <Dot />
      <span>{editedLabel(summary.updatedAt, now)}</span>
      <Dot />
      <span className="tabular-nums">
        {summary.wordCount} {summary.wordCount === 1 ? "word" : "words"}
      </span>
      <SaveState id={page.id} />
    </div>
  );
}

function DailyHeading({ page }: { page: Page }) {
  const date = page.dailyDate ?? "";
  const nav = useDocsNav();
  const [meetings, setMeetings] = useState<{ date: string; list: Meeting[] } | null>(null);
  useEffect(() => {
    let live = true;
    void docsData()
      .meetingsOn(date)
      .then((list) => {
        if (live) setMeetings({ date, list });
      });
    return () => {
      live = false;
    };
  }, [date]);
  const list = meetings?.date === date ? meetings.list : [];
  const today = nav?.today === date;
  return (
    <>
      <p className="eyebrow-style text-subtle mb-3 text-[11px]">Daily note</p>
      <h1 className="note-title">{longDay(date)}</h1>
      <div className="text-subtle mt-3 mb-8 flex min-h-5 flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-5">
        {list.length > 0 && (
          <>
            <span>
              {list.length} {list.length === 1 ? "meeting" : "meetings"}
              {today ? " today" : ""}:
            </span>
            {list.map((meeting, index) => (
              <span key={meeting.id} className="flex items-center gap-2">
                <Link href={meeting.href} className="text-soft hover:text-foreground underline decoration-white/15 underline-offset-[3px] transition-colors duration-150">
                  {meeting.title}, {clockTime(meeting.start)}
                </Link>
                {index < list.length - 1 && <Dot />}
              </span>
            ))}
          </>
        )}
        <SaveState id={page.id} />
      </div>
    </>
  );
}

function JotLine() {
  const [text, setText] = useState("");
  const [time, setTime] = useState(() => localTime(new Date()));
  useEffect(() => {
    const timer = window.setInterval(() => setTime(localTime(new Date())), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  function add() {
    const view = editorView();
    const clean = text.trim();
    if (!view || !clean) return;
    const stamp = localTime(new Date());
    const block = /^([-*+]|\d+[.)])\s/.test(clean) ? `${stamp}\n${clean}` : `${stamp} ${clean}`;
    const current = view.state.doc.toString();
    const end = current.replace(/\s+$/, "").length;
    const insert = `${end ? "\n\n" : ""}${block}`;
    view.dispatch({ changes: { from: end, to: view.state.doc.length, insert }, userEvent: "input.type", scrollIntoView: true });
    setText("");
    setTime(stamp);
  }

  return (
    <div className="flex flex-col">
      <label className="grid grid-cols-[4.75rem_1fr] items-baseline">
        <span aria-hidden className="text-faint pt-[0.32em] text-[13px] leading-[1.6] tabular-nums">
          {time}
        </span>
        <span className="sr-only">New entry at {time}</span>
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              add();
            }
          }}
          placeholder="Jot something down"
          className="placeholder:text-faint text-foreground col-start-2 w-full bg-transparent text-[16px] leading-[1.7] outline-none"
        />
      </label>
      <p className="caption-style text-faint mt-6 pl-[4.75rem]">Enter adds a new entry with the time. Daily notes are always private.</p>
    </div>
  );
}

export default function NoteView({
  page,
  summary,
  list,
  backHref,
  backLabel,
  missing,
  empty,
  firstRun = false,
  onNewNote,
  hiddenOnPhone,
}: {
  page: Page | null;
  summary: PageSummary | null;
  list: PageFilter;
  backHref: string;
  backLabel: string;
  missing: boolean;
  empty: boolean;
  firstRun?: boolean;
  onNewNote?: () => void;
  hiddenOnPhone: boolean;
}) {
  const nav = useDocsNav();
  const viewer = useDocsStore((state) => state.viewer) ?? nav?.viewer ?? null;
  const rail = useDocsStore((state) => state.rail);
  const railChosen = useDocsStore((state) => state.railChosen);
  const setRail = useDocsStore((state) => state.setRail);
  const focus = useDocsStore((state) => state.focus);
  const setFocus = useDocsStore((state) => state.setFocus);
  const restoreVersion = useDocsStore((state) => state.restoreVersion);
  const epoch = useDocsStore((state) => state.epochs[page?.id ?? ""] ?? 0);
  const navigate = useDocsNavigate();
  const wide = useMedia("(min-width: 1280px)");
  const phone = useMedia("(max-width: 767px)");
  const [presence, setPresence] = useState<{ id: string; list: Presence[] }>({ id: "", list: [] });
  const [selected, setSelected] = useState<Selected | null>(null);
  const [showChanges, setShowChanges] = useState(true);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pageId = page?.id ?? summary?.id ?? "";
  const historyOpen = railChosen && rail === "history";
  const versions = useVersions(pageId, historyOpen ? (page?.revision ?? 0) : -1);
  const detailsPressed = railChosen ? rail === "details" : wide;
  const daily = (page?.kind ?? summary?.kind) === "daily";

  useEffect(() => {
    if (!pageId) return;
    return docsData().watchPresence(pageId, (list) => setPresence({ id: pageId, list }));
  }, [pageId]);

  const [seenPage, setSeenPage] = useState(pageId);
  if (seenPage !== pageId) {
    setSeenPage(pageId);
    setSelected(null);
    setRestoreError(null);
  }

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [pageId]);

  const live = useMemo(() => (presence.id === pageId ? presence.list : []), [presence, pageId]);
  const stack = useMemo(() => {
    const people = live.map((entry) => entry.participant);
    return viewer && !people.some((person) => person.id === viewer.id) ? [...people, viewer] : people;
  }, [live, viewer]);

  function toggleDetails() {
    setRail(detailsPressed ? null : "details");
  }

  function toggleHistory() {
    if (historyOpen) {
      setSelected(null);
      setRail(wide ? "details" : null);
    } else setRail("history");
  }

  function exitVersion() {
    setSelected(null);
    setRestoreError(null);
  }

  useShortcut("docs-focus", () => setFocus(!focus), Boolean(page));
  useShortcut("docs-panel", toggleDetails, Boolean(page));
  useShortcut(
    "back",
    () => {
      if (selected) {
        exitVersion();
        return true;
      }
      if (focus) {
        setFocus(false);
        return true;
      }
      return false;
    },
    Boolean(selected) || focus,
  );

  async function restore() {
    if (!selected || !page) return;
    setRestoring(true);
    const error = await restoreVersion(page.id, selected.version.id);
    setRestoring(false);
    if (error) setRestoreError(error);
    else exitVersion();
  }

  const context = contextFor(page ?? summary ?? { kind: "note", folderId: null, dailyDate: null }, list, nav?.folders ?? []);
  const title = daily ? shortDay((page ?? summary)?.dailyDate ?? "") : (page?.title ?? summary?.title ?? "") || "Untitled";
  const date = (page ?? summary)?.dailyDate ?? null;
  const today = nav?.today ?? "";

  const railContent = historyOpen ? (
    <HistoryRail
      versions={versions}
      selected={selected?.version.id ?? null}
      onSelect={(value) => {
        setSelected(value);
        if (phone && value) setRail(null);
      }}
    />
  ) : page ? (
    <NoteRail page={page} />
  ) : null;

  const railVisible = !focus && !phone && (railChosen ? Boolean(rail) : true);

  if (empty) {
    return (
      <section aria-label="No note open" className={cn("flex min-h-0 min-w-0 flex-1 items-center justify-center md:my-2 md:mr-2 md:rounded-2xl md:bg-white/[0.02]", hiddenOnPhone && "max-md:hidden")}>
        <div className="flex max-w-[24em] flex-col items-center gap-3 px-6 text-center">
          {firstRun && <h2>No notes yet</h2>}
          <p className="text-subtle">
            {firstRun ? "Notes are private until you share them. Link them with [[, tag them with # and mention people and companies with @." : "Choose a note, or press C then N to start one."}
          </p>
          {onNewNote && (
            <Button variant="primary" size="sm" shortcut={["C", "N"]} onClick={onNewNote}>
              New note
            </Button>
          )}
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label={title}
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:my-2 md:mr-2 md:rounded-2xl md:bg-white/[0.02]",
        "docs-focus:md:m-0 docs-focus:md:rounded-none docs-focus:md:bg-transparent",
        hiddenOnPhone && "max-md:hidden",
      )}
    >
      <header className={cn("border-border flex shrink-0 items-center gap-2 border-b px-3 py-2.5 md:hidden", focus && "border-transparent")}>
        {!focus && (
          <Button variant="secondary" size="sm" href={backHref} onClick={(event) => within(event, backHref)} aria-label={`Back to ${backLabel}`} className="h-[30px] max-w-[45%] gap-1 pr-3 pl-2">
            <ChevronLeftIcon aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{backLabel}</span>
          </Button>
        )}
        <span className="flex-1" />
        {!focus && <PresenceStack participants={stack} />}
        {!focus && summary && <PageShare summary={summary} compact />}
        {focus ? (
          <Button variant="secondary" size="icon" aria-label="Leave focus mode" onClick={() => setFocus(false)}>
            <CollapseIcon aria-hidden className="size-3.5" />
          </Button>
        ) : (
          page && (
            <MoreMenu
              page={page}
              phone
              onRename={() => titleRef.current?.focus()}
              onToggleRail={() => setRail("details")}
              onHistory={() => setRail("history")}
              onFocus={() => setFocus(true)}
              onArchived={() => navigate(backHref)}
            />
          )
        )}
      </header>

      <div className="flex h-12 shrink-0 items-center gap-2 pr-2.5 pl-5 max-md:hidden">
        <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
          <ol className="flex min-w-0 items-center gap-1.5 text-[13px] leading-none">
            <li className="shrink-0">
              <Link href={context.href} onClick={(event) => within(event, context.href)} className="text-subtle hover:text-foreground flex items-center gap-1.5 rounded transition-colors duration-150">
                <context.icon aria-hidden className="size-3.5" />
                {context.label}
              </Link>
            </li>
            <li aria-hidden className="text-faint">
              <ChevronRightIcon className="size-3" />
            </li>
            <li aria-current="page" className="text-soft min-w-0 truncate">
              {title}
            </li>
          </ol>
        </nav>
        <div className="flex shrink-0 items-center gap-1">
          {stack.length > 0 && !focus && (
            <span className="mr-1.5">
              <PresenceStack participants={stack} />
            </span>
          )}
          {daily && date && (
            <span className="mr-1 flex items-center gap-1">
              <Button variant="ghost" size="icon" aria-label="Previous day" title="Previous day" onClick={() => navigate(dailyHref(shiftDate(date, -1)))}>
                <ChevronLeftIcon aria-hidden className="size-3.5" />
              </Button>
              <Button variant="secondary" size="sm" className="h-[30px] px-3" disabled={date === today} title="Today (G then D)" onClick={() => navigate(dailyHref(today))}>
                Today
              </Button>
              <Button variant="ghost" size="icon" aria-label="Next day" title="Next day" disabled={date >= today} onClick={() => navigate(dailyHref(shiftDate(date, 1)))}>
                <ChevronRightIcon aria-hidden className="size-3.5" />
              </Button>
            </span>
          )}
          {!daily && summary && !focus && <PageShare summary={summary} />}
          {!focus && (
            <>
              <ToolButton label="Version history" pressed={historyOpen} onClick={toggleHistory}>
                <HistoryIcon aria-hidden className="size-3.5" />
              </ToolButton>
              <ToolButton label="Backlinks and details" pressed={detailsPressed && !historyOpen} onClick={toggleDetails} shortcut="⌘\">
                <PanelRightIcon aria-hidden className="size-3.5" />
              </ToolButton>
            </>
          )}
          <ToolButton label={focus ? "Leave focus mode" : "Focus mode"} pressed={focus} onClick={() => setFocus(!focus)} shortcut={focus ? "Esc" : "⌘⇧↵"}>
            {focus ? <CollapseIcon aria-hidden className="size-3.5" /> : <ExpandIcon aria-hidden className="size-3.5" />}
          </ToolButton>
          {page && !focus && (
            <MoreMenu
              page={page}
              phone={false}
              onRename={() => titleRef.current?.focus()}
              onToggleRail={toggleDetails}
              onHistory={toggleHistory}
              onFocus={() => setFocus(true)}
              onArchived={() => navigate(backHref)}
            />
          )}
        </div>
      </div>

      {selected && page && (
        <VersionBanner
          selected={selected}
          showChanges={showChanges}
          onShowChanges={setShowChanges}
          onRestore={() => void restore()}
          onBack={exitVersion}
          pending={restoring}
          error={restoreError}
        />
      )}

      <div className="relative flex min-h-0 flex-1">
        <div ref={scroller} className="relative min-h-0 min-w-0 flex-1 overflow-y-auto px-5 pt-5 pb-40 md:px-12 md:pt-7">
          <div className={cn("note-surface mx-auto w-full", daily ? "max-w-[calc(38em+4.75rem)]" : "note-measure")}>
            {page ? (
              <>
                {daily ? (
                  <DailyHeading page={page} />
                ) : (
                  <>
                    <TitleField key={`${page.id}:${epoch}`} page={page} inputRef={titleRef} replaced={epoch > 0} />
                    {summary && <NoteMeta page={page} summary={summary} />}
                  </>
                )}
                {!selected && <ConflictNotice id={page.id} />}
                {selected && <VersionPreview page={page} selected={selected} showChanges={showChanges} />}
                <div className={cn(selected && "hidden")}>
                  <NoteEditor
                    page={page}
                    presence={live}
                    list={list}
                    placeholder={daily ? "Write anything" : "Start writing"}
                    onEscape={() => {
                      if (!focus) return false;
                      setFocus(false);
                      return true;
                    }}
                    onTitleFocus={() => {
                      const field = titleRef.current;
                      if (!field) return false;
                      field.focus();
                      field.setSelectionRange(field.value.length, field.value.length);
                      return true;
                    }}
                  />
                </div>
                {daily && !selected && <JotLine />}
              </>
            ) : missing ? (
              <div role="alert" className="flex flex-col items-start gap-3 pt-1">
                <h1 className="note-title">This note isn&apos;t available</h1>
                <p className="text-subtle">It may have been archived, or it isn&apos;t shared with you.</p>
                <Button variant="secondary" size="sm" href={backHref} onClick={(event) => within(event, backHref)}>
                  Back to {backLabel}
                </Button>
              </div>
            ) : (
              <div role="status" aria-label="Loading the note" className="flex flex-col gap-4 pt-1">
                <span className="h-8 w-2/3 rounded-lg bg-white/[0.04]" />
                <span className="h-4 w-1/3 rounded bg-white/[0.03]" />
                <span className="mt-4 h-4 w-full rounded bg-white/[0.03]" />
                <span className="h-4 w-5/6 rounded bg-white/[0.03]" />
              </div>
            )}
          </div>
        </div>
        {railVisible && railContent && (
          <aside
            aria-label={historyOpen ? "Version history" : "Backlinks and details"}
            className={cn(
              "flex min-h-0 w-[16.5rem] shrink-0 flex-col overflow-y-auto border-l border-white/[0.05]",
              !railChosen && "hidden xl:flex",
              railChosen && "max-xl:bg-background max-xl:absolute max-xl:inset-y-0 max-xl:right-0 max-xl:z-10 max-xl:shadow-[-24px_0_48px_rgba(0,0,0,0.45)]",
            )}
          >
            {railContent}
          </aside>
        )}
      </div>

      <Sheet open={phone && railChosen && Boolean(rail)} onOpenChange={(open) => !open && setRail(null)}>
        <SheetContent side="bottom" className="bg-popover border-line-strong max-h-[80dvh] overflow-y-auto rounded-t-2xl">
          <SheetTitle className="sr-only">{historyOpen ? "Version history" : "Backlinks and details"}</SheetTitle>
          <SheetDescription className="sr-only">{historyOpen ? "Earlier versions of this note" : "Notes that link here, records and tags"}</SheetDescription>
          <SheetCloseButton label="Close" className="absolute top-3 right-3 z-10 mr-0" />
          <div className="pt-2">{railContent}</div>
        </SheetContent>
      </Sheet>
    </section>
  );
}
