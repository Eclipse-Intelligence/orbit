"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Checkbox } from "@/components/_ui/checkbox";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/_ui/sheet";
import CalendarAgenda from "@/components/crm/calendar-agenda";
import type { CalendarMeta } from "@/components/crm/calendar-event-details";
import CalendarGrid from "@/components/crm/calendar-grid";
import SectionHeader from "@/components/crm/section-header";
import type { Viewer } from "@/components/crm/viewer";
import { setCalendarVisibleAction } from "@/app/(crm)/calendar/actions";
import { rangeDays, shiftDateKey, stepDays, type CalendarMode } from "@/lib/calendar-view";
import type { CalendarGroup, CalendarItem } from "@/lib/crm/calendars";
import { cn } from "@/lib/utils";
import CalendarIcon from "@/public/assets/images/_common/calendar.svg";
import ChevronLeftIcon from "@/public/assets/images/_common/chevron-left.svg";
import ChevronRightIcon from "@/public/assets/images/_common/chevron-right.svg";

function calendarHref(date: string, mode: CalendarMode | null) {
  const params = new URLSearchParams({ date });
  if (mode) params.set("view", mode);
  return `/calendar?${params.toString()}`;
}

function keyDate(key: string) {
  return new Date(`${key}T12:00:00Z`);
}

function dayLabel(key: string) {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(keyDate(key));
}

function weekLabel(days: string[]) {
  const first = keyDate(days[0]);
  const last = keyDate(days[days.length - 1]);
  const sameMonth = first.getUTCMonth() === last.getUTCMonth();
  const sameYear = first.getUTCFullYear() === last.getUTCFullYear();
  const start = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    ...(sameMonth ? {} : { month: "short" }),
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  }).format(first);
  const end = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(last);
  return `${start} – ${end}`;
}

