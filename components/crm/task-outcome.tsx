"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import Button from "@/components/_ui/button";
import { DateTimePicker } from "@/components/_ui/date-picker";
import { Input } from "@/components/_ui/input";
import { Textarea } from "@/components/_ui/textarea";
import { TASK_CHIP } from "@/components/crm/task-fields";
import { useComposer } from "@/components/mail/compose-dock";
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
const NOT_DONE = "Couldn't mark it done. Try again.";

export type OutcomePlace = "row" | "panel";
export type OutcomeOpen = { task: Task; focus: boolean; place: OutcomePlace; outcomeId: string };
export type OutcomeDraft = { outcomeId: string; note: string; kind: OutcomeKind | null; nextTitle: string; nextDue: string };

const drafts = new Map<string, OutcomeDraft>();

export function outcomeDraft(task: Task, outcomeId: string): OutcomeDraft {
  const kept = drafts.get(task.id);
  if (kept && kept.outcomeId === outcomeId) return kept;
  const preset = taskKind(task.title);
  const fresh = { outcomeId, note: "", kind: preset === "todo" ? null : preset, nextTitle: "", nextDue: "" };
  drafts.set(task.id, fresh);
  return fresh;
}

function keepDraft(taskId: string, draft: OutcomeDraft) {
  drafts.set(taskId, draft);
}

export function outcomeValue(draft: OutcomeDraft): TaskOutcome {
  const title = draft.nextTitle.trim();
  return { outcomeId: draft.outcomeId, note: draft.note, kind: draft.kind, next: title ? { title, dueAt: draft.nextDue || null } : null };
}

export function typedOutcome(draft: OutcomeDraft | null | undefined) {
  return Boolean(draft && (draft.note.trim() || draft.nextTitle.trim()));
}

export type OutcomeHandlers = {
  skip: (task: Task) => void;
  save: (task: Task) => Promise<string | null>;
  leave: (task: Task, quiet?: boolean) => void;
};

function outcomeMessage(result: { logged?: boolean; next?: boolean }) {
  return ["Task done.", result.logged ? "Note saved." : null, result.next ? "Next task added." : null].filter(Boolean).join(" ");
}

function newOutcomeId() {
  return crypto.randomUUID();
}

