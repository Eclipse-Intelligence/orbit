"use client";

import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { DateTimePicker } from "@/components/_ui/date-picker";
import { Sheet, SheetCloseButton, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/_ui/sheet";
import { Textarea } from "@/components/_ui/textarea";
import { EntityChip } from "@/components/beautifui/record-marks";
import { DiscussionComposer, DiscussionMessages, DiscussionNotice, DiscussionProvider, DiscussionThread, holdEscape } from "@/components/chat/discussion";
import { useDiscussion } from "@/components/chat/use-discussion";
import AssigneePicker, { MemberAvatar, type AssignableMember } from "@/components/crm/assignee-picker";
import ReminderSelect from "@/components/crm/reminder-select";
import type { Viewer } from "@/components/crm/viewer";
import RecordNotes from "@/components/docs/record-notes";
import { assignTaskAction, completeTaskAction } from "@/app/(crm)/records";
import { saveTaskDetailsAction, untagTaskAction, type TaskDetails } from "@/app/(crm)/discussions";
import { companyHref, contactHref } from "@/lib/crm/hrefs";
import { reminderLabel } from "@/lib/crm/reminder-options";
import { joinDescription, splitDescription } from "@/lib/crm/task-description";
import type { Task } from "@/lib/crm/types";
import { recordHref } from "@/lib/docs/routes";
import { appTimeZone, dateTimeInputValue } from "@/lib/time";
import { cn } from "@/lib/utils";
import MailIcon from "@/public/assets/images/mail/mail-open.svg";
import UsersIcon from "@/public/assets/images/companies/sidebar/users.svg";
import XIcon from "@/public/assets/images/companies/detail/x.svg";

const CHIP =
  "h-7 w-auto max-w-full min-w-0 gap-1.5 rounded-full border-transparent bg-white/[0.06] px-2.5 text-[12.5px] leading-none text-soft hover:bg-white/10 hover:text-foreground";
function formatIn(options: Intl.DateTimeFormatOptions, iso: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: appTimeZone(),
    ...options,
  }).format(new Date(iso));
}

function useAutoSize(ref: RefObject<HTMLTextAreaElement | null>, value: string) {
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }, [ref, value]);
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
  return `${[...people, "admins"].slice(0, -1).join(", ")} and admins can change it.`;
}