function CalendarList({
  groups,
  visible,
  onToggle,
}: {
  groups: CalendarGroup[];
  visible: (id: string, fallback: boolean) => boolean;
  onToggle: (id: string, value: boolean) => void;
}) {
  if (groups.length === 0) {
    return (
      <p className="caption-style text-subtle px-1">
        Connect Microsoft in{" "}
        <Button variant="link" size="none" href="/inbox">
          Inbox
        </Button>{" "}
        or add a calendar in{" "}
        <Button variant="link" size="none" href="/settings#calendars">
          Settings
        </Button>
        .
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      {groups.map((group) => (
        <div key={`${group.kind}-${group.id}`} className="flex flex-col gap-2">
          <span className="caption-style text-subtle truncate px-1" title={group.label}>
            {group.label}
          </span>
          {group.calendars.length === 0 ? (
            <span className="caption-style text-faint px-1">Not synced yet</span>
          ) : (
            <ul className="flex flex-col">
              {group.calendars.map((calendar) => {
                const checked = visible(calendar.id, calendar.isVisible);
                return (
                  <li key={calendar.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded-lg px-1 py-1.5 hover:bg-white/4">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(next) => onToggle(calendar.id, next === true)}
                        aria-label={`Show ${calendar.name}`}
                      />
                      <span
                        aria-hidden
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: calendar.color }}
                      />
                      <span className={cn("truncate text-[14px] leading-5", !checked && "text-subtle")}>
                        {calendar.name}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ))}
      <Button variant="link" size="none" className="caption-style text-subtle self-start px-1" href="/settings#calendars">
        Manage calendars
      </Button>
    </div>
  );
}

export default function CalendarScreen({
  viewer,
  today,
  date,
  mode,
  groups,
  items,
  now,
}: {
  viewer: Viewer;
  today: string;
  date: string;
  mode: CalendarMode | null;
  groups: CalendarGroup[];
  items: CalendarItem[];
  now: number;
}) {
  const router = useRouter();
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [source, setSource] = useState(groups);
  if (source !== groups) {
    setSource(groups);
    setOverrides({});
  }
  const [panelOpen, setPanelOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const desktopMode = mode ?? "week";
  const days = rangeDays(date, desktopMode);

  const calendars = useMemo(() => {
    const map = new Map<string, CalendarMeta & { visible: boolean }>();
    for (const group of groups) {
      for (const calendar of group.calendars) {
        map.set(calendar.id, {
          name: calendar.name,
          color: calendar.color,
          account: group.label,
          provider: group.provider,
          visible: calendar.isVisible,
        });
      }
    }
    return map;
  }, [groups]);

  const visible = (id: string, fallback: boolean) => overrides[id] ?? fallback;
  const shown = items.filter((item) => {
    const calendar = calendars.get(item.calendarId);
    return calendar ? visible(item.calendarId, calendar.visible) : false;
  });

  async function toggle(id: string, value: boolean) {
    setError(null);
    setOverrides((current) => ({ ...current, [id]: value }));
    const result = await setCalendarVisibleAction(id, value);
    if (result.error) {
      setError(result.error);
      setOverrides((current) => ({ ...current, [id]: !value }));
      return;
    }
    router.refresh();
  }

  const step = stepDays(desktopMode);
  const list = <CalendarList groups={groups} visible={visible} onToggle={toggle} />;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader title="Calendar" viewer={viewer} />
      <div className="border-border flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <Button
          variant="secondary"
          size="icon"
          className="lg:hidden"
          aria-label="Choose calendars"
          onClick={() => setDrawerOpen(true)}
        >
          <CalendarIcon aria-hidden className="size-3.5" />
        </Button>
        <Button
          variant="secondary"
          size="icon"
          className="hidden lg:inline-flex"
          aria-label={panelOpen ? "Hide calendars" : "Show calendars"}
          aria-expanded={panelOpen}
          aria-controls="calendar-panel"
          onClick={() => setPanelOpen((current) => !current)}
        >
          <CalendarIcon aria-hidden className="size-3.5" />
        </Button>
        <Button variant="secondary" size="sm" href={calendarHref(today, mode)}>
          Today
        </Button>
        <span className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="hidden lg:inline-flex"
            aria-label={desktopMode === "week" ? "Previous week" : "Previous day"}
            href={calendarHref(shiftDateKey(date, -step), mode)}
          >
            <ChevronLeftIcon aria-hidden className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="hidden lg:inline-flex"
            aria-label={desktopMode === "week" ? "Next week" : "Next day"}
            href={calendarHref(shiftDateKey(date, step), mode)}
          >
            <ChevronRightIcon aria-hidden className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            aria-label="Previous day"
            href={calendarHref(shiftDateKey(date, -1), mode)}
          >
            <ChevronLeftIcon aria-hidden className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            aria-label="Next day"
            href={calendarHref(shiftDateKey(date, 1), mode)}
          >
            <ChevronRightIcon aria-hidden className="size-3.5" />
          </Button>
        </span>
        <h2 className="min-w-0 truncate text-[14px] leading-5 font-medium" aria-live="polite">
          <span className="hidden lg:inline">{desktopMode === "week" ? weekLabel(days) : dayLabel(date)}</span>
          <span className="lg:hidden">{dayLabel(date)}</span>
        </h2>
        <span
          role="group"
          aria-label="View"
          className="bg-secondary ml-auto hidden items-center gap-0.5 rounded-full p-0.5 shadow-[0px_0px_0px_1px_rgba(0,0,0,0.4)] lg:inline-flex"
        >
          {(["day", "week"] as const).map((option) => (
            <Button
              key={option}
              variant="nav"
              size="sm"
              className="w-auto rounded-full px-3"
              data-active={desktopMode === option}
              aria-current={desktopMode === option ? "page" : undefined}
              href={calendarHref(date, option)}
            >
              {option === "day" ? "Day" : "Week"}
            </Button>
          ))}
        </span>
      </div>
      {error && (
        <p role="alert" className="caption-style text-danger px-4 pt-2">
          {error}
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        {panelOpen && (
          <aside
            id="calendar-panel"
            aria-label="Calendars"
            className="border-border hidden w-60 shrink-0 overflow-y-auto border-r px-3 py-4 lg:block"
          >
            {list}
          </aside>
        )}
        <div className="hidden min-h-0 min-w-0 flex-1 lg:flex">
          <CalendarGrid days={days} today={today} items={shown} calendars={calendars} now={now} />
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 lg:hidden">
          <CalendarAgenda date={date} today={today} items={shown} calendars={calendars} now={now} />
        </div>
      </div>
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="left" className="w-[min(320px,86vw)]">
          <SheetHeader className="px-4">
            <SheetTitle>Calendars</SheetTitle>
          </SheetHeader>
          <SheetDescription className="sr-only">Choose which calendars to show</SheetDescription>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">{list}</div>
        </SheetContent>
      </Sheet>
    </section>
  );
}
