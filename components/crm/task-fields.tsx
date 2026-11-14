"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode, type SVGProps } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useComposer } from "@/components/mail/compose-dock";
import Button, { buttonVariants } from "@/components/_ui/button";
import { Kbd } from "@/components/_ui/command";
import { DueDatePicker } from "@/components/_ui/date-picker";
import { Textarea } from "@/components/_ui/textarea";
import { Monogram } from "@/components/beautifui/record-marks";
import AssigneePicker, { MemberAvatar, type AssignableMember } from "@/components/crm/assignee-picker";
import ReminderSelect from "@/components/crm/reminder-select";
import { DurationMenu, ReminderTimePrompt, ScheduleMenu } from "@/components/crm/task-timing";
import TaskLinkChips from "@/components/crm/task-link-chips";
import { useDocMention } from "@/components/crm/task-doc-mention";
import { othersSeeTask, TaskDocChips } from "@/components/crm/task-docs";
import LinkedText from "@/components/_ui/linked-text";
import { descriptionParts, partsSourceOffset, showsDescriptionLinks, type DescriptionPart } from "@/lib/task-doc-picks";
import type { Viewer } from "@/components/crm/viewer";
import { assignTaskAction } from "@/app/(crm)/records";
import TaskTitle, { ColleagueLink } from "@/components/crm/task-title";
import { TaskRecordLink } from "@/components/crm/task-workspace";
import { saveTaskDetailsAction, type TaskDetails } from "@/app/(crm)/discussions";
import { companyHref, contactHref } from "@/lib/crm/hrefs";
import { reminderLabel } from "@/lib/crm/reminder-options";
import { taskSnoozeChoices } from "@/lib/crm/task-snooze";
import type { TitleColleague, TitleHere } from "@/lib/crm/task-title";
import type { Task } from "@/lib/crm/types";
import { pageHref, recordHref } from "@/lib/docs/routes";
import { threadHref } from "@/lib/mail/view";
import { timingSaves, type TimingValues } from "@/lib/timing-saves";
import { dayOnlyNote, ownerSetsTime, ownerTimeLine, padDueHasTime } from "@/lib/task-pad";
import { formatDateLabel, formatDateTimeLabel } from "@/lib/date-input";
import { durationLabel, localInstant } from "@/lib/crm/task-time";
import { taskDueLabel } from "@/lib/crm/task-views";
import { appTimeZone, dateTimeInputValue, toIsoInstant } from "@/lib/time";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
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

export function canChangeTaskAs(viewer: Pick<Viewer, "id">, task: Pick<Task, "ownerId" | "createdByUserId">) {
  return task.ownerId === viewer.id || task.createdByUserId === viewer.id;
}

export function canRemoveTag(viewer: Pick<Viewer, "id">, task: Pick<Task, "ownerId" | "createdByUserId">, person: string) {
  return person === viewer.id || canChangeTaskAs(viewer, task);
}