export function useTaskOutcome({
  done,
  complete,
  release,
  settle,
  onClosed,
  onFailed,
}: {
  done: Set<string>;
  complete: (task: Task, options: { hold?: boolean }) => void;
  release: (id: string) => void;
  settle: (id: string, message: string) => boolean;
  onClosed?: (task: Task, place: OutcomePlace) => void;
  onFailed?: (task: Task, place: OutcomePlace) => void;
}) {
  const composer = useComposer();
  const [open, setOpen] = useState<OutcomeOpen | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  if (open && !done.has(open.task.id) && saving !== open.task.id) setOpen(null);
  const outcome = open && (done.has(open.task.id) || saving === open.task.id) ? open : null;

  function close(task: Task, place: OutcomePlace, quiet: boolean) {
    drafts.delete(task.id);
    setOpen((current) => (current?.task.id === task.id ? null : current));
    if (!quiet) onClosed?.(task, place);
  }

  function skip(task: Task, quiet = false) {
    if (saving === task.id || outcome?.task.id !== task.id) return;
    release(task.id);
    close(task, outcome.place, quiet);
  }

  function save(task: Task, quiet = false): Promise<string | null> {
    const current = outcome?.task.id === task.id ? outcome : null;
    const draft = drafts.get(task.id);
    if (!current || !draft || draft.outcomeId !== current.outcomeId) return Promise.resolve(null);
    const place = current.place;
    const value = outcomeValue(draft);
    const run = async () => {
      setSaving(task.id);
      const result = await completeTaskWithOutcomeAction(task.id, value).catch(() => ({ error: NOT_SAVED }) as { error?: string; logged?: boolean; next?: boolean; completed?: boolean });
      setSaving(null);
      if (result.error) {
        if (quiet) {
          composer.showToast({ message: result.error, tone: "alert" });
          onFailed?.(task, place);
        }
        return result.error;
      }
      if (!result.completed) {
        release(task.id);
        composer.showToast({ message: NOT_DONE, tone: "alert" });
        close(task, place, quiet);
        return null;
      }
      settle(task.id, outcomeMessage(result));
      close(task, place, quiet);
      return null;
    };
    const next = queue.current.then(run, run);
    queue.current = next.catch(() => undefined);
    return next;
  }

  function leave(task: Task, quiet = false) {
    if (saving === task.id || outcome?.task.id !== task.id) return;
    if (typedOutcome(drafts.get(task.id))) void save(task, quiet);
    else skip(task, quiet);
  }

  function start(task: Task, focus: boolean, place: OutcomePlace) {
    if (saving === task.id) return;
    if (outcome && outcome.task.id !== task.id) leave(outcome.task, true);
    complete(task, { hold: true });
    const outcomeId = newOutcomeId();
    outcomeDraft(task, outcomeId);
    setOpen({ task, focus, place, outcomeId });
  }

  const latest = useRef(outcome);
  const toast = useRef(composer.showToast);
  useEffect(() => {
    latest.current = outcome;
    toast.current = composer.showToast;
  });
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      const current = latest.current;
      if (current && typedOutcome(drafts.get(current.task.id))) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      const current = latest.current;
      const draft = current ? drafts.get(current.task.id) : null;
      if (!current || !draft || draft.outcomeId !== current.outcomeId || !typedOutcome(draft)) return;
      void completeTaskWithOutcomeAction(current.task.id, outcomeValue(draft))
        .catch(() => ({ error: NOT_SAVED }) as { error?: string })
        .then((result) => {
          if (result.error) toast.current({ message: `${result.error} Your note on “${current.task.title}” wasn't saved.`, tone: "alert" });
          else {
            drafts.delete(current.task.id);
            toast.current({ message: `Note saved on “${current.task.title}”.` });
          }
        });
    };
  }, []);

  return { outcome, saving, start, skip, save, leave };
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
  outcomeId,
  focusNote,
  keyboard,
  saving,
  onSkip,
  onSave,
  onLeave,
}: {
  task: Task;
  outcomeId: string;
  focusNote: boolean;
  keyboard: boolean;
  saving: boolean;
  onSkip: () => void;
  onSave: () => Promise<string | null>;
  onLeave: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(() => outcomeDraft(task, outcomeId));
  const [error, setError] = useState<string | null>(null);
  const [keys] = useState(saveKeys);

  function change(next: Partial<OutcomeDraft>) {
    setDraft((current) => {
      const updated = { ...current, ...next };
      keepDraft(task.id, updated);
      return updated;
    });
  }

  async function save() {
    if (saving) return;
    setError(null);
    const problem = await onSave();
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
              variant={draft.kind === item.id ? "secondary" : "ghost"}
              size="none"
              aria-pressed={draft.kind === item.id}
              onClick={() => change({ kind: draft.kind === item.id ? null : item.id })}
              className={cn("h-7 gap-1.5 px-2.5 text-[12.5px] font-normal", TOUCH, draft.kind === item.id && "text-foreground")}
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
        value={draft.note}
        rows={2}
        maxLength={10000}
        autoFocus={focusNote}
        placeholder="What happened"
        onChange={(event) => change({ note: event.target.value })}
        className="min-h-16 resize-y"
      />
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-next`} className="caption-style text-subtle">
          Next task
        </label>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Input
            id={`${id}-next`}
            value={draft.nextTitle}
            maxLength={200}
            autoComplete="off"
            placeholder="Optional"
            onChange={(event) => change({ nextTitle: event.target.value })}
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
            aria-label={draft.nextDue ? "Next task due. Change" : "Next task due date"}
            placeholder="Due"
            value={draft.nextDue}
            onChange={(value) => change({ nextDue: value })}
            className={cn(TASK_CHIP, TOUCH, "[&_svg]:size-3.5", !draft.nextDue && "text-subtle")}
          />
          {(draft.nextTitle || draft.nextDue) && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Clear next task"
              title="Clear next task"
              onClick={() => change({ nextTitle: "", nextDue: "" })}
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
