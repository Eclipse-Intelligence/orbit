"use client";

import { useId, useState, type KeyboardEvent } from "react";
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

type Finish = (task: Task) => void;
type CompleteWith = (task: Task, run: () => Promise<{ error?: string; message?: string }>) => Promise<string | null>;

function outcomeMessage(result: { logged?: boolean; next?: boolean }) {
  return ["Task done.", result.logged ? "Note saved." : null, result.next ? "Next task added." : null].filter(Boolean).join(" ");
}

export function useTaskOutcome({ finish, completeWith }: { finish: Finish; completeWith: CompleteWith }) {
  const [outcome, setOutcome] = useState<{ id: string; focus: boolean } | null>(null);

  function close(id: string) {
    setOutcome((current) => (current?.id === id ? null : current));
  }

  function start(task: Task, focus: boolean) {
    setOutcome({ id: task.id, focus });
  }

  function skip(task: Task) {
    close(task.id);
    finish(task);
  }

  async function save(task: Task, value: TaskOutcome) {
    const error = await completeWith(task, async () => {
      const result = await completeTaskWithOutcomeAction(task.id, value);
      return result.error ? { error: result.error } : { message: outcomeMessage(result) };
    });
    if (!error) close(task.id);
    return error;
  }

  return { outcome, start, skip, save };
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

export default function TaskOutcomeForm({
  task,
  focusNote,
  keyboard,
  onSkip,
  onSave,
}: {
  task: Task;
  focusNote: boolean;
  keyboard: boolean;
  onSkip: () => void;
  onSave: (outcome: TaskOutcome) => Promise<string | null>;
}) {
  const id = useId();
  const preset = taskKind(task.title);
  const [kind, setKind] = useState<OutcomeKind | null>(preset === "todo" ? null : preset);
  const [note, setNote] = useState("");
  const [nextTitle, setNextTitle] = useState("");
  const [nextDue, setNextDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const problem = await onSave({ note, kind, next: nextTitle.trim() ? { title: nextTitle.trim(), dueAt: nextDue || null } : null });
    setBusy(false);
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
      onSkip();
    }
  }

  return (
    <div role="group" aria-label="Done with an outcome" data-task-outcome="" onKeyDown={onKeyDown} className="flex flex-col gap-3 rounded-xl bg-white/[0.04] p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div role="group" aria-label="Kind" className="inline-flex rounded-full bg-white/[0.05] p-0.5">
          {KINDS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={kind === item.id}
              onClick={() => setKind((current) => (current === item.id ? null : item.id))}
              className={cn(
                "focus-visible:ring-ring/60 inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-[12.5px] leading-none outline-none transition-colors duration-150 focus-visible:ring-2",
                TOUCH,
                kind === item.id ? "bg-secondary text-foreground shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]" : "text-subtle hover:text-foreground",
              )}
            >
              <item.icon aria-hidden className="size-3" />
              {item.label}
            </button>
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
          disabled={busy}
          data-row-open={keyboard ? "" : undefined}
          data-row-key={keyboard ? "space" : undefined}
          data-outcome-skip=""
          shortcut={keyboard ? ["Esc"] : undefined}
          className="max-sm:h-11 max-sm:flex-1 [@media(pointer:coarse)]:h-11"
        >
          Skip
        </Button>
        <Button
          variant="primary"
          size="md"
          onClick={() => void save()}
          disabled={busy}
          aria-busy={busy || undefined}
          shortcut={["⌘", "↵"]}
          className="max-sm:h-11 max-sm:flex-1 [@media(pointer:coarse)]:h-11"
        >
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
