"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode, type SVGProps } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useComposer } from "@/components/mail/compose-dock";
import Button, { buttonVariants } from "@/components/_ui/button";
import { Kbd } from "@/components/_ui/command";
import { DueDatePicker } from "@/components/_ui/date-picker";
import { Input } from "@/components/_ui/input";
import { Textarea } from "@/components/_ui/textarea";
import { Monogram } from "@/components/beautifui/record-marks";
import AssigneePicker, { MemberAvatar, type AssignableMember } from "@/components/crm/assignee-picker";
import ReminderSelect from "@/components/crm/reminder-select";
import { DurationMenu, ReminderTimePrompt, ScheduleMenu } from "@/components/crm/task-timing";
import { EditLinks } from "@/components/crm/task-actions";
import type { Viewer } from "@/components/crm/viewer";
import { assignTaskAction, linkTaskAction, searchTaskLinkTargetsAction, taskLinkCandidatesAction } from "@/app/(crm)/records";
import TaskTitle, { ColleagueLink } from "@/components/crm/task-title";
import type { LinkCandidate } from "@/lib/crm/task-links";
import { TaskRecordLink } from "@/components/crm/task-workspace";
import { saveTaskDetailsAction, type TaskDetails } from "@/app/(crm)/discussions";
import { companyHref, contactHref } from "@/lib/crm/hrefs";
import { reminderLabel } from "@/lib/crm/reminder-options";
import { replaceDescriptionText, splitDescription } from "@/lib/crm/task-description";
import { taskSnoozeChoices } from "@/lib/crm/task-snooze";
import type { TitleColleague, TitleHere } from "@/lib/crm/task-title";
import type { Task } from "@/lib/crm/types";
import { recordHref } from "@/lib/docs/routes";
import { padDueHasTime } from "@/lib/task-pad";
import { formatDateLabel, formatDateTimeLabel } from "@/lib/date-input";
import { durationLabel, localInstant } from "@/lib/crm/task-time";
import { taskDueLabel } from "@/lib/crm/task-views";
import { appTimeZone, dateTimeInputValue, toIsoInstant } from "@/lib/time";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import LinkIcon from "@/public/assets/images/settings/link.svg";
import ChatIcon from "@/public/assets/images/chat/chat.svg";
import ContactIcon from "@/public/assets/images/companies/sidebar/book-closed.svg";
import OpportunityIcon from "@/public/assets/images/companies/sidebar/clipboard.svg";
import MailIcon from "@/public/assets/images/mail/mail-open.svg";
import XIcon from "@/public/assets/images/companies/detail/x.svg";

export const TASK_CHIP =
  "h-7 w-auto max-w-full min-w-0 gap-1.5 rounded-full border-transparent bg-white/[0.06] px-2.5 text-[12.5px] leading-none text-soft hover:bg-white/10 hover:text-foreground";

const TOUCH = "hit";

const FORMATS = new Map<string, Intl.DateTimeFormat>();

export function formatTaskWhen(options: Intl.DateTimeFormatOptions, iso: string) {
  const timeZone = appTimeZone();
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let format = FORMATS.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat("en-GB", { timeZone, ...options });
    FORMATS.set(key, format);
  }
  return format.format(new Date(iso));
}

function fitHeight(field: HTMLTextAreaElement) {
  field.style.height = "auto";
  field.style.height = `${field.scrollHeight + field.offsetHeight - field.clientHeight}px`;
}

