"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Button from "@/components/_ui/button";
import { Checkbox } from "@/components/_ui/checkbox";
import {
  Sheet,
  SheetCloseButton,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/_ui/sheet";
import CalendarAgenda from "@/components/crm/calendar-agenda";
import type { CalendarMeta } from "@/components/crm/calendar-event-details";
import CalendarGrid from "@/components/crm/calendar-grid";
import { CalendarTaskList, SectionToggle, useCalendarSections } from "@/components/crm/calendar-tasks";
import type { TaskBlockHandlers } from "@/components/crm/calendar-task-block";
import TaskPanel from "@/components/crm/task-panel";
import { useTaskDone } from "@/components/crm/use-task-done";
import InviteDialog, {
  InviteNotice,
  NoticeContext,
  type InvitePrefill,
} from "@/components/crm/invite-dialog";
import SectionHeader from "@/components/crm/section-header";
import KeyboardList from "@/components/shortcuts/keyboard-list";
import type { Viewer } from "@/components/crm/viewer";
import { setCalendarVisibleAction } from "@/app/(crm)/calendar/actions";
import {
  mergeDuplicateEvents,
  rangeDays,
  shiftDateKey,
  stepDays,
  type CalendarMode,
} from "@/lib/calendar-view";
import type { CalendarGroup, CalendarItem } from "@/lib/crm/calendars";
import type { InviteSetup } from "@/lib/crm/invites";
import type { Planner } from "@/lib/crm/task-blocks";
import type { Task } from "@/lib/crm/types";
import { taskBlocks, type TaskBlock } from "@/lib/task-blocks";
import { SETTINGS_PATHS } from "@/lib/settings-nav";
import { cn } from "@/lib/utils";
import CalendarIcon from "@/public/assets/images/_common/calendar.svg";
import ChevronLeftIcon from "@/public/assets/images/_common/chevron-left.svg";
import ChevronRightIcon from "@/public/assets/images/_common/chevron-right.svg";
import PlusIcon from "@/public/assets/images/_common/plus.svg";

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
  return `${start} to ${end}`;
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
        <Button variant="link" size="none" href="/settings/email">
          Connect Microsoft
        </Button>{" "}
        or{" "}
        <Button variant="link" size="none" href={SETTINGS_PATHS.calendars}>
          add a calendar
        </Button>
        .
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      {groups.map((group) => (
        <div key={`${group.kind}-${group.id}`} className="flex flex-col gap-2">
          <span
            className="caption-style text-subtle truncate px-1"
            title={group.label}
          >
            {group.label}
          </span>
          {group.calendars.length === 0 ? (
            <span className="caption-style text-subtle px-1">
              Not synced yet
            </span>
          ) : (
            <ul className="flex flex-col">
              {group.calendars.map((calendar) => {
                const checked = visible(calendar.id, calendar.isVisible);
                return (
                  <li key={calendar.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded-lg px-1 py-1.5 hover:bg-white/4">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(next) =>
                          onToggle(calendar.id, next === true)
                        }
                        aria-label={`Show ${calendar.name}`}
                      />
                      <span
                        aria-hidden
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: calendar.color }}
                      />
                      <span
                        className={cn(
                          "truncate text-[14px] leading-5",
                          !checked && "text-subtle",
                        )}
                      >
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
      <Button
        variant="link"
        size="none"
        className="caption-style text-subtle self-start px-1"
        href={SETTINGS_PATHS.calendars}
      >
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
  invite,
  planner,
}: {
  viewer: Viewer;
  today: string;
  date: string;
  mode: CalendarMode | null;
  groups: CalendarGroup[];
  items: CalendarItem[];
  now: number;
  invite: InviteSetup;
  planner: Planner;
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
  const startNew = useSearchParams().get("new") === "1";
  const [inviting, setInviting] = useState<{
    prefill: InvitePrefill;
    at: number;
  } | null>(() => (startNew ? { prefill: {}, at: now } : null));
  const [notice, setNotice] = useState<string | null>(null);
  const clearNotice = useCallback(() => setNotice(null), []);
  const startInvite = (prefill: InvitePrefill = {}) =>
    setInviting({ prefill, at: Date.now() });
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
  const shown = mergeDuplicateEvents(
    items.filter((item) => {
      const calendar = calendars.get(item.calendarId);
      return calendar ? visible(item.calendarId, calendar.visible) : false;
    }),
  );

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = window.setInterval(refresh, 60_000);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [router]);

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

  const { sections, toggle: toggleSection } = useCalendarSections();
  const { done, complete: markDone } = useTaskDone(planner.tasks);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [keptTask, setKeptTask] = useState<Task | null>(null);
  const listedTask = openTaskId ? (planner.tasks.find((task) => task.id === openTaskId) ?? null) : null;
  if (listedTask && listedTask !== keptTask) setKeptTask(listedTask);
  const panelTask = listedTask ?? (keptTask && keptTask.id === openTaskId ? keptTask : null);
  const shownTask = panelTask ?? keptTask;
  const team = shownTask ? planner.teams.find((item) => item.id === shownTask.workspaceId) : null;
  const blocks = taskBlocks(planner.tasks, { viewerId: viewer.id, now, meetings: shown, workspaces: planner.workspaces, done });
  const openTask = (task: Task) => {
    setDrawerOpen(false);
    setOpenTaskId(task.id);
  };
  const taskHandlers: TaskBlockHandlers = {
    onOpen: (block: TaskBlock) => setOpenTaskId(block.task.id),
    onComplete: (block: TaskBlock) => markDone(block.task),
  };
  const calendarCount = groups.reduce((total, group) => total + group.calendars.length, 0);
  const openTaskCount = planner.tasks.filter((task) => !task.completedAt && !done.has(task.id)).length;

  const step = stepDays(desktopMode);
  const menu = (large: boolean) => {
    const suffix = large ? "drawer" : "panel";
    return (
      <div className="flex flex-col gap-0.5">
        <SectionToggle
          label="Calendars"
          count={calendarCount}
          open={sections.calendars}
          controls={`calendar-list-${suffix}`}
          large={large}
          onToggle={() => toggleSection("calendars")}
        />
        {sections.calendars && (
          <div id={`calendar-list-${suffix}`} className="px-1.5 pt-1 pb-3">
            <CalendarList groups={groups} visible={visible} onToggle={toggle} />
          </div>
        )}
        <SectionToggle
          label="Tasks"
          count={openTaskCount}
          open={sections.tasks}
          controls={`calendar-tasks-${suffix}`}
          large={large}
          onToggle={() => toggleSection("tasks")}
        />
        {sections.tasks && (
          <CalendarTaskList
            id={`calendar-tasks-${suffix}`}
            tasks={planner.tasks}
            viewerId={viewer.id}
            now={now}
            workspaces={planner.workspaces}
            hidden={done}
            onOpen={openTask}
          />
        )}
      </div>
    );
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader
        title="Calendar"
        viewer={viewer}
        action={
          <Button
            variant="primary"
            size="sm"
            data-shortcut="new-event"
            shortcut={["C", "E"]}
            onClick={() => startInvite()}
          >
            <PlusIcon aria-hidden className="size-3" />
            New event
          </Button>
        }
      />
      <div className="border-border flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <Button
          variant="secondary"
          size="icon"
          className="lg:hidden"
          aria-label="Calendars and tasks"
          data-shortcut="calendars-panel"
          onClick={() => setDrawerOpen(true)}
        >
          <CalendarIcon aria-hidden className="size-3.5" />
        </Button>
        <Button
          variant="secondary"
          size="icon"
          className="hidden lg:inline-flex"
          aria-label={panelOpen ? "Hide calendars and tasks" : "Show calendars and tasks"}
          aria-expanded={panelOpen}
          aria-controls="calendar-panel"
          data-shortcut="calendars-panel"
          title={`${panelOpen ? "Hide" : "Show"} calendars and tasks (\\)`}
          onClick={() => setPanelOpen((current) => !current)}
        >
          <CalendarIcon aria-hidden className="size-3.5" />
        </Button>
        <Button
          variant="secondary"
          size="sm"
          href={calendarHref(today, mode)}
          data-shortcut="today"
          title="Today (T)"
        >
          Today
        </Button>
        <span className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="hidden md:inline-flex"
            aria-label={
              desktopMode === "week" ? "Previous week" : "Previous day"
            }
            href={calendarHref(shiftDateKey(date, -step), mode)}
            data-shortcut="calendar-prev"
            title={desktopMode === "week" ? "Previous week ([)" : "Previous day ([)"}
          >
            <ChevronLeftIcon aria-hidden className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="hidden md:inline-flex"
            aria-label={desktopMode === "week" ? "Next week" : "Next day"}
            href={calendarHref(shiftDateKey(date, step), mode)}
            data-shortcut="calendar-next"
            title={desktopMode === "week" ? "Next week (])" : "Next day (])"}
          >
            <ChevronRightIcon aria-hidden className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="Previous day"
            href={calendarHref(shiftDateKey(date, -1), mode)}
            data-shortcut="calendar-prev"
          >
            <ChevronLeftIcon aria-hidden className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="Next day"
            href={calendarHref(shiftDateKey(date, 1), mode)}
            data-shortcut="calendar-next"
          >
            <ChevronRightIcon aria-hidden className="size-3.5" />
          </Button>
        </span>
        <h2
          className="min-w-0 truncate text-[14px] leading-5 font-medium"
          aria-live="polite"
        >
          <span className="hidden md:inline">
            {desktopMode === "week" ? weekLabel(days) : dayLabel(date)}
          </span>
          <span className="md:hidden">{dayLabel(date)}</span>
        </h2>
        <span
          role="group"
          aria-label="View"
          className="bg-secondary ml-auto hidden items-center gap-0.5 rounded-full p-0.5 shadow-[0px_0px_0px_1px_rgba(0,0,0,0.4)] md:inline-flex"
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
              data-shortcut={option === "day" ? "view-day" : "view-week"}
              title={option === "day" ? "Day view (D)" : "Week view (W)"}
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
      <NoticeContext.Provider value={setNotice}>
        <KeyboardList className="flex min-h-0 flex-1">
          {panelOpen && (
            <aside
              id="calendar-panel"
              aria-label="Calendars and tasks"
              className="border-border hidden w-60 shrink-0 overflow-y-auto border-r px-2 pt-3 pb-8 lg:block"
            >
              {menu(false)}
            </aside>
          )}
          <div className="hidden min-h-0 min-w-0 flex-1 md:flex">
            <CalendarGrid
              days={days}
              today={today}
              items={shown}
              calendars={calendars}
              now={now}
              onSlot={(day, time) => startInvite({ date: day, time })}
              blocks={blocks}
              taskHandlers={taskHandlers}
            />
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 md:hidden">
            <CalendarAgenda
              date={date}
              today={today}
              items={shown}
              calendars={calendars}
              now={now}
              onNew={() => startInvite(date === today ? {} : { date })}
              blocks={blocks}
              taskHandlers={taskHandlers}
            />
          </div>
        </KeyboardList>
      </NoticeContext.Provider>
      <InviteDialog
        open={inviting !== null}
        onOpenChange={(open) => !open && setInviting(null)}
        setup={invite}
        prefill={inviting?.prefill ?? {}}
        now={inviting?.at ?? now}
        onSent={setNotice}
      />
      <InviteNotice message={notice} onDone={clearNotice} />
      <TaskPanel
        task={shownTask}
        open={Boolean(panelTask)}
        onOpenChange={(open) => {
          if (!open) setOpenTaskId(null);
        }}
        viewer={{ ...viewer, role: team?.role ?? viewer.role, workspaceId: shownTask?.workspaceId ?? viewer.workspaceId }}
        members={team?.members ?? []}
        tagged={shownTask ? (planner.tagged[shownTask.id] ?? []) : []}
        admins={team?.admins ?? []}
        completed={shownTask ? done.has(shownTask.id) : false}
        onComplete={markDone}
        recordNotes={!shownTask || shownTask.workspaceId === viewer.workspaceId}
      />
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="left" className="w-[min(320px,86vw)]">
          <SheetHeader className="px-4">
            <SheetTitle className="sr-only">Calendars and tasks</SheetTitle>
            <SheetCloseButton className="ml-auto" />
          </SheetHeader>
          <SheetDescription className="sr-only">
            Choose which calendars to show and open your tasks
          </SheetDescription>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-8">{menu(true)}</div>
        </SheetContent>
      </Sheet>
    </section>
  );
}