function firstName(name: string | null | undefined) {
  return name?.trim().split(/\s+/)[0] ?? "";
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="caption-style text-subtle pt-1.5">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1.5">{children}</dd>
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

type PanelProps = {
  task: Task;
  viewer: Viewer;
  members: AssignableMember[];
  tagged: string[];
  onClose: () => void;
};

function TaskPanelBody({ task, viewer, members, tagged, onClose }: PanelProps) {
  const router = useRouter();
  const id = useId();
  const discussion = useDiscussion("task", task.id, {
    id: viewer.id,
    name: viewer.name,
  });
  const canChange = canChangeTaskAs(viewer, task);
  const team = members.length > 1;
  const named = (person: string | null) => (person ? (members.find((member) => member.id === person) ?? null) : null);
  const owner = named(task.ownerId) ?? (task.ownerId ? { id: task.ownerId, name: task.ownerName ?? "Former member" } : null);
  const creator = named(task.createdByUserId);
  const description = splitDescription(task.description);
  const [title, setTitle] = useState(task.title);
  const [text, setText] = useState(description.text);
  const [due, setDue] = useState(dateTimeInputValue(task.dueAt));
  const [reminder, setReminder] = useState<number | null>(task.remindMinutes);
  const [done, setDone] = useState(Boolean(task.completedAt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removed, setRemoved] = useState<string[]>([]);
  const people = tagged.filter((person) => person !== task.ownerId && !removed.includes(person));
  const isTagged = tagged.includes(viewer.id);
  const readOnly = !canChange;
  const titleField = useRef<HTMLTextAreaElement>(null);
  const textField = useRef<HTMLTextAreaElement>(null);
  useAutoSize(titleField, title);
  useAutoSize(textField, text);

  async function save(write: TaskDetails) {
    setError(null);
    const result = await saveTaskDetailsAction(task.id, write);
    if (result.error) {
      setError(result.error);
      return false;
    }
    router.refresh();
    return true;
  }

  function saveTitle() {
    const next = title.trim();
    if (!next) {
      setTitle(task.title);
      return;
    }
    if (next !== task.title) void save({ title: next });
  }

  function saveText() {
    if (text.trim() === description.text) return;
    void save({ description: joinDescription(text, description.links) });
  }

  async function complete() {
    if (done || busy || !canChange) return;
    setBusy(true);
    setDone(true);
    setError(null);
    const result = await completeTaskAction(task.id);
    setBusy(false);
    if (result.error) {
      setDone(false);
      setError(result.error);
      return;
    }
    router.refresh();
  }

  async function assign(ownerId: string) {
    setBusy(true);
    setError(null);
    const result = await assignTaskAction(task.id, ownerId);
    setBusy(false);
    if (result.error) setError(result.error);
    else router.refresh();
  }

  async function untag(person: string) {
    setRemoved((current) => [...current, person]);
    setError(null);
    const result = await untagTaskAction(task.id, person);
    if (result.error) {
      setRemoved((current) => current.filter((item) => item !== person));
      setError(result.error);
      return;
    }
    if (person === viewer.id && !canChange) onClose();
    router.refresh();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "d" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable='true'], [role='combobox'], [role='listbox']")) return;
    if (!canChange || done) return;
    event.preventDefault();
    void complete();
  }

  const created = [
    creator ? `Created by ${firstName(creator.name)}` : task.createdByAgentId ? "Created by an agent" : null,
    formatIn({ day: "numeric", month: "short" }, task.createdAt),
  ]
    .filter(Boolean)
    .join(" · ");
  const linked = Boolean(task.companyId || task.contactId || task.opportunityId || description.links.length > 0);
  const thread = discussion.threadId;

  return (
    <SheetContent
      side="right"
      aria-label="Task"
      className="w-full md:w-[520px] md:max-w-[520px]"
      onEscapeKeyDown={(event) => {
        if (holdEscape(discussion)) event.preventDefault();
      }}
    >
      <DiscussionProvider discussion={discussion}>
        <div onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col">
          <SheetHeader className="max-md:h-auto max-md:min-h-14 max-md:px-3.5 max-md:pt-[env(safe-area-inset-top)]">
            <div className="flex min-w-0 items-baseline gap-2">
              <SheetTitle>Task</SheetTitle>
              <span className="caption-style text-subtle truncate">{created}</span>
            </div>
            <SheetDescription className="sr-only">{task.title}</SheetDescription>
            <SheetCloseButton label="Close" className="max-md:size-11" />
          </SheetHeader>
          <div data-chat-room-pane className="min-h-0 flex-1 overflow-y-auto px-5 pt-5 pb-6 max-md:px-3.5">
            {thread ? (
              <div className="flex flex-col gap-3">
                <DiscussionThread discussion={discussion} backLabel="Task" />
                <DiscussionComposer discussion={discussion} parentId={thread} autoFocus onEscape={discussion.context.closeThread} />
                <DiscussionNotice discussion={discussion} />
              </div>
            ) : (
              <div className="flex flex-col gap-5">
                <div className="flex items-start gap-2.5">
                  <span
                    aria-hidden
                    className={cn("mt-px flex size-5 shrink-0 items-center justify-center rounded-full", done ? "bg-success text-white" : "border-line-strong border")}
                  >
                    {done && (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M5 12.5 10 17.5 19 7.5" />
                      </svg>
                    )}
                  </span>
                  {readOnly ? (
                    <h2 className="min-w-0 flex-1 leading-[1.3] break-words">{task.title}</h2>
                  ) : (
                    <textarea
                      ref={titleField}
                      id={`${id}-title`}
                      aria-label="Title"
                      rows={1}
                      value={title}
                      maxLength={500}
                      onChange={(event) => setTitle(event.target.value.replace(/\n/g, " "))}
                      onBlur={saveTitle}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                          event.preventDefault();
                          event.currentTarget.blur();
                        }
                      }}
                      className="h2-style min-w-0 flex-1 resize-none overflow-hidden bg-transparent leading-[1.3] outline-none"
                    />
                  )}
                </div>
                {readOnly && isTagged && (
                  <p role="note" className="caption-style text-soft flex items-start gap-2 rounded-xl bg-white/[0.04] px-3 py-2.5">
                    <UsersIcon aria-hidden className="mt-px size-3.5 shrink-0 text-(--tag-blue-text)" />
                    <span>
                      You&apos;re tagged. You can read and discuss this task.{" "}
                      {changersLine([firstName(owner?.name), firstName(creator?.name)].filter((name) => name && name !== firstName(viewer.name)))}
                    </span>
                  </p>
                )}
                <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 max-md:grid-cols-[5.5rem_minmax(0,1fr)]">
                  <Field label="Assignee">
                    {team && canChange ? (
                      <AssigneePicker
                        members={members}
                        value={task.ownerId}
                        viewerId={viewer.id}
                        tagged={people}
                        onPick={(ownerId) => void assign(ownerId)}
                        label={`Assignee: ${owner?.name ?? "No one"}. Change`}
                        disabled={busy}
                        handOnNote
                        trigger={
                          <span className={cn("inline-flex items-center max-md:h-11", CHIP)}>
                            <MemberAvatar member={owner} viewerId={viewer.id} size="xs" />
                            <span className="truncate">{owner?.name ?? "No one"}</span>
                          </span>
                        }
                      />
                    ) : (
                      <span className="ui-style flex min-w-0 items-center gap-2">
                        {owner && <MemberAvatar member={owner} viewerId={viewer.id} size="xs" />}
                        <span className="truncate">{owner?.name ?? "No one"}</span>
                      </span>
                    )}
                  </Field>
                  <Field label="Due">
                    {canChange ? (
                      <>
                        <DateTimePicker
                          id={`${id}-due`}
                          aria-label="Due date"
                          placeholder="No due date"
                          value={due}
                          onChange={(value) => {
                            setDue(value);
                            if (!value) setReminder(null);
                            void save(value ? { dueAt: value } : { dueAt: null, remindMinutes: null });
                          }}
                          className={cn(CHIP, "max-md:h-11 [&_svg]:size-3.5", !due && "text-subtle")}
                        />
                        {due && (
                          <ReminderSelect
                            id={`${id}-reminder`}
                            value={reminder === null ? "none" : String(reminder)}
                            onChange={(value) => {
                              const minutes = value === "none" ? null : Number(value);
                              setReminder(minutes);
                              void save({ remindMinutes: minutes });
                            }}
                            className={cn(CHIP, "max-md:h-11", reminder === null && "text-subtle")}
                          />
                        )}
                      </>
                    ) : (
                      <span className="ui-style text-soft">
                        {task.dueAt
                          ? [
                              formatIn(
                                {
                                  weekday: "short",
                                  day: "numeric",
                                  month: "short",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                  hourCycle: "h23",
                                },
                                task.dueAt,
                              ),
                              reminderLabel(task.remindMinutes)?.toLowerCase(),
                            ]
                              .filter(Boolean)
                              .join(" · reminder ")
                          : "No due date"}
                      </span>
                    )}
                  </Field>
                  {team && (
                    <Field label="Tagged">
                      {people.map((person) => {
                        const member = named(person) ?? {
                          id: person,
                          name: "Former member",
                        };
                        const removable = canRemoveTag(viewer, task, person);
                        return (
                          <span key={person} className={cn("inline-flex items-center", CHIP, removable && "pr-0.5")}>
                            <MemberAvatar member={member} viewerId={viewer.id} size="xs" />
                            <span className="truncate">{member.name}</span>
                            {removable && (
                              <Button
                                variant="ghost"
                                size="none"
                                aria-label={person === viewer.id ? "Remove yourself" : `Remove ${member.name}`}
                                title="Remove"
                                onClick={() => void untag(person)}
                                className="size-6 rounded-full max-md:-my-2 max-md:size-11"
                              >
                                <XIcon aria-hidden className="size-3" />
                              </Button>
                            )}
                          </span>
                        );
                      })}
                      <span className="caption-style text-subtle">Tag people with @ below.</span>
                    </Field>
                  )}
                </dl>
                <Section label="Description">
                  {canChange ? (
                    <Textarea
                      ref={textField}
                      aria-label="Description"
                      value={text}
                      placeholder="Add a description"
                      onChange={(event) => setText(event.target.value)}
                      onBlur={saveText}
                      className="min-h-16 resize-none overflow-hidden"
                    />
                  ) : (
                    <p className="text-soft whitespace-pre-wrap">{description.text || "No description"}</p>
                  )}
                </Section>
                {linked && (
                  <Section label="Linked">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {task.companyId && task.companyName && <EntityChip name={task.companyName} href={companyHref(task.companyId)} />}
                      {task.contactId && task.contactName && <EntityChip name={task.contactName} href={contactHref(task.contactId)} />}
                      {task.opportunityId && task.opportunityName && <EntityChip name={task.opportunityName} href={recordHref("opportunity", task.opportunityId)} />}
                      {description.links.map((link, index) => (
                        <Link
                          key={`${index}:${link.href}`}
                          href={link.href}
                          className="bg-secondary text-foreground inline-flex max-w-full items-center gap-1.5 rounded-full py-px pr-2 pl-1.5 text-[12px] leading-5"
                        >
                          <MailIcon aria-hidden className="size-3 shrink-0" />
                          <span className="truncate">{link.label}</span>
                        </Link>
                      ))}
                    </div>
                  </Section>
                )}
                {(task.priority !== "normal" || task.clickupError) && (
                  <div className="caption-style text-subtle flex flex-col gap-1">
                    {task.priority !== "normal" && <p>Priority {task.priority}</p>}
                    {task.clickupError && <p className="text-danger">ClickUp: {task.clickupError}</p>}
                  </div>
                )}
                <RecordNotes compact record={{ kind: "task", id: task.id, name: task.title }} />
                <Section label="Discussion" count={discussion.count}>
                  <DiscussionMessages discussion={discussion} />
                  <DiscussionComposer discussion={discussion} />
                  <DiscussionNotice discussion={discussion} />
                  {team && <p className="caption-style text-subtle">Tagging someone gives them access to this task and its discussion.</p>}
                </Section>
              </div>
            )}
          </div>
          {error && (
            <p role="alert" className="caption-style text-danger border-line-strong border-t px-5 py-2 max-md:px-3.5">
              {error}
            </p>
          )}
          <SheetFooter className="max-md:px-3.5">
            <span className="caption-style text-subtle min-w-0 truncate">{task.companyName ?? ""}</span>
            {canChange && (
              <Button variant="secondary" size="md" disabled={done || busy} onClick={() => void complete()} shortcut={done ? undefined : ["D"]} className="max-md:h-11">
                {done ? "Done" : "Mark done"}
              </Button>
            )}
          </SheetFooter>
        </div>
      </DiscussionProvider>
    </SheetContent>
  );
}

export default function TaskPanel({
  task,
  open,
  onOpenChange,
  ...rest
}: Omit<PanelProps, "onClose" | "task"> & {
  task: Task | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open && Boolean(task)} onOpenChange={onOpenChange}>
      {task && <TaskPanelBody key={task.id} task={task} onClose={() => onOpenChange(false)} {...rest} />}
    </Sheet>
  );
}