function useAutoSize(value: string) {
  const node = useRef<HTMLTextAreaElement | null>(null);
  const [attached, setAttached] = useState(0);
  const attach = useCallback((field: HTMLTextAreaElement | null) => {
    node.current = field;
    if (field) setAttached((count) => count + 1);
  }, []);
  useLayoutEffect(() => {
    const field = node.current;
    if (!field) return;
    fitHeight(field);
    let width = field.offsetWidth;
    const observer = new ResizeObserver(() => {
      if (field.offsetWidth === width) return;
      width = field.offsetWidth;
      fitHeight(field);
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, [attached, value]);
  return attach;
}

export function canChangeTaskAs(viewer: Pick<Viewer, "id" | "role">, task: Pick<Task, "ownerId" | "createdByUserId">) {
  return viewer.role === "owner" || viewer.role === "admin" || task.ownerId === viewer.id || task.createdByUserId === viewer.id;
}

export function canRemoveTag(viewer: Pick<Viewer, "id" | "role">, task: Pick<Task, "ownerId" | "createdByUserId">, person: string) {
  return person === viewer.id || canChangeTaskAs(viewer, task);
}

export function changersLine(names: string[]) {
  const people = [...new Set(names.filter(Boolean))];
  if (people.length === 0) return "Admins can change it.";
  return `${people.join(", ")} and admins can change it.`;
}

export function firstName(name: string | null | undefined) {
  return name?.trim().split(/\s+/)[0] ?? "";
}

function caretAt(heading: HTMLElement, x: number, y: number) {
  const point = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = point.caretPositionFromPoint?.(x, y);
  const range = position ? { node: position.offsetNode, offset: position.offset } : (() => {
    const found = point.caretRangeFromPoint?.(x, y);
    return found ? { node: found.startContainer, offset: found.startOffset } : null;
  })();
  if (!range || !heading.contains(range.node)) return null;
  const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
  let total = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node === range.node) return total + range.offset;
    total += node.textContent?.length ?? 0;
  }
  return null;
}

type Source = { title: string; text: string; due: string; reminder: number | null; duration: number; ownerId: string | null };

export function dueValue(task: Pick<Task, "dueAt" | "dueDate" | "dueHasTime">) {
  if (!task.dueAt) return "";
  return task.dueHasTime ? dateTimeInputValue(task.dueAt) : (task.dueDate ?? dateTimeInputValue(task.dueAt).slice(0, 10));
}

function sourceOf(task: Task): Source {
  return {
    title: task.title,
    text: splitDescription(task.description).text,
    due: dueValue(task),
    reminder: task.remindMinutes,
    duration: task.durationMinutes,
    ownerId: task.ownerId,
  };
}

function dueWrite(value: string): TaskDetails {
  if (!value) return { dueAt: null, remindMinutes: null };
  return padDueHasTime(value) ? { dueAt: localInstant(value) } : { dueDate: value };
}

const drafts = new Map<string, { title?: string; text?: string }>();

function keepDraft(id: string, change: { title?: string; text?: string }) {
  drafts.set(id, { ...drafts.get(id), ...change });
}

function dropDraft(id: string, field: "title" | "text") {
  const draft = drafts.get(id);
  if (!draft) return;
  delete draft[field];
  if (draft.title === undefined && draft.text === undefined) drafts.delete(id);
}

export function useTaskDetails(task: Task, canChange: boolean, shown = true) {
  const router = useRouter();
  const composer = useComposer();
  const source = sourceOf(task);
  const [draft] = useState(() => drafts.get(task.id));
  const [seen, setSeen] = useState(source);
  const [title, setTitle] = useState(draft?.title ?? source.title);
  const [text, setText] = useState(draft?.text ?? source.text);
  const [due, setDue] = useState(source.due);
  const [reminder, setReminder] = useState<number | null>(source.reminder);
  const [duration, setDuration] = useState(source.duration);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const sent = useRef({ title: source.title, text: source.text });
  const visible = useRef(shown);
  useEffect(() => {
    visible.current = shown;
    return () => {
      visible.current = false;
    };
  }, [shown]);
  if (
    seen.title !== source.title ||
    seen.text !== source.text ||
    seen.due !== source.due ||
    seen.reminder !== source.reminder ||
    seen.duration !== source.duration ||
    seen.ownerId !== source.ownerId
  ) {
    setSeen(source);
    if (title.trim() === seen.title) setTitle(source.title);
    if (text.trim() === seen.text) setText(source.text);
    if (due === seen.due) setDue(source.due);
    if (reminder === seen.reminder) setReminder(source.reminder);
    if (duration === seen.duration) setDuration(source.duration);
  }
  useEffect(() => {
    sent.current = { title: source.title, text: source.text };
  }, [source.title, source.text]);

  async function save(write: TaskDetails) {
    setError(null);
    let result: Awaited<ReturnType<typeof saveTaskDetailsAction>>;
    try {
      result = await saveTaskDetailsAction(task.id, write);
    } catch {
      result = { error: "Couldn't save. Try again." };
    }
    if (result.error) {
      setError(result.error);
      if (!visible.current) composer.showToast({ message: result.error, tone: "alert" });
      return false;
    }
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
    router.refresh();
    return true;
  }

  function saveTitle() {
    if (!canChange) return;
    const next = title.trim();
    if (!next) {
      setTitle(sent.current.title);
      dropDraft(task.id, "title");
      return;
    }
    const previous = sent.current.title;
    if (next === previous) {
      dropDraft(task.id, "title");
      return;
    }
    sent.current.title = next;
    void save({ title: next }).then((ok) => {
      if (ok) {
        dropDraft(task.id, "title");
        return;
      }
      if (sent.current.title === next) sent.current.title = previous;
      keepDraft(task.id, { title: next });
    });
  }

  function saveText() {
    if (!canChange) return;
    const next = text.trim();
    const previous = sent.current.text;
    if (next === previous) {
      dropDraft(task.id, "text");
      return;
    }
    sent.current.text = next;
    void save({ description: replaceDescriptionText(task.description, next) }).then((ok) => {
      if (ok) {
        dropDraft(task.id, "text");
        return;
      }
      if (sent.current.text === next) sent.current.text = previous;
      keepDraft(task.id, { text: next });
    });
  }

  function flush() {
    saveTitle();
    saveText();
  }

  const latestFlush = useRef(flush);
  useEffect(() => {
    latestFlush.current = flush;
  });
  useEffect(() => {
    const leave = () => latestFlush.current();
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      latestFlush.current();
    };
  }, []);

  function writeDue(value: string, write: TaskDetails, nextReminder: number | null) {
    const before = { due, reminder };
    setDue(value);
    setReminder(nextReminder);
    void save(write).then((ok) => {
      if (ok) return;
      setDue(before.due);
      setReminder(before.reminder);
    });
  }

  function changeDue(value: string) {
    writeDue(value, dueWrite(value), value && padDueHasTime(value) ? reminder : null);
  }

  function removeTime() {
    if (!due) return;
    const day = due.slice(0, 10);
    writeDue(day, { dueDate: day }, null);
  }

  function remindAt(time: string, minutes = 0) {
    const day = due ? due.slice(0, 10) : null;
    if (!day) return;
    const value = `${day}T${time}`;
    writeDue(value, { dueAt: localInstant(value), remindMinutes: minutes }, minutes);
  }

  function changeDuration(minutes: number) {
    const before = duration;
    setDuration(minutes);
    void save({ durationMinutes: minutes }).then((ok) => {
      if (!ok) setDuration(before);
    });
  }

  function changeReminder(minutes: number | null) {
    const before = reminder;
    setReminder(minutes);
    void save({ remindMinutes: minutes }).then((ok) => {
      if (!ok) setReminder(before);
    });
  }

  async function assign(ownerId: string) {
    setBusy(true);
    setError(null);
    const result = await assignTaskAction(task.id, ownerId).catch(() => ({ error: "Couldn't assign the task. Try again." }));
    setBusy(false);
    if (result.error) {
      setError(result.error);
      if (!visible.current) composer.showToast({ message: result.error, tone: "alert" });
    } else router.refresh();
  }

  return {
    task,
    canChange,
    title,
    setTitle,
    text,
    setText,
    due,
    reminder,
    duration,
    busy,
    error,
    setError,
    saved,
    saveTitle,
    saveText,
    flush,
    changeDue,
    removeTime,
    remindAt,
    changeDuration,
    changeReminder,
    assign,
  };
}