export function changersLine(names: string[]) {
  const people = [...new Set(names.filter(Boolean))];
  if (people.length === 0) return "";
  if (people.length === 1) return `${people[0]} can change it.`;
  return `${people.slice(0, -1).join(", ")} and ${people[people.length - 1]} can change it.`;
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

function asksForTime(write: TaskDetails) {
  return Boolean(write.dueAt) || (write.remindMinutes !== undefined && write.remindMinutes !== null);
}

function touchesTiming(write: TaskDetails) {
  return write.dueAt !== undefined || write.dueDate !== undefined || write.remindMinutes !== undefined || write.durationMinutes !== undefined;
}

function sourceOf(task: Task): Source {
  return {
    title: task.title,
    text: task.description?.trim() ?? "",
    due: dueValue(task),
    reminder: task.remindMinutes,
    duration: task.durationMinutes,
    ownerId: task.ownerId,
  };
}

function dueWrite(value: string): TaskDetails {
  if (!value) return { dueAt: null, remindMinutes: null };
  return padDueHasTime(value) ? { dueAt: localInstant(value), dueHasTime: true } : { dueDate: value };
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

export function useTaskDetails(task: Task, canChange: boolean, shown = true, viewerId: string | null = null) {
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
  const [notice, setNotice] = useState<string | null>(null);
  const sent = useRef({ title: source.title, text: source.text });
  const timingError = useRef(false);
  const [timing] = useState(() => timingSaves({ due: source.due, reminder: source.reminder, duration: source.duration }));
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
    if (!timing.pending()) {
      if (due === seen.due) setDue(source.due);
      if (reminder === seen.reminder) setReminder(source.reminder);
      if (duration === seen.duration) setDuration(source.duration);
    }
  }
  useEffect(() => {
    timing.observe({ due: source.due, reminder: source.reminder, duration: source.duration });
  }, [timing, source.due, source.reminder, source.duration]);
  useEffect(() => {
    sent.current = { title: source.title, text: source.text };
  }, [source.title, source.text]);

  function show(values: TimingValues) {
    setDue(values.due);
    setReminder(values.reminder);
    setDuration(values.duration);
  }

  async function save(write: TaskDetails) {
    const timed = touchesTiming(write);
    const ticket = timed ? timing.start() : 0;
    setError(null);
    setNotice(null);
    let result: Awaited<ReturnType<typeof saveTaskDetailsAction>>;
    try {
      result = await saveTaskDetailsAction(task.id, write);
    } catch {
      result = { error: "Couldn't save. Try again." };
    }
    if (result.error) {
      const restore = timed ? timing.fail(ticket) : null;
      if (restore) show(restore);
      timingError.current = timed;
      setError(result.error);
      if (!visible.current) composer.showToast({ message: result.error, tone: "alert" });
      return false;
    }
    const applied = timed && result.saved ? timing.succeed(ticket, { due: dueValue(result.saved), reminder: result.saved.remindMinutes, duration: result.saved.durationMinutes }) : null;
    if (timed && !result.saved) timing.fail(ticket);
    if (applied && result.saved) {
      show(applied);
      if (timingError.current) {
        timingError.current = false;
        setError(null);
      }
      if (asksForTime(write) && result.saved.dueAt && !result.saved.dueHasTime) {
        const note = dayOnlyNote(task.ownerName);
        setNotice(note);
        if (!visible.current) composer.showToast({ message: note });
      }
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
    void save({ description: next || null }).then((ok) => {
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
    setDue(value);
    setReminder(nextReminder);
    void save(write);
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
    writeDue(value, { dueAt: localInstant(value), dueHasTime: true, remindMinutes: minutes }, minutes);
  }

  function changeDuration(minutes: number) {
    setDuration(minutes);
    void save({ durationMinutes: minutes });
  }

  function changeReminder(minutes: number | null) {
    setReminder(minutes);
    void save({ remindMinutes: minutes });
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
    ownerSetsTime: ownerSetsTime(viewerId, task.ownerId) && !task.dueHasTime,
    notice,
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
  docWarn = false,
}: {
  details: TaskDetailsState;
  colleagues: TitleColleague[];
  viewerId: string;
  here?: TitleHere;
  size?: "panel" | "row";
  docWarn?: boolean;
}) {
  const id = useId();
  const [editing, setEditing] = useState<number | null>(null);
  const autoSize = useAutoSize(details.title);
  const task = details.task;
  const mention = useDocMention({
    task,
    enabled: details.canChange && task.canLinkDocs && !task.completedAt,
    warn: docWarn,
    mode: "title",
    value: details.title,
    onChange: details.setTitle,
  });
  const attachMention = mention.attach;
  const field = useCallback(
    (node: HTMLTextAreaElement | null) => {
      attachMention(node);
      autoSize(node);
    },
    [autoSize, attachMention],
  );
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
    const heading = (
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
    if (!mention.status) return heading;
    return (
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {heading}
        {mention.status}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <Textarea
        ref={field}
        id={`${id}-title`}
        aria-label="Title"
        rows={1}
        value={details.title}
        maxLength={200}
        autoFocus
        {...mention.fieldProps}
        onFocus={(event) => {
          mention.keepOpen();
          event.currentTarget.setSelectionRange(editing, editing);
        }}
        onChange={(event) => {
          const value = event.target.value.replace(/\n/g, " ");
          details.setTitle(value);
          mention.refresh(value, event.target.selectionStart ?? value.length);
        }}
        onSelect={(event) => mention.refresh(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)}
        onBlur={() => {
          mention.close();
          details.saveTitle();
          setEditing(null);
        }}
        onKeyDown={(event) => {
          if (mention.onKeyDown(event)) return;
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
      {mention.menu}
      {mention.status}
    </div>
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
  return Boolean(task.companyId || task.contactId || task.opportunityId || task.mailThreadKey || task.docs.length > 0);
}

function LinkedReadOnly({ task, label }: { task: Task; label: boolean }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 [@media(pointer:coarse)]:gap-y-4">
      {label && <span className="caption-style text-subtle mr-1">Linked</span>}
      <TaskLinks task={task} />
    </div>
  );
}

function MailChip({ task }: { task: Task }) {
  if (!task.mailThreadKey) return null;
  const thread = task.mailThread;
  if (!thread?.readable) {
    return (
      <span className={LINK_CHIP}>
        <MailIcon aria-hidden className="text-subtle size-3 shrink-0" />
        <span className="truncate">Email</span>
      </span>
    );
  }
  return <LinkChip href={threadHref(task.mailThreadKey)} label={thread.subject || "Email"} icon={MailIcon} />;
}

export function TaskLinks({ task }: { task: Task }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 [@media(pointer:coarse)]:gap-y-4">
      {task.contactId && task.contactName && <LinkChip record href={contactHref(task.contactId)} label={task.contactName} icon={ContactIcon} />}
      {task.companyId && task.companyName && (
        <LinkChip record href={companyHref(task.companyId)} label={task.companyName} mark={<Monogram name={task.companyName} className="size-4 rounded-full text-[9px]" />} />
      )}
      {task.opportunityId && task.opportunityName && <LinkChip record href={recordHref("opportunity", task.opportunityId)} label={task.opportunityName} icon={OpportunityIcon} />}
      <MailChip task={task} />
      <TaskDocChips task={task} />
    </div>
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
  if (!timed && details.ownerSetsTime) return <span className="caption-style text-subtle">{ownerTimeLine(details.task.ownerName)}</span>;
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

const DOC_LINK = "text-soft underline decoration-white/35 underline-offset-[3px] [overflow-wrap:anywhere] hover:text-foreground hover:decoration-current";

function DescriptionText({ parts }: { parts: DescriptionPart[] }) {
  return parts.map((part) =>
    part.kind === "doc" ? (
      <Link key={part.start} href={pageHref(part.id)} className={DOC_LINK}>
        {part.label}
      </Link>
    ) : (
      <LinkedText key={part.start} text={part.text} />
    ),
  );
}

function Description({ details, layout, warn }: { details: TaskDetailsState; layout: "panel" | "row"; warn: boolean }) {
  const task = details.task;
  const autoSize = useAutoSize(details.text);
  const own = useRef<HTMLTextAreaElement | null>(null);
  const mention = useDocMention({
    task,
    enabled: details.canChange && task.canLinkDocs && !task.completedAt,
    warn,
    mode: "description",
    value: details.text,
    onChange: details.setText,
    onStore: () => {
      storeAfter.current = true;
    },
  });
  const storeAfter = useRef(false);
  useEffect(() => {
    if (!storeAfter.current) return;
    storeAfter.current = false;
    details.saveText();
  }, [details]);
  const attachMention = mention.attach;
  const attach = useCallback(
    (node: HTMLTextAreaElement | null) => {
      own.current = node;
      attachMention(node);
      autoSize(node);
    },
    [autoSize, attachMention],
  );
  const [editing, setEditing] = useState<number | null>(null);
  useEffect(() => {
    if (editing === null) return;
    const settle = () => {
      if (document.activeElement !== own.current) setEditing(null);
    };
    const later = () => window.setTimeout(settle, 0);
    window.addEventListener("focus", later);
    return () => window.removeEventListener("focus", later);
  }, [editing]);
  const parts = descriptionParts(details.text, task.docs);
  if (!details.canChange) {
    if (layout === "row" && !details.text) return null;
    return (
      <p className={cn("text-soft break-words whitespace-pre-wrap", layout === "row" && "text-[13.5px] leading-[1.5]")}>
        {details.text ? <DescriptionText parts={parts} /> : "No description"}
      </p>
    );
  }
  if (showsDescriptionLinks(details.text, layout, editing !== null)) {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <div className="relative min-w-0">
          <button
            type="button"
            aria-label="Edit description"
            onClick={() => setEditing(details.text.length)}
            className="pointer-events-none absolute inset-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-(--primary)"
          />
          <p
            onClick={(event) => {
              if ((event.target as HTMLElement).closest("a")) return;
              const selection = window.getSelection();
              if (selection && !selection.isCollapsed && selection.anchorNode && event.currentTarget.contains(selection.anchorNode)) return;
              const shown = caretAt(event.currentTarget, event.clientX, event.clientY);
              setEditing(shown === null ? details.text.length : partsSourceOffset(details.text, parts, shown));
            }}
            className={cn(
              "relative cursor-text break-words whitespace-pre-wrap",
              layout === "panel"
                ? "border-line-strong bg-secondary text-foreground min-h-16 rounded-lg border px-3 py-2 text-[14px] leading-5"
                : "-mx-2 rounded-lg px-2 py-1.5 text-[13.5px] leading-[1.5] hover:bg-white/[0.04]",
            )}
          >
            <DescriptionText parts={parts} />
          </p>
        </div>
        {mention.status}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Textarea
        ref={attach}
        aria-label="Description"
        value={details.text}
        placeholder="Add a description"
        autoFocus={editing !== null}
        {...mention.fieldProps}
        onFocus={(event) => {
          mention.keepOpen();
          if (editing !== null) event.currentTarget.setSelectionRange(editing, editing);
          else setEditing(event.currentTarget.selectionStart ?? details.text.length);
        }}
        onChange={(event) => {
          details.setText(event.target.value);
          mention.refresh(event.target.value, event.target.selectionStart ?? event.target.value.length);
        }}
        onSelect={(event) => mention.refresh(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)}
        onKeyDown={(event) => {
          mention.onKeyDown(event);
        }}
        onBlur={() => {
          mention.close();
          details.saveText();
          if (document.hasFocus()) setEditing(null);
        }}
        className={cn(
          "resize-none overflow-hidden",
          layout === "panel" ? "min-h-16" : "min-h-0 rounded-lg border-transparent bg-transparent px-2 py-1.5 text-[13.5px] leading-[1.5] shadow-none hover:bg-white/[0.04] focus-visible:bg-white/[0.04] -mx-2",
        )}
        rows={layout === "row" ? 1 : undefined}
      />
      {mention.menu}
      {mention.status}
    </div>
  );
}

function SavedNote({ details }: { details: TaskDetailsState }) {
  return (
    <span role="status" className="caption-style text-subtle empty:hidden">
      {details.notice ?? (details.saved ? "Saved" : "")}
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
  viewer: Pick<Viewer, "id">;
  members: AssignableMember[];
  tagged: string[];
  layout: "panel" | "row";
  extra?: ReactNode;
  tagging?: TaskTagging;
  done?: boolean;
}) {
  const task = details.task;
  const editLinks = details.canChange && !done;
  const warn = othersSeeTask(task, viewer.id, tagged);
  const people = tagged.filter((person) => person !== task.ownerId);
  const team = members.length > 1;

  if (layout === "row") {
    return (
      <div className="flex flex-col gap-3 [@media(pointer:coarse)]:gap-4">
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
        {editLinks ? <TaskLinkChips task={task} warn={warn} /> : taskIsLinked(task) && <LinkedReadOnly task={task} label />}
        <Description details={details} layout="row" warn={warn} />
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
      {extra}
      <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 max-md:grid-cols-[5.5rem_minmax(0,1fr)] [@media(pointer:coarse)]:gap-y-4">
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
        {(editLinks || taskIsLinked(task)) && (
          <Field label="Linked">{editLinks ? <TaskLinkChips task={task} warn={warn} /> : <TaskLinks task={task} />}</Field>
        )}
        {team && <TaggedField details={details} viewer={viewer} members={members} people={people} tagging={tagging} />}
      </dl>
      <Section label="Description">
        <Description details={details} layout="panel" warn={warn} />
      </Section>
      <SavedNote details={details} />
    </>
  );
}

export type TaskTagging = { removed: string[]; remove: (person: string) => void };

function TaggedField({ details, viewer, members, people, tagging }: { details: TaskDetailsState; viewer: Pick<Viewer, "id">; members: AssignableMember[]; people: string[]; tagging?: TaskTagging }) {
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
