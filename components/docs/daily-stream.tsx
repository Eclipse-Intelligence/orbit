"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { editorView, focusNoteEnd, shownBody } from "@/components/docs/note-editor";
import StaticNote from "@/components/docs/static-note";
import type { DailySummary } from "@/lib/docs/client-types";
import { docsData } from "@/lib/docs/connection";
import { localTime, shiftDate } from "@/lib/docs/daily";
import { longDay } from "@/lib/docs/format";
import { useDocsStore } from "@/stores/docs-store";
import { cn } from "@/lib/utils";

const INITIAL_DAYS = 4;
const BATCH_DAYS = 5;
const MAX_DAYS = 31;
const SETTLE_MS = 160;
const SETTLED_EDGE = 2.5;
const SCROLLING_EDGE = 0.75;
const FREEZE_MS = 1500;
const MEASURE_MS = 300;
const FRESH_MS = 1000;
const REFRESH_MS = 5000;

type Range = { start: string; end: string };
type Anchor = { day: string; index: number; offset: number };

function around(date: string): Range {
  return { start: shiftDate(date, -INITIAL_DAYS), end: shiftDate(date, INITIAL_DAYS) };
}

function span(range: Range) {
  const days: string[] = [];
  for (let day = range.start; day <= range.end; day = shiftDate(day, 1)) days.push(day);
  return days;
}

function sectionOf(parent: HTMLElement, day: string) {
  return (Array.from(parent.children) as HTMLElement[]).find((section) => section.dataset.day === day);
}

function scrollToDay(view: HTMLElement, parent: HTMLElement, day: string) {
  const section = sectionOf(parent, day);
  if (section && view.clientHeight) view.scrollTop = section.offsetTop;
}

function liveEditor(section: HTMLElement) {
  const live = editorView();
  return live && section.contains(live.dom) && live.dom.getClientRects().length > 0 ? live : null;
}

function staticLines(section: HTMLElement) {
  return Array.from(section.querySelector(".note-editor-daily")?.querySelectorAll<HTMLElement>("[data-line]") ?? []);
}

function readAnchor(view: HTMLElement, parent: HTMLElement): Anchor | null {
  const top = view.getBoundingClientRect().top;
  const line = view.scrollTop + 1;
  const section = (Array.from(parent.children) as HTMLElement[]).find((item) => item.offsetTop <= line && line < item.offsetTop + item.offsetHeight);
  const day = section?.dataset.day;
  if (!section || !day) return null;
  const editor = liveEditor(section);
  if (editor) {
    const block = editor.lineBlockAtHeight(top + 1 - editor.documentTop);
    return { day, index: editor.state.doc.lineAt(block.from).number - 1, offset: editor.documentTop + block.top - top };
  }
  const lines = staticLines(section);
  const index = lines.findIndex((item) => item.getBoundingClientRect().bottom > top + 1);
  if (index < 0) return { day, index: -1, offset: section.getBoundingClientRect().top - top };
  return { day, index: Number(lines[index].dataset.line) - 1, offset: lines[index].getBoundingClientRect().top - top };
}

function applyAnchor(view: HTMLElement, parent: HTMLElement, held: Anchor) {
  const section = sectionOf(parent, held.day);
  if (!section) return;
  const top = view.getBoundingClientRect().top;
  let at = section.getBoundingClientRect().top - top;
  if (held.index >= 0) {
    const editor = liveEditor(section);
    if (editor) at = editor.documentTop + editor.lineBlockAt(editor.state.doc.line(Math.min(held.index + 1, editor.state.doc.lines)).from).top - top;
    else {
      const lines = staticLines(section).filter((item) => Number(item.dataset.line) <= held.index + 1);
      const line = lines[lines.length - 1];
      if (line) at = line.getBoundingClientRect().top - top;
    }
  }
  const delta = at - held.offset;
  if (Math.abs(delta) >= 1) view.scrollTop += delta;
}

