"use client";

import { Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Button from "@/components/_ui/button";
import { Kbd } from "@/components/_ui/command";
import { Dialog, DialogTitle } from "@/components/_ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/_ui/sheet";
import { TaskSheet, useScreenState } from "@/components/crm/quick-add";
import { useKeyboardLift } from "@/hooks/use-keyboard-lift";

import TaskPad from "@/components/crm/task-pad";
import ReminderAdd, { type ReminderAddHandle } from "@/components/reminders/reminder-add";
import ReminderDetails from "@/components/reminders/reminder-details";
import ReminderRowView from "@/components/reminders/reminder-row";
import { useShortcut } from "@/components/shortcuts/shortcuts-provider";
import { quickAddSetupAction, type QuickAddSetup } from "@/app/(crm)/quick-add";
import { deleteReminderAction, listRemindersAction, tickReminderAction, undoReminderAction, updateReminderAction } from "@/app/(crm)/reminders";
import type { Reminder, ReminderInput } from "@/lib/crm/reminders";
import {
  CARD_HEADER,
  CARD_MARGIN,
  clampCardPosition,
  defaultCardPosition,
  dueCount,
  EMPTY_DRAFT,
  groupReminders,
  optimisticReminder,
  REMINDER_NOT_REMOVED,
  readCardPosition,
  remindersToday,
  taskStartOf,
  type AddDraft,
  type CardPoint,
  type HeldTick,
  type ReminderRow,
} from "@/lib/reminders-card";
import { useCompaniesStore } from "@/stores/companies-store";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import ChevronLeftIcon from "@/public/assets/images/_common/chevron-left.svg";
import MinimiseIcon from "@/public/assets/images/mail/minimise.svg";

const WIDE = "(min-width: 64rem)";
const CARD_WIDTH = 340;
const POSITION_KEY = "orbit-reminders-card";
const TOAST_MS = 5_000;

type Toast = { id: number; kind: "done"; reminderId: string } | { id: number; kind: "note"; message: string };
type GroupId = "today" | "upcoming" | "noDate" | "done";

function subscribeWide(onChange: () => void) {
  const media = window.matchMedia(WIDE);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function useWide() {
  return useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches, () => false);
}

function subscribeViewport(onChange: () => void) {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

function useViewport() {
  const value = useSyncExternalStore(subscribeViewport, () => `${window.innerWidth}x${window.innerHeight}`, () => "1280x800");
  const [width, height] = value.split("x").map(Number);
  return { width, height };
}

function subscribeClock(onChange: () => void) {
  const timer = window.setInterval(onChange, 60_000);
  window.addEventListener("focus", onChange);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener("focus", onChange);
  };
}

function useToday() {
  return useSyncExternalStore(subscribeClock, () => remindersToday(), () => remindersToday());
}

function storedPosition() {
  if (typeof window === "undefined") return null;
  try {
    return readCardPosition(window.localStorage.getItem(POSITION_KEY));
  } catch {
    return null;
  }
}

function storePosition(point: CardPoint) {
  try {
    window.localStorage.setItem(POSITION_KEY, JSON.stringify(point));
  } catch {}
}

function replaced(list: Reminder[] | null, reminder: Reminder) {
  if (!list) return list;
  return list.some((item) => item.id === reminder.id) ? list.map((item) => (item.id === reminder.id ? reminder : item)) : [...list, reminder];
}

function withoutKey<T>(record: Record<string, T>, key: string) {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

function OpenFromLink() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const openReminders = useCompaniesStore((state) => state.openReminders);
  const asked = params.get("reminders") === "open";
  useEffect(() => {
    if (!asked) return;
    openReminders(true);
    const next = new URLSearchParams(params.toString());
    next.delete("reminders");
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [asked, params, pathname, router, openReminders]);
  return null;
}

function SheetHandle() {
  const handle = useRef<HTMLDivElement>(null);
  useKeyboardLift(handle, '[data-slot="sheet-content"]');
  return <div ref={handle} aria-hidden className="mx-auto mt-0.5 mb-2 h-[5px] w-9 shrink-0 rounded-full bg-white/18" />;
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="px-1.5 pt-1.5 pb-1">
      <p className="eyebrow-style text-subtle px-2 pt-1.5 pb-1 text-[11px]">{label}</p>
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}

export default function Reminders({ viewerId }: { viewerId: string }) {
  const open = useCompaniesStore((state) => state.remindersOpen);
  const asked = useCompaniesStore((state) => state.remindersAsked);
  const focusAdd = useCompaniesStore((state) => state.remindersFocus);
  const openReminders = useCompaniesStore((state) => state.openReminders);
  const setOpen = useCompaniesStore((state) => state.setRemindersOpen);
  const setDue = useCompaniesStore((state) => state.setRemindersDue);
  const wide = useWide();
  const viewport = useViewport();
  const today = useToday();
  const [reminders, setReminders] = useState<Reminder[] | null>(null);
  const [held, setHeld] = useState<Record<string, HeldTick>>({});
  const [detailId, setDetailId] = useState<string | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [converting, setConverting] = useState<Reminder | null>(null);
  const [setup, setSetup] = useState<QuickAddSetup | null>(null);
  const [point, setPoint] = useState<CardPoint | null>(storedPosition);
  const [seen, setSeen] = useState({ open, asked });
  const [draft, setDraft] = useState<AddDraft>(EMPTY_DRAFT);
  const [stuck, setStuck] = useState<string | null>(null);
  const { beside } = useScreenState();
  const card = useRef<HTMLElement>(null);
  const add = useRef<ReminderAddHandle>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const loads = useRef(0);
  const ticking = useRef(new Map<string, Promise<string | null>>());
  const saves = useRef<Promise<void>>(Promise.resolve());
  const drag = useRef<{ pointer: number; x: number; y: number; from: CardPoint } | null>(null);
  const gone = useRef(new Set<string>());

  if (seen.open !== open || seen.asked !== asked) {
    if (seen.open && !open) {
      setHeld({});
      setDetailId(null);
      setToast(null);
      setError(null);
      setDetailError(null);
      setDoneOpen(false);
    }
    if (open && seen.asked !== asked) setDetailId(null);
    setSeen({ open, asked });
  }

  const load = useCallback(async () => {
    const id = (loads.current += 1);
    const result = await listRemindersAction({ includeDone: true }).catch(() => null);
    if (id !== loads.current || !result || "error" in result) return;
    setReminders(result.reminders);
  }, []);

  useEffect(() => {
    void load();
  }, [open, asked, load]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, [load]);

  useEffect(() => {
    if (reminders) setDue(dueCount(reminders, today));
  }, [reminders, today, setDue]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast((current) => (current?.id === toast.id ? null : current)), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && !card.current?.contains(active)) returnTo.current = active;
    if (!wide && !focusAdd) return;
    const frame = window.requestAnimationFrame(() => add.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open, asked, wide, focusAdd]);

  useShortcut("create-reminder", () => openReminders(true));

  const close = useCallback(() => {
    setOpen(false);
    const target = returnTo.current;
    returnTo.current = null;
    if (target?.isConnected) window.requestAnimationFrame(() => target.focus({ preventScroll: true }));
  }, [setOpen]);

  function tick(row: ReminderRow) {
    const reminder = row.reminder;
    if (row.ticked || reminder.completedAt) {
      void undo(row);
      return;
    }
    setError(null);
    setHeld((current) => ({ ...current, [reminder.id]: { snapshot: reminder, doneId: null } }));
    setToast({ id: Date.now(), kind: "done", reminderId: reminder.id });
    const settle = (doneId: string | null) => {
      if (!doneId) {
        setHeld((current) => withoutKey(current, reminder.id));
        setToast((current) => (current?.kind === "done" && current.reminderId === reminder.id ? null : current));
      }
      return doneId;
    };
    const pending = tickReminderAction(reminder.id, reminder.dueOn)
      .catch(() => null)
      .then((result) => {
        if (!result || "error" in result) {
          setError(result?.error ?? "Couldn't mark it done. Try again.");
          void load();
          return settle(null);
        }
        if (!result.changed || !result.doneId) {
          void load();
          return settle(null);
        }
        const doneId = result.doneId;
        setHeld((current) => (current[reminder.id] ? { ...current, [reminder.id]: { ...current[reminder.id], doneId } } : current));
        setReminders((list) => replaced(list, result.reminder));
        return doneId;
      });
    ticking.current.set(reminder.id, pending);
  }

  async function undo(row: ReminderRow) {
    const reminder = row.reminder;
    setError(null);
    let target = reminder.id;
    if (row.ticked) {
      const pending = ticking.current.get(reminder.id);
      const doneId = pending ? await pending : (held[reminder.id]?.doneId ?? null);
      ticking.current.delete(reminder.id);
      setHeld((current) => withoutKey(current, reminder.id));
      setToast((current) => (current?.kind === "done" && current.reminderId === reminder.id ? null : current));
      if (!doneId) return;
      target = doneId;
      setReminders((list) => replaced(list?.filter((item) => item.id === reminder.id || item.id !== doneId) ?? null, reminder));
    }
    const result = await undoReminderAction(target).catch(() => null);
    if (!result || "error" in result) {
      if (!result?.missing) setError(result?.error ?? "Couldn't undo. Try again.");
      void load();
      return;
    }
    setReminders((list) => replaced(list?.filter((item) => item.id === result.reminder.id || item.id !== target) ?? null, result.reminder));
  }

  function undoToast() {
    if (toast?.kind !== "done") return;
    const tick = held[toast.reminderId];
    if (!tick) return;
    void undo({ key: `ticked:${tick.snapshot.id}`, reminder: tick.snapshot, ticked: true, overdue: false });
  }

  const detail = detailId ? (reminders?.find((item) => item.id === detailId && !item.completedAt) ?? null) : null;

  function openDetail(reminder: Reminder) {
    setDetailError(null);
    setDetailId(reminder.id);
  }

  function back() {
    setDetailId(null);
    setDetailError(null);
    if (wide) window.requestAnimationFrame(() => add.current?.focus());
  }

  function save(id: string, change: ReminderInput) {
    if (gone.current.has(id)) return;
    setDetailError(null);
    setReminders((list) => list?.map((item) => (item.id === id ? optimisticReminder(item, change) : item)) ?? list);
    saves.current = saves.current.then(async () => {
      const result = await updateReminderAction(id, change).catch(() => null);
      if (!result || "error" in result) {
        setDetailError(result?.error ?? "Couldn't save. Try again.");
        void load();
        return;
      }
      setReminders((list) => replaced(list, result.reminder));
    });
  }

  async function remove() {
    if (!detail) return;
    const id = detail.id;
    gone.current.add(id);
    back();
    setReminders((list) => list?.filter((item) => item.id !== id) ?? list);
    const result = await deleteReminderAction(id).catch(() => null);
    if (!result || "error" in result) {
      gone.current.delete(id);
      setError(result?.error ?? "Couldn't delete the reminder. Try again.");
      void load();
    }
  }

  function turnIntoTask() {
    if (!detail || stuck === detail.id) return;
    setConverting(detail);
    if (!setup) quickAddSetupAction().then(setSetup, () => undefined);
  }

  function converted(result: { reminderError?: string }) {
    const id = converting?.id;
    setConverting(null);
    if (!id) return;
    if (result.reminderError) {
      setStuck(id);
      setDetailId(id);
      setDetailError(result.reminderError);
      return;
    }
    finishConverting(id);
  }

  function finishConverting(id: string) {
    gone.current.add(id);
    setStuck((current) => (current === id ? null : current));
    back();
    setReminders((list) => list?.filter((item) => item.id !== id) ?? list);
    setToast({ id: Date.now(), kind: "note", message: "Task added" });
  }

  async function retryRemove(id: string) {
    setDetailError(null);
    const result = await deleteReminderAction(id).catch(() => null);
    if (!result || "error" in result) {
      setDetailError(REMINDER_NOT_REMOVED);
      return;
    }
    finishConverting(id);
  }

  function onCardKey(event: KeyboardEvent<HTMLElement>) {
    if (!(event.target instanceof Node) || !card.current?.contains(event.target)) return;
    if (event.key === "Escape") {
      if (event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      if (detail) back();
      else close();
      return;
    }
    if (!event.metaKey && !event.ctrlKey && !event.altKey) event.stopPropagation();
  }

  const size = { width: CARD_WIDTH, height: CARD_HEADER * 2 };
  const shown = clampCardPosition(point ?? defaultCardPosition(size, viewport, beside), size, viewport, beside);

  function startDrag(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button"))) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, from: shown };
  }

  function moveDrag(event: PointerEvent<HTMLElement>) {
    const from = drag.current;
    if (!from || from.pointer !== event.pointerId) return;
    setPoint(clampCardPosition({ x: from.from.x + event.clientX - from.x, y: from.from.y + event.clientY - from.y }, size, viewport, beside));
  }

  function endDrag(event: PointerEvent<HTMLElement>) {
    const from = drag.current;
    if (!from || from.pointer !== event.pointerId) return;
    drag.current = null;
    const next = clampCardPosition({ x: from.from.x + event.clientX - from.x, y: from.from.y + event.clientY - from.y }, size, viewport, beside);
    setPoint(next);
    storePosition(next);
  }

  const groups = reminders ? groupReminders(reminders, held, today) : null;
  const large = !wide;
  const listed = groups ? groups.today.length + groups.upcoming.length + groups.noDate.length : 0;

  function rows(group: GroupId, items: ReminderRow[]) {
    return items.map((row) => (
      <ReminderRowView key={row.key} row={row} today={today} group={group} large={large} swipe={!wide} onTick={tick} onOpen={openDetail} />
    ));
  }

  const toastView = toast && (
    <div className="pointer-events-none absolute inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] flex justify-center px-3">
      <div role="status" className="bg-surface-active shadow-overlay caption-style animate-in fade-in-0 slide-in-from-bottom-1 ease-power3-out pointer-events-auto flex max-w-full items-center gap-2.5 rounded-full py-1.5 pr-1.5 pl-3.5 backdrop-blur duration-200">
        <span className="text-foreground truncate">{toast.kind === "done" ? "Marked done" : toast.message}</span>
        {toast.kind === "done" && (
          <Button variant="secondary" size="sm" className="hit h-6 rounded-full py-0" onClick={undoToast}>
            Undo
          </Button>
        )}
      </div>
    </div>
  );

  const list = (
    <>
      <ReminderAdd ref={add} today={today} large={large} draft={draft} onDraft={setDraft} onAdded={(reminder) => setReminders((current) => replaced(current ?? [], reminder))} />
      {error && (
        <p role="alert" className="caption-style text-danger px-4 pb-1">
          {error}
        </p>
      )}
      {groups && groups.today.length > 0 && <Group label="Today">{rows("today", groups.today)}</Group>}
      {groups && groups.upcoming.length > 0 && <Group label="Upcoming">{rows("upcoming", groups.upcoming)}</Group>}
      {groups && groups.noDate.length > 0 && <Group label="No date">{rows("noDate", groups.noDate)}</Group>}
      {groups && listed === 0 && <p className="caption-style text-subtle px-4 py-3">No reminders.</p>}
      <div className={cn("flex items-center justify-between gap-2 px-2 pt-1", toast ? "pb-14" : "pb-2.5")}>
        {groups && groups.done.length > 0 ? (
          <Button variant="ghost" size="sm" aria-expanded={doneOpen} onClick={() => setDoneOpen((value) => !value)} className="hit text-faint hover:text-soft h-7 gap-1 px-2 font-normal">
            Done ({groups.done.length})
            <ChevronDownIcon aria-hidden className={cn("ease-power3-out size-3 transition-transform duration-150", !doneOpen && "-rotate-90")} />
          </Button>
        ) : (
          <span />
        )}
        {wide && (
          <span className="caption-style text-faint flex items-center gap-1 px-2 [@media(pointer:coarse)]:hidden">
            <Kbd className="h-4 min-w-4 px-1 text-[10.5px]">c</Kbd>
            <Kbd className="h-4 min-w-4 px-1 text-[10.5px]">r</Kbd>
            to add
          </span>
        )}
      </div>
      {groups && doneOpen && groups.done.length > 0 && (
        <section aria-label="Done" className={cn("px-1.5", toast ? "pb-14" : "pb-2")}>
          <ul className="flex flex-col">{rows("done", groups.done.map((reminder) => ({ key: `done:${reminder.id}`, reminder, ticked: false, overdue: false })))}</ul>
        </section>
      )}
    </>
  );

  const body = detail ? (
    <ReminderDetails
      key={detail.id}
      reminder={detail}
      today={today}
      error={detailError}
      stuck={stuck === detail.id}
      onSave={save}
      onDelete={() => void remove()}
      onTurnIntoTask={turnIntoTask}
      onRetryRemove={() => void retryRemove(detail.id)}
    />
  ) : (
    list
  );

  return (
    <>
      <Suspense fallback={null}>
        <OpenFromLink />
      </Suspense>
      {open && wide && (
        <section
          ref={card}
          aria-label={detail ? "Reminder" : "Reminders"}
          data-reminders-card=""
          onKeyDown={onCardKey}
          style={{ left: shown.x, top: shown.y, maxHeight: viewport.height - shown.y - CARD_MARGIN }}
          className="bg-popover shadow-overlay animate-in fade-in-0 zoom-in-[0.98] ease-power3-out fixed z-40 flex w-[340px] flex-col overflow-hidden rounded-[14px] ring-1 ring-white/6 duration-150"
        >
          <header
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            className="flex shrink-0 cursor-grab touch-none items-center gap-1.5 py-2.5 pr-2 pl-3.5 select-none active:cursor-grabbing"
          >
            {detail ? (
              <Button variant="ghost" size="icon-sm" aria-label="Back" title="Back (Esc)" onClick={back} className="hit -ml-1.5">
                <ChevronLeftIcon aria-hidden className="size-3" />
              </Button>
            ) : (
              <span aria-hidden className="mr-1 grid grid-cols-3 gap-0.5 opacity-50">
                {Array.from({ length: 6 }, (_, index) => (
                  <i key={index} className="bg-subtle size-[3px] rounded-full" />
                ))}
              </span>
            )}
            <h3 className="flex-1">{detail ? "Reminder" : "Reminders"}</h3>
            <Button variant="ghost" size="icon-sm" aria-label="Minimise" title="Minimise (Esc)" onClick={close} className="hit">
              <MinimiseIcon aria-hidden className="size-3.5" />
            </Button>
          </header>
          <div data-reminders-scroll="" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {body}
          </div>
          {toastView}
        </section>
      )}
      <Sheet open={open && !wide} onOpenChange={(next) => !next && close()}>
        <SheetContent
          side="bottom"
          aria-describedby={undefined}
          data-reminders-sheet=""
          onOpenAutoFocus={(event) => {
            if (focusAdd) return;
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.focus({ preventScroll: true });
          }}
          onEscapeKeyDown={(event) => {
            if (!detail) return;
            event.preventDefault();
            back();
          }}
          className="bg-popover max-h-[min(88dvh,var(--sheet-max,100dvh))] rounded-t-[18px] border-0 px-1.5 pt-2"
        >
          <SheetHandle />
          <div className="flex shrink-0 items-center justify-between gap-2 px-2.5 pb-2">
            {detail ? (
              <Button variant="ghost" size="sm" onClick={back} className="hit -ml-2 gap-1">
                <ChevronLeftIcon aria-hidden className="size-3" />
                Back
              </Button>
            ) : (
              <SheetTitle asChild>
                <h2>Reminders</h2>
              </SheetTitle>
            )}
            {detail && (
              <SheetTitle asChild>
                <h2 className="sr-only">Reminder</h2>
              </SheetTitle>
            )}
            <Button variant="ghost" size="sm" onClick={close} className="hit">
              Done
            </Button>
          </div>
          <div data-reminders-scroll="" className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[max(env(safe-area-inset-bottom),0.75rem)]">
            {body}
          </div>
          {toastView}
        </SheetContent>
      </Sheet>
      <Dialog
        open={converting !== null}
        onOpenChange={(next) => {
          if (next) return;
          setConverting(null);
          window.requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-turn-into-task]")?.focus({ preventScroll: true }));
        }}
      >
        {converting && (
          <TaskSheet>
            <DialogTitle className="sr-only">Turn into task</DialogTitle>
            <TaskPad
              key={converting.id}
              variant="card"
              clickup={setup?.clickup ?? null}
              members={setup?.members ?? []}
              viewerId={viewerId}
              autoFocus
              start={taskStartOf(converting)}
              fromReminderId={converting.id}
              onAdded={converted}
            />
          </TaskSheet>
        )}
      </Dialog>
    </>
  );
}
