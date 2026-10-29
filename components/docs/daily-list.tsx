"use client";

import { useEffect, useMemo, useState, type MouseEvent } from "react";
import Link from "next/link";
import Button from "@/components/_ui/button";
import { navigateWithinDocs, useToday } from "@/components/docs/use-docs";
import type { DailySummary } from "@/lib/docs/client-types";
import { docsData } from "@/lib/docs/connection";
import { addMonths, dayDetail, dayName, longDay, monthGrid, monthLabel } from "@/lib/docs/format";
import { dailyHref } from "@/lib/docs/routes";
import { useDocsStore } from "@/stores/docs-store";
import { cn } from "@/lib/utils";
import ChevronLeftIcon from "@/public/assets/images/_common/chevron-left.svg";
import ChevronRightIcon from "@/public/assets/images/_common/chevron-right.svg";

const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];

function within(event: MouseEvent<HTMLElement>, href: string) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  if (navigateWithinDocs(href)) event.preventDefault();
}

function useDailyNotes() {
  const [days, setDays] = useState<DailySummary[] | null>(null);
  const revision = useDocsStore((state) => state.nav?.dailyCount ?? 0);
  const todayEntries = useDocsStore((state) => state.nav?.todayNote?.entries ?? 0);
  useEffect(() => {
    let live = true;
    void docsData()
      .listDailyNotes()
      .then((list) => {
        if (live) setDays(list);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [revision, todayEntries]);
  return days;
}

export default function DailyList({ selected, initial }: { selected: string | null; initial: DailySummary[] }) {
  const today = useToday() || selected || "";
  const fetched = useDailyNotes();
  const days = fetched ?? initial;
  const [month, setMonth] = useState(() => (selected ?? today).slice(0, 7));
  const [seen, setSeen] = useState(selected);
  if (seen !== selected) {
    setSeen(selected);
    if (selected) setMonth(selected.slice(0, 7));
  }
  const withEntries = useMemo(() => new Set(days.map((day) => day.date)), [days]);
  const cells = monthGrid(month);

  return (
    <>
      <div className="px-2.5 pt-1 pb-3">
        <div className="flex items-center gap-1 pb-2 pl-1.5">
          <h3 aria-live="polite" className="flex-1">
            {monthLabel(month)}
          </h3>
          <Button variant="ghost" size="icon-sm" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}>
            <ChevronLeftIcon aria-hidden className="size-3" />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Next month" disabled={month >= today.slice(0, 7)} onClick={() => setMonth(addMonths(month, 1))}>
            <ChevronRightIcon aria-hidden className="size-3" />
          </Button>
        </div>
        <div className="grid grid-cols-7 gap-y-0.5 text-center">
          {WEEKDAYS.map((day, index) => (
            <span key={index} aria-hidden className="caption-style text-subtle pb-1 text-[11px]">
              {day}
            </span>
          ))}
          {cells.map((day, index) => {
            if (!day) return <span key={index} />;
            const href = dailyHref(day);
            const current = day === selected;
            const future = day > today;
            const has = withEntries.has(day);
            const label = `${longDay(day)}${has ? ", has entries" : ""}${day === today ? ", today" : ""}`;
            return future ? (
              <span key={day} title={label} className="text-faint mx-auto flex size-8 items-center justify-center rounded-full text-[12.5px] tabular-nums">
                {Number(day.slice(8))}
              </span>
            ) : (
              <Link
                key={day}
                href={href}
                aria-label={label}
                aria-current={current ? "date" : undefined}
                onClick={(event) => within(event, href)}
                className={cn(
                  "ease-power3-out focus-visible:ring-ring/60 relative mx-auto flex size-8 flex-col items-center justify-center rounded-full text-[12.5px] tabular-nums transition-colors duration-150 outline-none focus-visible:ring-2",
                  current ? "bg-primary text-white" : day === today ? "text-foreground bg-white/[0.06]" : "text-soft hover:bg-white/[0.05]",
                )}
              >
                {Number(day.slice(8))}
                {has && !current && <span aria-hidden className="bg-subtle absolute bottom-[5px] size-[3px] rounded-full" />}
              </Link>
            );
          })}
        </div>
      </div>
      <div className="mx-2.5 mb-2 h-px bg-white/[0.05]" />
      {days.length === 0 && <p className="caption-style text-subtle px-3 py-2">No daily notes yet. Today&apos;s note is open, ready for your first entry.</p>}
      <ul aria-label="Days" className="flex flex-col gap-0.5">
        {days.slice(0, 60).map((day) => {
          const href = dailyHref(day.date);
          const current = day.date === selected;
          return (
            <li key={day.date}>
              <Link
                href={href}
                aria-current={current ? "page" : undefined}
                onClick={(event) => within(event, href)}
                className={cn(
                  "ease-power3-out focus-visible:ring-ring/60 flex w-full flex-col gap-1 rounded-xl px-3 py-2.5 text-left transition-colors duration-150 outline-none focus-visible:ring-2",
                  current ? "bg-white/[0.07]" : "hover:bg-white/[0.035]",
                )}
              >
                <span className="flex items-baseline gap-2">
                  <span className={cn("text-[14px] leading-5 font-medium", current ? "text-foreground" : "text-[#e3e5ea]")}>{dayName(day.date, today)}</span>
                  <span className="caption-style text-subtle">{dayDetail(day.date, today)}</span>
                  <span className="caption-style text-subtle ml-auto tabular-nums">
                    {day.entries} {day.entries === 1 ? "entry" : "entries"}
                  </span>
                </span>
                {day.preview && <span className="text-subtle truncate text-[13px] leading-[1.45]">{day.preview}</span>}
              </Link>
            </li>
          );
        })}
      </ul>
    </>
  );
}
