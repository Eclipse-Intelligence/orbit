"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import Button from "@/components/_ui/button";
import { DateTimePicker } from "@/components/_ui/date-picker";
import { Input } from "@/components/_ui/input";
import { Textarea } from "@/components/_ui/textarea";
import { TASK_CHIP } from "@/components/crm/task-fields";
import { completeTaskWithOutcomeAction } from "@/app/(crm)/task-act";
import type { OutcomeKind, TaskOutcome } from "@/lib/crm/task-act";
import { taskKind } from "@/lib/crm/task-kind";
import type { Task } from "@/lib/crm/types";
import { cn } from "@/lib/utils";
import PhoneIcon from "@/public/assets/images/_common/phone.svg";
import CalendarIcon from "@/public/assets/images/_common/calendar.svg";
import XIcon from "@/public/assets/images/companies/detail/x.svg";
import MailIcon from "@/public/assets/images/mail/mail-open.svg";
import UserIcon from "@/public/assets/images/tasks/user.svg";

const KINDS: { id: OutcomeKind; label: string; icon: typeof PhoneIcon }[] = [
  { id: "call", label: "Call", icon: PhoneIcon },
  { id: "email", label: "Email", icon: MailIcon },
  { id: "meeting", label: "Meeting", icon: CalendarIcon },
];

const TOUCH = "[@media(pointer:coarse)]:h-11";
const NOT_SAVED = "Couldn't save. Try again.";

export type OutcomePlace = "row" | "panel";
export type OutcomeOpen = { task: Task; focus: boolean; place: OutcomePlace };
type Reader = () => TaskOutcome;

export type OutcomeHandlers = {
  skip: (task: Task) => void;
  save: (task: Task, value: TaskOutcome) => Promise<string | null>;
  leave: (task: Task, quiet?: boolean) => void;
  register: (id: string, reader: Reader) => void;
};

function outcomeMessage(result: { logged?: boolean; next?: boolean }) {
  return ["Task done.", result.logged ? "Note saved." : null, result.next ? "Next task added." : null].filter(Boolean).join(" ");
}

export function typedOutcome(value: TaskOutcome | null | undefined) {
  return Boolean(value && (value.note.trim() || value.next?.title.trim()));
}

export function useTaskOutcome({
  done,
  complete,
  release,
  settle,
  onClosed,
}: {
  done: Set<string>;
  complete: (task: Task, options: { hold?: boolean }) => void;
  release: (id: string) => void;
  settle: (id: string, message: string) => void;
  onClosed?: (task: Task, place: OutcomePlace) => void;
}) {
  const [open, setOpen] = useState<OutcomeOpen | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const readers = useRef(new Map<string, Reader>());
  if (open && !done.has(open.task.id) && saving !== open.task.id) setOpen(null);
  const outcome = open && (done.has(open.task.id) || saving === open.task.id) ? open : null;

  function close(task: Task, place: OutcomePlace, quiet: boolean) {
    readers.current.delete(task.id);
    setOpen((current) => (current?.task.id === task.id ? null : current));
    if (!quiet) onClosed?.(task, place);
  }

  function skip(task: Task, quiet = false) {
    if (saving === task.id || outcome?.task.id !== task.id) return;
    release(task.id);
    close(task, outcome.place, quiet);
  }

  async function save(task: Task, value: TaskOutcome, quiet = false) {
    if (saving) return saving === task.id ? null : NOT_SAVED;
    const place = outcome?.task.id === task.id ? outcome.place : "row";
    setSaving(task.id);
    const result = await completeTaskWithOutcomeAction(task.id, value).catch(() => ({ error: NOT_SAVED }) as { error?: string; logged?: boolean; next?: boolean });
    setSaving(null);
    if (result.error) return result.error;
    settle(task.id, outcomeMessage(result));
    close(task, place, quiet);
    return null;
  }

  function leave(task: Task, quiet = false) {
    if (saving === task.id) return;
    const value = readers.current.get(task.id)?.();
    if (value && typedOutcome(value)) void save(task, value, quiet);
    else skip(task, quiet);
  }

  function start(task: Task, focus: boolean, place: OutcomePlace) {
    if (saving) return;
    if (outcome && outcome.task.id !== task.id) leave(outcome.task, true);
    complete(task, { hold: true });
    setOpen({ task, focus, place });
  }

  function register(id: string, reader: Reader) {
    readers.current.set(id, reader);
  }

  const latest = useRef(outcome);
  useEffect(() => {
    latest.current = outcome;
  });
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      const current = latest.current;
      if (current && typedOutcome(readers.current.get(current.task.id)?.())) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    const stored = readers.current;
    return () => {
      window.removeEventListener("beforeunload", warn);
      const current = latest.current;
      const value = current ? stored.get(current.task.id)?.() : null;
      if (current && value && typedOutcome(value)) void completeTaskWithOutcomeAction(current.task.id, value).catch(() => undefined);
    };
  }, []);

  return { outcome, saving, start, skip, save, leave, register };
}

export function finePointer() {
  return typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches;
}

export function hasOutcome(task: Pick<Task, "companyId" | "contactId" | "opportunityId" | "completedAt">) {
  return Boolean((task.contactId || task.companyId || task.opportunityId) && !task.completedAt);
}