export type TaskDetailsState = ReturnType<typeof useTaskDetails>;

export function TaskTitleField({
  details,
  colleagues,
  viewerId,
  here,
  size = "panel",
}: {
  details: TaskDetailsState;
  colleagues: TitleColleague[];
  viewerId: string;
  here?: TitleHere;
  size?: "panel" | "row";
}) {
  const id = useId();
  const [editing, setEditing] = useState<number | null>(null);
  const field = useAutoSize(details.title);
  const task = details.task;
  const text = size === "panel" ? "leading-[1.3]" : "text-[15px] leading-[1.35] font-medium";
  if (!details.canChange) {
    const Heading = size === "panel" ? "h2" : "span";
    return (
      <Heading className={cn("min-w-0 flex-1 break-words", text)}>
        <TaskTitle task={task} colleagues={colleagues} viewerId={viewerId} here={here} />
      </Heading>
    );
  }
  if (editing === null) {
    const Heading = size === "panel" ? "h2" : "span";
    return (
      <div className="relative min-w-0 flex-1">
        <button
          type="button"
          aria-label="Edit title"
          onClick={() => setEditing(details.title.length)}
          className="pointer-events-none absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-(--primary)"
        />
        <Heading
          onClick={(event) => {
            if (window.getSelection()?.toString()) return;
            setEditing(caretAt(event.currentTarget, event.clientX, event.clientY) ?? details.title.length);
          }}
          className={cn("relative block cursor-text break-words", text)}
        >
          <TaskTitle task={{ ...task, title: details.title }} colleagues={colleagues} viewerId={viewerId} here={here} />
        </Heading>
      </div>
    );
  }
  return (
    <Textarea
      ref={field}
      id={`${id}-title`}
      aria-label="Title"
      rows={1}
      value={details.title}
      maxLength={200}
      autoFocus
      onFocus={(event) => event.currentTarget.setSelectionRange(editing, editing)}
      onChange={(event) => details.setTitle(event.target.value.replace(/\n/g, " "))}
      onBlur={() => {
        details.saveTitle();
        setEditing(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
      className={cn(
        "min-h-0 min-w-0 flex-1 resize-none overflow-hidden rounded-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0",
        size === "panel" ? "h2-style leading-[1.3]" : text,
      )}
    />
  );
}

const LINK_CHIP = "bg-secondary text-foreground inline-flex max-w-full items-center gap-1.5 rounded-full py-px pr-2 pl-1.5 text-[12px] leading-5 hit [@media(pointer:coarse)]:h-7 [@media(pointer:coarse)]:pr-2.5 [@media(pointer:coarse)]:pl-2";

function LinkChip({ href, label, icon: Icon, mark, record }: { href: string; label: string; icon?: ComponentType<SVGProps<SVGSVGElement>>; mark?: ReactNode; record?: boolean }) {
  const content = (
    <>
      {mark ?? (Icon && <Icon aria-hidden className="text-subtle size-3 shrink-0" />)}
      <span className="truncate">{label}</span>
    </>
  );
  return record ? (
    <TaskRecordLink href={href} className={LINK_CHIP}>
      {content}
    </TaskRecordLink>
  ) : (
    <Link href={href} className={LINK_CHIP}>
      {content}
    </Link>
  );
}

export function taskIsLinked(task: Task) {
  return Boolean(task.companyId || task.contactId || task.opportunityId || splitDescription(task.description).links.length > 0);
}

function LinksEditor({ task, canEdit, label }: { task: Task; canEdit: boolean; label?: boolean }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5 [@media(pointer:coarse)]:gap-y-4">
        {label && <span className="caption-style text-subtle mr-1">Linked</span>}
        <TaskLinks task={task} />
        {canEdit && (
          <Button variant={editing ? "secondary" : "ghost"} size="sm" aria-expanded={editing} onClick={() => setEditing((current) => !current)} className="hit">
            Edit links
          </Button>
        )}
      </div>
      {editing && canEdit && <EditLinks task={task} />}
    </div>
  );
}

export function TaskLinks({ task }: { task: Task }) {
  const links = splitDescription(task.description).links;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 [@media(pointer:coarse)]:gap-y-4">
      {task.contactId && task.contactName && <LinkChip record href={contactHref(task.contactId)} label={task.contactName} icon={ContactIcon} />}
      {task.companyId && task.companyName && (
        <LinkChip record href={companyHref(task.companyId)} label={task.companyName} mark={<Monogram name={task.companyName} className="size-4 rounded-full text-[9px]" />} />
      )}
      {task.opportunityId && task.opportunityName && <LinkChip record href={recordHref("opportunity", task.opportunityId)} label={task.opportunityName} icon={OpportunityIcon} />}
      {links.map((link, index) => (
        <LinkChip key={`${index}:${link.href}`} href={link.href} label={link.label} icon={MailIcon} />
      ))}
    </div>
  );
}

function CandidateRow({ candidate, busy, onLink }: { candidate: LinkCandidate; busy: string | null; onLink: (candidate: LinkCandidate) => void }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-lg px-1.5 py-1 hover:bg-white/[0.04]">
      <Monogram name={candidate.name} className="size-6 rounded-full text-[10px]" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="ui-style text-foreground truncate">{candidate.name}</span>
        {candidate.detail && <span className="caption-style text-subtle truncate">{candidate.detail}</span>}
      </span>
      <Button
        variant="secondary"
        size="sm"
        disabled={Boolean(busy)}
        aria-busy={busy === candidate.id || undefined}
        aria-label={`Link ${candidate.name}`}
        onClick={() => onLink(candidate)}
        className="hit"
      >
        {busy === candidate.id ? "Linking…" : "Link"}
      </Button>
    </div>
  );
}