function Placeholder({ text, jot = false }: { text: string; jot?: boolean }) {
  return (
    <div aria-hidden className={jot ? "cm-editor note-editor note-jot" : "cm-editor note-editor note-editor-daily"}>
      <div className="cm-scroller">
        <div className="cm-content cm-lineWrapping">
          <div className="cm-line note-blank">
            <span aria-hidden className="inline-block h-[1em] w-0 align-text-top" />
            <span className="cm-placeholder">{text}</span>
            <br />
          </div>
        </div>
      </div>
    </div>
  );
}

function Neighbour({ body }: { body: string | null }) {
  return (
    <>
      {body === null ? <div className="min-h-[1.7em]" /> : body.trim() ? <StaticNote body={body} daily /> : <Placeholder text="Write anything" />}
      <div className="grid grid-cols-[4.75rem_1fr] items-baseline">
        <span aria-hidden className="text-subtle pt-[0.32em] text-[13px] leading-[1.6] tabular-nums">
          {localTime(new Date())}
        </span>
        <div className="col-start-2 min-w-0">
          <Placeholder text="Jot something down" jot />
        </div>
      </div>
    </>
  );
}

export default function DailyStream({
  date,
  liveId,
  renderLive,
  renderHeading,
  onDate,
}: {
  date: string;
  liveId: string | null;
  renderLive: () => ReactNode;
  renderHeading: (date: string, id?: string) => ReactNode;
  onDate: (date: string) => void;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<Range>(() => around(date));
  if (date < range.start || date > range.end) setRange(around(date));
  const days = useMemo(() => span(range), [range]);
  const latest = useRef({ date, days, onDate });
  const anchor = useRef<Anchor | null>(null);
  const driven = useRef<string | null>(null);
  const wanted = useRef<string | null>(null);
  const activateDay = useRef<(day: string) => void>(() => {});
  const observer = useRef<ResizeObserver | null>(null);
  const restore = useRef<() => void>(() => {});
  const tried = useRef(new Set<string>());
  const written = useRef<number | null>(null);
  const frozen = useRef(false);
  const freeze = useRef<() => void>(() => {});
  const thaw = useRef<() => void>(() => {});
  const activatedAt = useRef(0);
  const failed = useRef(new Set<string>());
  const pinned = useRef<string | null>(null);

  const [listed, setListed] = useState<{ ids: Map<string, string>; covered: Set<string> }>(() => ({ ids: new Map(), covered: new Set() }));
  const summaries = useDocsStore((state) => state.summaries);
  const pages = useDocsStore((state) => state.pages);
  const loadPage = useDocsStore((state) => state.loadPage);
  const refreshPage = useDocsStore((state) => state.refreshPage);
  const refresh = useRef<(days: string[], now?: boolean) => void>(() => {});
  const refreshedAt = useRef(new Map<string, number>());

  useLayoutEffect(() => {
    latest.current = { date, days, onDate };
  });

  const loadRange = useCallback((start: string, end: string, current: () => boolean) => {
    void docsData()
      .listDailyNotes({ from: start, to: end })
      .then((list: DailySummary[]) => {
        if (!current()) return;
        setListed((held) => {
          const ids = new Map(held.ids);
          const covered = new Set(held.covered);
          for (let day = start; day <= end; day = shiftDate(day, 1)) {
            covered.add(day);
            ids.delete(day);
          }
          for (const item of list) ids.set(item.date, item.pageId);
          return { ids, covered };
        });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let live = true;
    for (const id of failed.current) tried.current.delete(id);
    failed.current.clear();
    loadRange(range.start, range.end, () => live);
    return () => {
      live = false;
    };
  }, [range, loadRange]);

  const idByDate = useMemo(() => {
    const ids = new Map<string, string>();
    for (const [day, id] of listed.ids) ids.set(day, id);
    for (const summary of Object.values(summaries)) if (summary.kind === "daily" && summary.dailyDate) ids.set(summary.dailyDate, summary.id);
    return ids;
  }, [listed, summaries]);

  useLayoutEffect(() => {
    refresh.current = (all, now = false) => {
      const stamp = Date.now();
      const shown = all.filter((day) => now || stamp - (refreshedAt.current.get(day) ?? 0) >= REFRESH_MS);
      if (shown.length === 0) return;
      for (const day of shown) refreshedAt.current.set(day, stamp);
      loadRange(shown[0], shown[shown.length - 1], () => true);
      for (const day of shown) {
        const id = idByDate.get(day);
        if (id) void refreshPage(id).catch(() => {});
      }
    };
  });

  useEffect(() => {
    for (const day of days) {
      const id = idByDate.get(day);
      if (!id || pages[id] || shownBody(id) !== null || tried.current.has(id)) continue;
      tried.current.add(id);
      void loadPage(id)
        .then((page) => {
          if (!page) failed.current.add(id);
        })
        .catch(() => failed.current.add(id));
    }
  }, [days, idByDate, pages, loadPage]);

  function bodyOf(day: string) {
    const id = idByDate.get(day);
    if (!id) return listed.covered.has(day) ? "" : null;
    return shownBody(id) ?? pages[id]?.body ?? null;
  }

  useLayoutEffect(() => {
    const parent = wrapper.current;
    const view = parent?.parentElement;
    if (!view || !parent) return;
    const sections = () => Array.from(parent.children) as HTMLElement[];
    let height = view.clientHeight;
    parent.style.setProperty("--day-h", `${height}px`);

    const overlap = (section: HTMLElement) => Math.min(view.scrollTop + view.clientHeight, section.offsetTop + section.offsetHeight) - Math.max(view.scrollTop, section.offsetTop);

    const dominant = () => {
      if (!view.clientHeight) return null;
      let best: string | null = null;
      let most = 0;
      for (const section of sections()) {
        const shown = overlap(section);
        if (shown > most) {
          most = shown;
          best = section.dataset.day ?? null;
        }
      }
      return best;
    };

    const extend = (edge: number) => {
      const room = edge * view.clientHeight;
      if (!room) return;
      if (view.scrollTop < room) setRange((current) => ({ ...current, start: shiftDate(current.start, -BATCH_DAYS) }));
      if (view.scrollHeight - view.scrollTop - view.clientHeight < room) setRange((current) => ({ ...current, end: shiftDate(current.end, BATCH_DAYS) }));
    };

    let thawTimer = 0;
    freeze.current = () => {
      frozen.current = true;
      window.clearTimeout(thawTimer);
      thawTimer = window.setTimeout(thaw.current, FREEZE_MS);
    };
    thaw.current = () => {
      window.clearTimeout(thawTimer);
      frozen.current = false;
      anchor.current = readAnchor(view, parent);
    };

    const lead = (day: string) => {
      anchor.current = readAnchor(view, parent);
      freeze.current();
      driven.current = day;
      window.setTimeout(() => {
        if (driven.current === day) driven.current = null;
      }, SETTLE_MS * 5);
      latest.current.onDate(day);
    };

    let frame = 0;
    let timer = 0;
    const settle = () => {
      if (frozen.current) return;
      const day = dominant();
      if (!day) return;
      refresh.current(sections().filter((section) => overlap(section) > 0).map((section) => section.dataset.day ?? ""));
      const current = latest.current.date;
      const live = sectionOf(parent, current);
      const focused = Boolean(live && live.contains(document.activeElement));
      const writing = Boolean(live && overlap(live) > 0 && (focused || pinned.current === current));
      const fresh = focused && Date.now() - activatedAt.current < FRESH_MS;
      const target = writing || fresh ? current : day;
      if (latest.current.days.length > MAX_DAYS) setRange(around(target));
      else extend(SETTLED_EDGE);
      if (target === current) return;
      pinned.current = null;
      wanted.current = view.contains(document.activeElement) ? target : null;
      lead(target);
    };
    const onScroll = () => {
      if (written.current !== null && Math.abs(view.scrollTop - written.current) < 1) written.current = null;
      else if (!frozen.current) anchor.current = readAnchor(view, parent);
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          extend(SCROLLING_EDGE);
        });
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(settle, SETTLE_MS);
    };

    restore.current = () => {
      if (!anchor.current) return;
      const before = view.scrollTop;
      applyAnchor(view, parent, anchor.current);
      if (view.scrollTop !== before) written.current = view.scrollTop;
    };
    const resized = new ResizeObserver(() => {
      const next = view.clientHeight;
      parent.style.setProperty("--day-h", `${next}px`);
      if (!height && next) {
        anchor.current = { day: latest.current.date, index: -1, offset: 0 };
      }
      height = next;
      restore.current();
    });
    resized.observe(view);
    resized.observe(parent);
    observer.current = resized;

    activateDay.current = (day) => {
      wanted.current = day;
      pinned.current = day;
      activatedAt.current = Date.now();
      refresh.current([day], true);
      lead(day);
    };
    const lost = (event: FocusEvent) => {
      const section = (event.target as HTMLElement).closest<HTMLElement>("[data-day]");
      if (section && section.dataset.day === pinned.current && !section.contains(event.relatedTarget as Node | null)) pinned.current = null;
    };
    parent.addEventListener("focusout", lost);
    const input = () => {
      if (frozen.current) thaw.current();
    };
    view.addEventListener("wheel", input, { passive: true });
    view.addEventListener("touchstart", input, { passive: true });

    view.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
      resized.disconnect();
      observer.current = null;
      view.removeEventListener("scroll", onScroll);
      parent.removeEventListener("focusout", lost);
      view.removeEventListener("wheel", input);
      view.removeEventListener("touchstart", input);
    };
  }, []);

  useLayoutEffect(() => {
    const parent = wrapper.current;
    const resized = observer.current;
    if (!parent || !resized) return;
    const watched = Array.from(parent.children);
    for (const section of watched) resized.observe(section);
    restore.current();
    return () => {
      for (const section of watched) resized.unobserve(section);
    };
  }, [days]);

  useLayoutEffect(() => {
    const parent = wrapper.current;
    const view = parent?.parentElement;
    if (!view || !parent) return;
    if (driven.current === date) {
      driven.current = null;
      return;
    }
    anchor.current = { day: date, index: -1, offset: 0 };
    freeze.current();
    refresh.current([date], true);
    const before = view.scrollTop;
    scrollToDay(view, parent, date);
    if (view.scrollTop !== before) written.current = view.scrollTop;
  }, [date]);

  useEffect(() => {
    if (!liveId) return;
    freeze.current();
    const timer = window.setTimeout(() => {
      if (frozen.current) thaw.current();
    }, MEASURE_MS);
    return () => window.clearTimeout(timer);
  }, [liveId, date]);

  useEffect(() => {
    if (!liveId || wanted.current !== date) return;
    const frame = requestAnimationFrame(() => {
      if (wanted.current !== date) return;
      wanted.current = null;
      focusNoteEnd();
    });
    return () => cancelAnimationFrame(frame);
  }, [liveId, date]);

  function open(day: string, event: MouseEvent<HTMLElement>) {
    if (day === date || (event.target as HTMLElement).closest("a")) return;
    activateDay.current(day);
  }

  return (
    <div ref={wrapper}>
      {days.map((day) => {
        const live = day === date && liveId !== null;
        return (
          <div
            key={day}
            role="group"
            aria-label={longDay(day)}
            data-day={day}
            onClick={(event) => open(day, event)}
            className={cn("border-border relative min-h-(--day-h) border-t pt-5 pb-24 first:border-t-0 md:pt-7", !live && "pointer-coarse:cursor-pointer")}
          >
            <div className="note-surface mx-auto w-full max-w-[calc(38em+4.75rem)]">
              {renderHeading(day, live ? (liveId ?? undefined) : undefined)}
              {live ? renderLive() : <Neighbour body={bodyOf(day)} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}
