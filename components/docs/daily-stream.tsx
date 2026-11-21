"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { focusNoteEnd, noteBody } from "@/components/docs/note-editor";
import StaticNote from "@/components/docs/static-note";
import type { DailySummary } from "@/lib/docs/client-types";
import { docsData } from "@/lib/docs/connection";
import { localTime, shiftDate } from "@/lib/docs/daily";
import { longDay } from "@/lib/docs/format";
import { useDocsStore } from "@/stores/docs-store";

const INITIAL_DAYS = 4;
const BATCH_DAYS = 5;
const MAX_DAYS = 31;
const SETTLE_MS = 160;
const HOLD_MS = 800;
const SETTLED_EDGE = 2.5;
const SCROLLING_EDGE = 0.75;

type Range = { start: string; end: string };
type Anchor = { day: string; offset: number; until: number; first: string | null };

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

function applyAnchor(view: HTMLElement, parent: HTMLElement, held: Anchor) {
  const section = sectionOf(parent, held.day);
  if (!section) return;
  const delta = section.offsetTop - held.offset - view.scrollTop;
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

function Neighbour({ heading, body }: { heading: ReactNode; body: string | null }) {
  return (
    <>
      {heading}
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
  liveReady,
  renderLive,
  renderHeading,
  onDate,
}: {
  date: string;
  liveReady: boolean;
  renderLive: () => ReactNode;
  renderHeading: (date: string) => ReactNode;
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

  const [listed, setListed] = useState<{ ids: Map<string, string>; covered: Set<string> }>(() => ({ ids: new Map(), covered: new Set() }));
  const summaries = useDocsStore((state) => state.summaries);
  const pages = useDocsStore((state) => state.pages);
  const loadPage = useDocsStore((state) => state.loadPage);

  useLayoutEffect(() => {
    latest.current = { date, days, onDate };
  });

  useEffect(() => {
    let live = true;
    const { start, end } = range;
    void docsData()
      .listDailyNotes({ from: start, to: end })
      .then((list: DailySummary[]) => {
        if (!live) return;
        setListed((current) => {
          const ids = new Map(current.ids);
          const covered = new Set(current.covered);
          for (let day = start; day <= end; day = shiftDate(day, 1)) {
            covered.add(day);
            ids.delete(day);
          }
          for (const item of list) ids.set(item.date, item.pageId);
          return { ids, covered };
        });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [range]);

  const idByDate = useMemo(() => {
    const ids = new Map<string, string>();
    for (const [day, id] of listed.ids) ids.set(day, id);
    for (const summary of Object.values(summaries)) if (summary.kind === "daily" && summary.dailyDate) ids.set(summary.dailyDate, summary.id);
    return ids;
  }, [listed, summaries]);

  useEffect(() => {
    for (const day of days) {
      const id = idByDate.get(day);
      if (id && !pages[id] && noteBody(id) === null) void loadPage(id).catch(() => {});
    }
  }, [days, idByDate, pages, loadPage]);

  function bodyOf(day: string) {
    const id = idByDate.get(day);
    if (!id) return listed.covered.has(day) ? "" : null;
    return noteBody(id) ?? pages[id]?.body ?? null;
  }

  useLayoutEffect(() => {
    const parent = wrapper.current;
    const view = parent?.parentElement;
    if (!view || !parent) return;
    const sections = () => Array.from(parent.children) as HTMLElement[];
    const find = (day: string) => sectionOf(parent, day);
    let height = view.clientHeight;
    parent.style.setProperty("--day-h", `${height}px`);

    const dominant = () => {
      if (!view.clientHeight) return null;
      const top = view.scrollTop;
      const bottom = top + view.clientHeight;
      let best: string | null = null;
      let most = 0;
      for (const section of sections()) {
        const overlap = Math.min(bottom, section.offsetTop + section.offsetHeight) - Math.max(top, section.offsetTop);
        if (overlap > most) {
          most = overlap;
          best = section.dataset.day ?? null;
        }
      }
      return best;
    };

    const hold = (day: string, once: boolean) => {
      const section = find(day);
      anchor.current = section ? { day, offset: section.offsetTop - view.scrollTop, until: Date.now() + HOLD_MS, first: once ? latest.current.days[0] : null } : null;
    };

    const restore = () => {
      const held = anchor.current;
      if (held && held.first === null && Date.now() <= held.until) applyAnchor(view, parent, held);
    };

    const extend = (edge: number) => {
      const room = edge * view.clientHeight;
      if (!room) return;
      if (view.scrollTop < room) {
        hold(dominant() ?? latest.current.date, true);
        setRange((current) => ({ ...current, start: shiftDate(current.start, -BATCH_DAYS) }));
      }
      if (view.scrollHeight - view.scrollTop - view.clientHeight < room) setRange((current) => ({ ...current, end: shiftDate(current.end, BATCH_DAYS) }));
    };

    const lead = (day: string) => {
      driven.current = day;
      window.setTimeout(() => {
        if (driven.current === day) driven.current = null;
      }, HOLD_MS);
      latest.current.onDate(day);
    };

    let frame = 0;
    let timer = 0;
    const settle = () => {
      const day = dominant();
      if (!day) return;
      if (latest.current.days.length > MAX_DAYS) {
        hold(day, true);
        setRange(around(day));
      } else extend(SETTLED_EDGE);
      if (day === latest.current.date) return;
      wanted.current = view.contains(document.activeElement) ? day : null;
      hold(day, false);
      lead(day);
    };
    const onScroll = () => {
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          extend(SCROLLING_EDGE);
        });
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(settle, SETTLE_MS);
    };
    const release = () => {
      if (anchor.current?.first === null) anchor.current = null;
    };

    const observer = new ResizeObserver(() => {
      const next = view.clientHeight;
      parent.style.setProperty("--day-h", `${next}px`);
      if (!height && next) scrollToDay(view, parent, latest.current.date);
      height = next;
      restore();
    });
    observer.observe(view);
    observer.observe(parent);

    activateDay.current = (day) => {
      wanted.current = day;
      hold(day, false);
      lead(day);
    };

    view.addEventListener("scroll", onScroll, { passive: true });
    view.addEventListener("wheel", release, { passive: true });
    view.addEventListener("touchstart", release, { passive: true });
    view.addEventListener("keydown", release);
    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
      observer.disconnect();
      view.removeEventListener("scroll", onScroll);
      view.removeEventListener("wheel", release);
      view.removeEventListener("touchstart", release);
      view.removeEventListener("keydown", release);
    };
  }, []);

  useLayoutEffect(() => {
    const parent = wrapper.current;
    const view = parent?.parentElement;
    if (!view || !parent) return;
    if (driven.current === date) {
      driven.current = null;
      return;
    }
    anchor.current = null;
    scrollToDay(view, parent, date);
  }, [date]);

  useLayoutEffect(() => {
    const parent = wrapper.current;
    const view = parent?.parentElement;
    const held = anchor.current;
    if (!view || !parent || !held) return;
    if (Date.now() > held.until) {
      anchor.current = null;
      return;
    }
    if (held.first !== null) {
      if (days[0] === held.first) return;
      anchor.current = null;
    }
    applyAnchor(view, parent, held);
  });

  useEffect(() => {
    if (!liveReady || wanted.current !== date) return;
    const frame = requestAnimationFrame(() => {
      if (wanted.current !== date) return;
      wanted.current = null;
      focusNoteEnd();
    });
    return () => cancelAnimationFrame(frame);
  }, [liveReady, date]);

  function open(day: string, event: MouseEvent<HTMLElement>) {
    if (day === date || (event.target as HTMLElement).closest("a")) return;
    activateDay.current(day);
  }

  return (
    <div ref={wrapper}>
      {days.map((day) => (
        <div
          key={day}
          role="group"
          aria-label={longDay(day)}
          data-day={day}
          onClick={(event) => open(day, event)}
          className="border-border relative min-h-(--day-h) border-t pt-5 pb-24 first:border-t-0 md:pt-7"
        >
          <div className="note-surface mx-auto w-full max-w-[calc(38em+4.75rem)]">
            {day === date && liveReady ? renderLive() : <Neighbour heading={renderHeading(day)} body={bodyOf(day)} />}
          </div>
        </div>
      ))}
    </div>
  );
}