const SEARCH_FAILED = "Couldn't search. Try again.";

export function LinkPerson({ taskId, title, onLinked }: { taskId: string; title: string; onLinked: () => void }) {
  const searchId = useId();
  const [found, setFound] = useState<{ candidates: LinkCandidate[]; reason: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ query: string; items: LinkCandidate[] } | null>(null);
  const shownFor = `${taskId}|${title}`;
  const [seenFor, setSeenFor] = useState(shownFor);
  if (seenFor !== shownFor) {
    setSeenFor(shownFor);
    setBusy(null);
  }

  useEffect(() => {
    let cancelled = false;
    void taskLinkCandidatesAction(taskId)
      .catch(() => ({ error: "Couldn't find people to link. Try again." }))
      .then((result) => {
        if (cancelled) return;
        if ("candidates" in result && result.candidates) {
          setFound({ candidates: result.candidates, reason: result.reason ?? null });
          setError(null);
        } else setError(result.error ?? "Couldn't find people to link. Try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, title]);

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void searchTaskLinkTargetsAction(taskId, text)
        .then((result) => {
          if (cancelled) return;
          if ("error" in result && result.error) {
            setError(result.error);
            return;
          }
          const { contacts: found, companies } = result;
          setError((current) => (current === SEARCH_FAILED ? null : current));
          setResults({
            query: text,
            items: [
              ...found.slice(0, 6).map((person) => ({
                kind: "contact" as const,
                id: person.id,
                name: person.name,
                detail: [person.jobTitle, person.companyName].filter(Boolean).join(" · ") || null,
              })),
              ...companies.slice(0, 4).map((company) => ({ kind: "company" as const, id: company.id, name: company.name, detail: company.domain })),
            ],
          });
        })
        .catch(() => !cancelled && setError(SEARCH_FAILED));
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, taskId]);

  async function link(candidate: LinkCandidate) {
    if (busy) return;
    setBusy(candidate.id);
    setError(null);
    const result = await linkTaskAction(taskId, candidate.kind === "contact" ? { contactId: candidate.id } : { companyId: candidate.id }).catch(() => ({
      error: "Couldn't link the task. Try again.",
    }));
    if (result.error) {
      setBusy(null);
      setError(result.error);
      return;
    }
    onLinked();
  }

  const candidates = found?.candidates ?? [];
  const withCompanies = candidates.some((candidate) => candidate.kind === "company");
  const heading = withCompanies ? "Link a person or company" : "Link a person";
  const offered = new Set(candidates.map((candidate) => `${candidate.kind}:${candidate.id}`));
  const searched = results && results.query === query.trim() ? results.items.filter((item) => !offered.has(`${item.kind}:${item.id}`)) : null;
  return (
    <section aria-label={heading} className="flex flex-col gap-1 rounded-xl bg-white/[0.04] p-2.5 [@media(pointer:coarse)]:gap-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-0.5 pb-1">
        <LinkIcon aria-hidden className="text-subtle size-3.5 shrink-0" />
        <h3>{heading}</h3>
        {found && <span className="caption-style text-subtle">{found.reason ?? (candidates.length === 0 ? "No one in Orbit matches a name in this task." : null)}</span>}
      </div>
      {!found && !error && (
        <p role="status" className="caption-style text-subtle px-0.5">
          Looking…
        </p>
      )}
      {candidates.map((candidate) => (
        <CandidateRow key={`${candidate.kind}:${candidate.id}`} candidate={candidate} busy={busy} onLink={(item) => void link(item)} />
      ))}
      <label htmlFor={searchId} className="sr-only">
        Someone else
      </label>
      <Input
        id={searchId}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Someone else"
        autoComplete="off"
        className="mt-1"
      />
      {query.trim().length >= 2 && searched && searched.length === 0 && <p className="caption-style text-subtle px-0.5">No matches.</p>}
      {query.trim().length >= 2 &&
        searched?.map((candidate) => <CandidateRow key={`found:${candidate.kind}:${candidate.id}`} candidate={candidate} busy={busy} onLink={(item) => void link(item)} />)}
      {error && (
        <p role="alert" className="caption-style text-danger px-0.5">
          {error}
        </p>
      )}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="caption-style text-subtle pt-1.5">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1.5 [@media(pointer:coarse)]:gap-y-4">{children}</dd>
    </>
  );
}

function Section({ label, count, children }: { label: string; count?: number; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h3 id={id} className="eyebrow-style flex items-center gap-2">
        {label}
        {count !== undefined && count > 0 && <span className="text-subtle tabular-nums">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

export { Section as TaskSection };

function dueState(details: TaskDetailsState) {
  const timed = padDueHasTime(details.due);
  const dueAt = details.due ? (padDueHasTime(details.due) ? localInstant(details.due) : toIsoInstant(details.due)) : null;
  return { timed, dueAt };
}

function scheduleTask(details: TaskDetailsState) {
  const { timed, dueAt } = dueState(details);
  return { id: details.task.id, title: details.task.title, dueAt, dueHasTime: timed, durationMinutes: details.duration };
}

function ReminderChip({ details, id }: { details: TaskDetailsState; id: string }) {
  const { timed } = dueState(details);
  if (!details.due) return null;
  if (!timed) {
    return <ReminderTimePrompt title={details.task.title} day={details.due.slice(0, 10)} onSave={(time) => details.remindAt(time)} className={cn(TASK_CHIP, TOUCH, "text-subtle")} />;
  }
  return (
    <ReminderSelect
      id={`${id}-reminder`}
      value={details.reminder === null ? "none" : String(details.reminder)}
      onChange={(value) => details.changeReminder(value === "none" ? null : Number(value))}
      className={cn(TASK_CHIP, TOUCH, details.reminder === null && "text-subtle")}
    />
  );
}

function ReadOnlyDue({ details }: { details: TaskDetailsState }) {
  const [now] = useState(() => Date.now());
  const task = details.task;
  if (!task.dueAt) return <span className="ui-style text-soft">No due date</span>;
  const reminder = task.dueHasTime ? reminderLabel(task.remindMinutes)?.toLowerCase() : null;
  return (
    <span className="ui-style text-soft">
      {[taskDueLabel(task, now), durationLabel(task.durationMinutes)].join(" · ")}
      {reminder ? ` · reminder ${reminder}` : ""}
    </span>
  );
}

function DueChips({ details, layout }: { details: TaskDetailsState; layout: "panel" | "row" }) {
  const id = useId();
  if (!details.canChange) return <ReadOnlyDue details={details} />;
  const label = details.due ? (padDueHasTime(details.due) ? formatDateTimeLabel(details.due) : formatDateLabel(details.due)) : null;
  return (
    <>
      <DueDatePicker
        id={`${id}-due`}
        aria-label={label ? `Due ${label}. Change` : "Due date"}
        placeholder={layout === "row" ? "Due" : "No due date"}
        value={details.due}
        onChange={details.changeDue}
        className={cn(TASK_CHIP, TOUCH, "[&_svg]:size-3.5", !details.due && "text-subtle")}
      />
      {layout === "panel" && <ScheduleChip details={details} />}
      {layout === "row" && (
        <>
          <DurationMenu value={details.duration} onChange={details.changeDuration} className={cn(TASK_CHIP, TOUCH)} />
          <ReminderChip details={details} id={id} />
        </>
      )}
    </>
  );
}

function ScheduleChip({ details }: { details: TaskDetailsState }) {
  return (
    <ScheduleMenu
      task={scheduleTask(details)}
      onSchedule={details.changeDue}
      onRemoveTime={details.removeTime}
      onDuration={details.changeDuration}
      className={cn(TASK_CHIP, TOUCH)}
    />
  );
}

function AssigneeChip({ details, viewer, members, tagged }: { details: TaskDetailsState; viewer: Pick<Viewer, "id">; members: AssignableMember[]; tagged: string[] }) {
  const task = details.task;
  const owner = members.find((member) => member.id === task.ownerId) ?? (task.ownerId ? { id: task.ownerId, name: task.ownerName ?? "Former member" } : null);
  const colleague = owner && owner.id !== viewer.id && members.some((member) => member.id === owner.id) ? owner : null;
  return (
    <>
      {members.length > 1 && details.canChange ? (
        <AssigneePicker
          members={members}
          value={task.ownerId}
          viewerId={viewer.id}
          tagged={tagged}
          onPick={(ownerId) => void details.assign(ownerId)}
          label={`Assignee: ${owner?.name ?? "No one"}. Change`}
          disabled={details.busy}
          handOnNote
          trigger={
            <span className={cn("inline-flex items-center", TOUCH, TASK_CHIP)}>
              <MemberAvatar member={owner} viewerId={viewer.id} size="xs" />
              <span className="truncate">{owner?.name ?? "No one"}</span>
              <ChevronDownIcon aria-hidden className="text-subtle size-3 shrink-0" />
            </span>
          }
        />
      ) : (
        <span className="ui-style flex min-w-0 items-center gap-2">
          {owner && <MemberAvatar member={owner} viewerId={viewer.id} size="xs" />}
          <span className="truncate">{owner?.name ?? "No one"}</span>
        </span>
      )}
      {colleague && (
        <ColleagueLink colleague={colleague} className="text-subtle hover:text-foreground inline-flex size-7 items-center justify-center rounded-full no-underline hover:bg-white/10 hit [@media(pointer:coarse)]:mx-1">
          <ChatIcon aria-hidden className="size-3.5" />
        </ColleagueLink>
      )}
    </>
  );
}

function QuickDates({ details }: { details: TaskDetailsState }) {
  const [now] = useState(() => Date.now());
  const { timed, dueAt } = dueState(details);
  const choices = taskSnoozeChoices({ dueAt, dueHasTime: timed }, new Date(now));
  return (
    <>
      <ScheduleMenu
        task={scheduleTask(details)}
        onSchedule={details.changeDue}
        onRemoveTime={details.removeTime}
        onDuration={details.changeDuration}
        className={cn(buttonVariants({ variant: "ghost", size: "sm" }), TOUCH)}
      >
        Schedule
        <Kbd aria-hidden className="ml-0.5 hidden h-4 min-w-4 px-1 lg:inline-flex [@media(pointer:coarse)]:hidden">
          S
        </Kbd>
      </ScheduleMenu>
      {choices.map((choice) => (
        <Button
          key={choice.id}
          variant="ghost"
          size="sm"
          title={choice.detail}
          onClick={() => details.changeDue(timed ? dateTimeInputValue(choice.at) : dateTimeInputValue(choice.at).slice(0, 10))}
          className={TOUCH}
        >
          {choice.label}
        </Button>
      ))}
    </>
  );
}

function Description({ details, layout }: { details: TaskDetailsState; layout: "panel" | "row" }) {
  const field = useAutoSize(details.text);
  if (!details.canChange) {
    if (layout === "row" && !details.text) return null;
    return <p className="text-soft whitespace-pre-wrap">{details.text || "No description"}</p>;
  }
  return (
    <Textarea
      ref={field}
      aria-label="Description"
      value={details.text}
      placeholder="Add a description"
      onChange={(event) => details.setText(event.target.value)}
      onBlur={details.saveText}
      className={cn(
        "resize-none overflow-hidden",
        layout === "panel" ? "min-h-16" : "min-h-0 rounded-lg border-transparent bg-transparent px-2 py-1.5 text-[13.5px] leading-[1.5] shadow-none hover:bg-white/[0.04] focus-visible:bg-white/[0.04] -mx-2",
      )}
      rows={layout === "row" ? 1 : undefined}
    />
  );
}

function SavedNote({ details }: { details: TaskDetailsState }) {
  return (
    <span role="status" className="caption-style text-subtle empty:hidden">
      {details.saved ? "Saved" : ""}
    </span>
  );
}

export default function TaskFields({
  details,
  viewer,
  members,
  tagged,
  layout,
  extra,
  tagging,
  done = false,
}: {
  details: TaskDetailsState;
  viewer: Pick<Viewer, "id" | "role">;
  members: AssignableMember[];
  tagged: string[];
  layout: "panel" | "row";
  extra?: ReactNode;
  tagging?: TaskTagging;
  done?: boolean;
}) {
  const router = useRouter();
  const task = details.task;
  const unlinked = !task.companyId && !task.contactId && !task.opportunityId;
  const linkPerson = unlinked && details.canChange && !done;
  const people = tagged.filter((person) => person !== task.ownerId);
  const team = members.length > 1;

  if (layout === "row") {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1.5 [@media(pointer:coarse)]:gap-y-4">
          <DueChips details={details} layout="row" />
          {(team || (task.ownerId && task.ownerId !== viewer.id)) && <AssigneeChip details={details} viewer={viewer} members={members} tagged={people} />}
          {details.canChange && !done && (
            <>
              <span aria-hidden className="bg-line-strong mx-1 h-4 w-px" />
              <QuickDates details={details} />
            </>
          )}
        </div>
        <Description details={details} layout="row" />
        {taskIsLinked(task) && <LinksEditor task={task} canEdit={details.canChange && !done && !unlinked} label />}
        {linkPerson && <LinkPerson taskId={task.id} title={task.title} onLinked={() => router.refresh()} />}
        {details.error && (
          <p role="alert" className="caption-style text-danger">
            {details.error}
          </p>
        )}
        <SavedNote details={details} />
      </div>
    );
  }

  return (
    <>
      {linkPerson && <LinkPerson taskId={task.id} title={task.title} onLinked={() => router.refresh()} />}
      {extra}
      <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 max-md:grid-cols-[5.5rem_minmax(0,1fr)]">
        <Field label="Assignee">
          <AssigneeChip details={details} viewer={viewer} members={members} tagged={people} />
        </Field>
        <Field label="Due">
          <DueChips details={details} layout="panel" />
        </Field>
        {details.canChange && (
          <Field label="Duration">
            <DurationMenu value={details.duration} onChange={details.changeDuration} className={cn(TASK_CHIP, TOUCH)} />
          </Field>
        )}
        {details.canChange && details.due && (
          <Field label="Remind me">
            <ReminderChip details={details} id={task.id} />
          </Field>
        )}
        {team && <TaggedField details={details} viewer={viewer} members={members} people={people} tagging={tagging} />}
      </dl>
      {taskIsLinked(task) && (
        <Section label="Linked">
          <LinksEditor task={task} canEdit={details.canChange && !done && !unlinked} />
        </Section>
      )}
      <Section label="Description">
        <Description details={details} layout="panel" />
      </Section>
      <SavedNote details={details} />
    </>
  );
}

export type TaskTagging = { removed: string[]; remove: (person: string) => void };

function TaggedField({ details, viewer, members, people, tagging }: { details: TaskDetailsState; viewer: Pick<Viewer, "id" | "role">; members: AssignableMember[]; people: string[]; tagging?: TaskTagging }) {
  const task = details.task;
  const shown = people.filter((person) => !tagging?.removed.includes(person));
  return (
    <Field label="Tagged">
      {shown.map((person) => {
        const member = members.find((item) => item.id === person) ?? { id: person, name: "Former member" };
        const removable = canRemoveTag(viewer, task, person);
        const colleague = member.id !== viewer.id && members.some((item) => item.id === member.id);
        return (
          <span key={person} className={cn("inline-flex items-center", TASK_CHIP, removable && "pr-0.5 [@media(pointer:coarse)]:pr-1")}>
            <MemberAvatar member={member} viewerId={viewer.id} size="xs" />
            {colleague ? <ColleagueLink colleague={member} className="truncate no-underline hover:underline" /> : <span className="truncate">{member.name}</span>}
            {removable && tagging && (
              <Button
                variant="ghost"
                size="none"
                aria-label={person === viewer.id ? "Remove yourself" : `Remove ${member.name}`}
                title="Remove"
                onClick={() => tagging.remove(person)}
                className="hit size-6 rounded-full [@media(pointer:coarse)]:ml-1"
              >
                <XIcon aria-hidden className="size-3" />
              </Button>
            )}
          </span>
        );
      })}
      <span className="caption-style text-subtle">Tag people with @ below.</span>
    </Field>
  );
}
