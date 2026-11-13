"use client";

import { useCallback, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import Button from "@/components/_ui/button";
import TaskKindIcon from "@/components/crm/task-kind-icon";
import { dateKey, shiftDateKey, weekStartKey } from "@/lib/calendar-view";
import { clockLabel, durationLabel } from "@/lib/crm/task-time";
import type { Task } from "@/lib/crm/types";
import { groupTaskList, isBlockOverdue, taskPerson, type PlannerWorkspace } from "@/lib/task-blocks";
import { appTimeZone } from "@/lib/time";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";

const SECTIONS_KEY = "orbit.calendar.sections";
const SECTIONS_EVENT = "orbit:calendar-sections";

export type CalendarSection = "calendars" | "tasks";
type Sections = Record<CalendarSection, boolean>;

const DEFAULT_SECTIONS: Sections = { calendars: false, tasks: true };
const DEFAULT_RAW = JSON.stringify(DEFAULT_SECTIONS);

function readRaw() {
  try {
    return window.localStorage.getItem(SECTIONS_KEY) ?? DEFAULT_RAW;
  } catch {
    return DEFAULT_RAW;
  }
}

function parseSections(raw: string): Sections {
  try {
    const parsed = JSON.parse(raw) as Partial<Sections> | null;
    return {
      calendars: typeof parsed?.calendars === "boolean" ? parsed.calendars : DEFAULT_SECTIONS.calendars,
      tasks: typeof parsed?.tasks === "boolean" ? parsed.tasks : DEFAULT_SECTIONS.tasks,
    };
  } catch {
    return DEFAULT_SECTIONS;
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(SECTIONS_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(SECTIONS_EVENT, onChange);
  };
}

export function useCalendarSections() {
  const raw = useSyncExternalStore(subscribe, readRaw, () => DEFAULT_RAW);
  const sections = parseSections(raw);
  const toggle = useCallback((section: CalendarSection) => {
    const next = { ...parseSections(readRaw()), [section]: !parseSections(readRaw())[section] };
    try {
      window.localStorage.setItem(SECTIONS_KEY, JSON.stringify(next));
    } catch {}
    window.dispatchEvent(new Event(SECTIONS_EVENT));
  }, []);
  return { sections, toggle };
}

export function SectionToggle({
  label,
  count,
  open,
  controls,
  large,
  onToggle,
}: {
  label: string;
  count: number;
  open: boolean;
  controls: string;
  large?: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      variant="item"
      size="none"
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      onClick={onToggle}
      className={cn("hover:bg-surface-hover items-center gap-1.5 px-1.5 font-medium", large ? "h-10 text-[14px]" : "h-[30px] text-[13px]")}
    >
      <ChevronDownIcon aria-hidden className={cn("text-subtle ease-power2-out size-3 transition-transform duration-150", !open && "-rotate-90")} />
      {label}
      <span className="text-faint text-[12px] font-normal tabular-nums">{count}</span>
    </Button>
  );
}

function dayLabel(iso: string, now: number, timeZone: string) {
  const day = dateKey(iso, timeZone);
  const today = dateKey(now, timeZone);
  if (day === today) return null;
  const date = new Date(iso);
  const weekStart = weekStartKey(today);
  if (day >= weekStart && day <= shiftDateKey(weekStart, 6)) {
    return new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone }).format(date);
  }
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat("en-GB", {
    weekday: sameYear ? "short" : undefined,
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
    timeZone,
  })
    .format(date)
    .replace(",", "");
}

export function taskWhenLabel(task: Pick<Task, "dueAt" | "dueHasTime">, now: number, timeZone = appTimeZone()) {
  if (!task.dueAt) return null;
  const day = dayLabel(task.dueAt, now, timeZone);
  const time = task.dueHasTime ? clockLabel(task.dueAt, timeZone) : null;
  return [day, time].filter(Boolean).join(" ") || null;
}