function timelineOwner(task: Task) {
  const name = task.contactFirstName ?? task.contactName?.trim().split(/\s+/)[0] ?? task.companyName ?? task.opportunityName;
  return name ? `${name}'s timeline` : "the timeline";
}

function saveKeys() {
  if (typeof navigator === "undefined") return ["Ctrl", "↵"];
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent) ? ["⌘", "↵"] : ["Ctrl", "↵"];
}

export default function TaskOutcomeForm({
  task,
  focusNote,
  keyboard,
  saving,
  onSkip,
  onSave,
  onLeave,
  onRegister,
}: {
  task: Task;
  focusNote: boolean;
  keyboard: boolean;
  saving: boolean;
  onSkip: () => void;
  onSave: (outcome: TaskOutcome) => Promise<string | null>;
  onLeave: () => void;
  onRegister: (id: string, reader: Reader) => void;
}) {
  const id = useId();
  const preset = taskKind(task.title);
  const [kind, setKind] = useState<OutcomeKind | null>(preset === "todo" ? null : preset);
  const [note, setNote] = useState("");
  const [nextTitle, setNextTitle] = useState("");
  const [nextDue, setNextDue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [keys] = useState(saveKeys);
  const value = (): TaskOutcome => ({ note, kind, next: nextTitle.trim() ? { title: nextTitle.trim(), dueAt: nextDue || null } : null });
  const reader = useRef(value);
  useEffect(() => {
    reader.current = value;
  });
  useEffect(() => {
    onRegister(task.id, () => reader.current());
  }, [onRegister, task.id]);

  async function save() {
    if (saving) return;
    setError(null);
    const problem = await onSave(value());
    if (problem) setError(problem);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      void save();
      return;
    }
    if (event.key === "Escape" && !event.defaultPrevented) {
      const target = event.target as HTMLElement;
      if (target.closest("[role='dialog'], [data-radix-popper-content-wrapper]")) return;
      event.preventDefault();
      event.stopPropagation();
      onLeave();
    }
  }

  return (
    <div role="group" aria-label="Done with an outcome" aria-busy={saving || undefined} data-task-outcome="" onKeyDown={onKeyDown} className="flex flex-col gap-3 rounded-xl bg-white/[0.04] p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div role="group" aria-label="Kind" className="inline-flex rounded-full bg-white/[0.05] p-0.5">
          {KINDS.map((item) => (
            <Button
              key={item.id}
              variant={kind === item.id ? "secondary" : "ghost"}
              size="none"
              aria-pressed={kind === item.id}
              onClick={() => setKind((current) => (current === item.id ? null : item.id))}
              className={cn("h-7 gap-1.5 px-2.5 text-[12.5px] font-normal", TOUCH, kind === item.id && "text-foreground")}
            >
              <item.icon aria-hidden className="size-3" />
              {item.label}
            </Button>
          ))}
        </div>
        <span className="caption-style text-subtle flex items-center gap-1">
          <UserIcon aria-hidden className="size-3" />
          Shows on {timelineOwner(task)}
        </span>
      </div>
      <label htmlFor={`${id}-note`} className="sr-only">
        What happened
      </label>
      <Textarea
        id={`${id}-note`}
        value={note}
        rows={2}
        maxLength={10000}
        autoFocus={focusNote}
        placeholder="What happened"
        onChange={(event) => setNote(event.target.value)}
        className="min-h-16 resize-y"
      />
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-next`} className="caption-style text-subtle">
          Next task
        </label>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Input
            id={`${id}-next`}
            value={nextTitle}
            maxLength={200}
            autoComplete="off"
            placeholder="Optional"
            onChange={(event) => setNextTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void save();
              }
            }}
            className="min-w-[12em] flex-1"
          />
          <DateTimePicker
            id={`${id}-due`}
            aria-label={nextDue ? "Next task due. Change" : "Next task due date"}
            placeholder="Due"
            value={nextDue}
            onChange={setNextDue}
            className={cn(TASK_CHIP, TOUCH, "[&_svg]:size-3.5", !nextDue && "text-subtle")}
          />
          {(nextTitle || nextDue) && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Clear next task"
              title="Clear next task"
              onClick={() => {
                setNextTitle("");
                setNextDue("");
              }}
              className="[@media(pointer:coarse)]:size-11"
            >
              <XIcon aria-hidden className="size-3" />
            </Button>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <span className="flex-1 max-sm:hidden" />
        <Button
          variant="ghost"
          size="md"
          onClick={onSkip}
          disabled={saving}
          data-row-open={keyboard ? "" : undefined}
          data-row-key={keyboard ? "space" : undefined}
          data-outcome-skip=""
          className="max-sm:h-11 max-sm:flex-1 [@media(pointer:coarse)]:h-11"
        >
          Skip
        </Button>
        <Button
          variant="primary"
          size="md"
          onClick={() => void save()}
          disabled={saving}
          aria-busy={saving || undefined}
          shortcut={keys}
          className="max-sm:h-11 max-sm:flex-1 [@media(pointer:coarse)]:h-11"
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