export function TaskDropZone({ day, active, bar = false }: { day: string | null; active: boolean; bar?: boolean }) {
  const tone = active
    ? "border-violet border-solid bg-[color-mix(in_srgb,var(--violet)_14%,transparent)]"
    : "border-[color-mix(in_srgb,var(--violet)_45%,transparent)] bg-[color-mix(in_srgb,var(--violet)_6%,transparent)]";
  if (bar) {
    return (
      <div data-task-drop-zone="" role="status" className={cn("pointer-events-none flex h-full items-center border border-dashed", tone)}>
        <span aria-hidden className="w-14 shrink-0 px-1 text-center text-[11px] leading-[13px] font-medium">
          Remove the time
        </span>
        <span className="sr-only">Keep the day, remove the time.{day ? ` Stays on ${day}, off the calendar.` : ""}</span>
      </div>
    );
  }
  return (
    <div
      data-task-drop-zone=""
      role="status"
      className={cn(
        "mx-1 mt-1 mb-1.5 flex flex-col gap-0.5 rounded-[10px] border border-dashed px-3 py-2.5",
        active ? tone : "border-[color-mix(in_srgb,var(--violet)_45%,transparent)] bg-[color-mix(in_srgb,var(--violet)_8%,transparent)]",
      )}
    >
      <span className="ui-style font-medium">Keep the day, remove the time</span>
      {day && <span className="caption-style text-soft">Stays on {day}, off the calendar.</span>}
    </div>
  );
}

export function CalendarTaskList({
  id,
  tasks,
  viewerId,
  now,
  workspaces,
  hidden,
  onOpen,
  onPickUp,
  held,
}: {
  id: string;
  tasks: Task[];
  viewerId: string;
  now: number;
  workspaces: PlannerWorkspace[];
  hidden: ReadonlySet<string>;
  onOpen: (task: Task, opener: HTMLElement | null) => void;
  onPickUp?: (event: ReactPointerEvent<HTMLElement>, task: Task) => void;
  held?: string | null;
}) {
  const names = workspaces.length > 1 ? new Map(workspaces.map((item) => [item.id, item.name])) : null;
  const groups = groupTaskList(
    tasks.filter((task) => !hidden.has(task.id)),
    now,
  );
  if (groups.length === 0) {
    return (
      <p id={id} className="caption-style text-subtle px-2 py-2">
        No open tasks
      </p>
    );
  }
  return (
    <div id={id} className="flex flex-col">
      {groups.map((group) => (
        <section key={group.kind} aria-label={`${group.label}, ${group.tasks.length}`} className="flex flex-col">
          <span aria-hidden className={cn("flex items-center gap-1.5 px-2 pt-3 pb-1 text-[12px] leading-none font-medium", group.kind === "overdue" ? "text-danger" : "text-subtle")}>
            {group.label}
            <span className="text-faint font-medium tabular-nums">{group.tasks.length}</span>
          </span>
          <ul className="flex flex-col">
            {group.tasks.map((task) => {
              const when = taskWhenLabel(task, now);
              const overdue = isBlockOverdue(task, now);
              const onGrid = task.dueHasTime && task.ownerId === viewerId;
              const parts: ReactNode[] = [
                taskPerson(task),
                names?.get(task.workspaceId) ?? null,
                when ? (
                  <span key="when" className={cn(overdue && "text-danger")}>
                    {when}
                  </span>
                ) : null,
              ].filter(Boolean);
              return (
                <li key={task.id}>
                  <Button
                    variant="item"
                    size="none"
                    data-task-id={task.id}
                    data-calendar-task=""
                    data-task-held={held === task.id ? "" : undefined}
                    onClick={(event) => onOpen(task, event.currentTarget)}
                    onPointerDown={onPickUp ? (event) => onPickUp(event, task) : undefined}
                    className={cn(
                      "hover:bg-surface-hover gap-2 px-2 py-1.5 [@media(pointer:coarse)]:min-h-11",
                      onPickUp && "cursor-grab touch-manipulation select-none [-webkit-touch-callout:none]",
                      held === task.id && "outline-line-strong bg-transparent opacity-40 outline-1 outline-offset-[-1px] outline-dashed hover:bg-transparent",
                    )}
                  >
                    <TaskKindIcon title={task.title} className={cn("mt-[3px] size-3.5 shrink-0", onGrid ? "text-violet" : "text-subtle")} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-foreground truncate text-[13px] leading-[18px]">{task.title}</span>
                      {parts.length > 0 && (
                        <span className="text-subtle truncate text-[12px] leading-4">
                          {parts.map((part, index) => (
                            <span key={index}>
                              {index > 0 && " · "}
                              {part}
                            </span>
                          ))}
                        </span>
                      )}
                    </span>
                    <span className="text-faint shrink-0 text-[12px] leading-[18px] font-normal tabular-nums">{durationLabel(task.durationMinutes)}</span>
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
