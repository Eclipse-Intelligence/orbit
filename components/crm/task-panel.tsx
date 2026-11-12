"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode, type SVGProps } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { DateTimePicker } from "@/components/_ui/date-picker";
import { Sheet, SheetCloseButton, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/_ui/sheet";
import { Input } from "@/components/_ui/input";
import { Textarea } from "@/components/_ui/textarea";
import { searchCompaniesAction } from "@/app/(crm)/actions";
import { searchContactsToFileAction } from "@/app/(crm)/search";
import { Monogram } from "@/components/beautifui/record-marks";
import { DiscussionComposer, DiscussionMessages, DiscussionNotice, DiscussionProvider, DiscussionThread, holdEscape } from "@/components/chat/discussion";
import { useDiscussion } from "@/components/chat/use-discussion";
import { useKeyboardFit } from "@/components/chat/use-keyboard-fit";
import AssigneePicker, { MemberAvatar, type AssignableMember } from "@/components/crm/assignee-picker";
import ReminderSelect from "@/components/crm/reminder-select";
import type { Viewer } from "@/components/crm/viewer";
import RecordNotes from "@/components/docs/record-notes";
import { assignTaskAction, completeTaskAction, linkTaskAction, taskLinkCandidatesAction } from "@/app/(crm)/records";
import TaskTitle, { ColleagueLink } from "@/components/crm/task-title";
import type { LinkCandidate } from "@/lib/crm/task-links";
import { saveTaskDetailsAction, untagTaskAction, type TaskDetails } from "@/app/(crm)/discussions";
import { companyHref, contactHref } from "@/lib/crm/hrefs";
import { reminderLabel } from "@/lib/crm/reminder-options";
import { replaceDescriptionText, splitDescription } from "@/lib/crm/task-description";
import type { Task } from "@/lib/crm/types";
import { recordHref } from "@/lib/docs/routes";
import { appTimeZone, dateTimeInputValue } from "@/lib/time";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import LinkIcon from "@/public/assets/images/settings/link.svg";
import ChatIcon from "@/public/assets/images/chat/chat.svg";
import CheckIcon from "@/public/assets/images/assistant/check.svg";
import ContactIcon from "@/public/assets/images/companies/sidebar/book-closed.svg";
import OpportunityIcon from "@/public/assets/images/companies/sidebar/clipboard.svg";
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

const LINK_CHIP = "bg-secondary text-foreground inline-flex max-w-full items-center gap-1.5 rounded-full py-px pr-2 pl-1.5 text-[12px] leading-5 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-3";

function LinkChip({ href, label, icon: Icon, mark }: { href: string; label: string; icon?: ComponentType<SVGProps<SVGSVGElement>>; mark?: ReactNode }) {
  return (
    <Link href={href} className={LINK_CHIP}>
      {mark ?? (Icon && <Icon aria-hidden className="text-subtle size-3 shrink-0" />)}
      <span className="truncate">{label}</span>
    </Link>
  );
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
  admins?: string[];
  onClose: () => void;
};

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
        className="[@media(pointer:coarse)]:h-11"
      >
        {busy === candidate.id ? "Linking…" : "Link"}
      </Button>
    </div>
  );
}

function LinkPerson({ taskId, title, onLinked }: { taskId: string; title: string; onLinked: () => void }) {
  const searchId = useId();
  const [found, setFound] = useState<{ candidates: LinkCandidate[]; reason: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ query: string; items: LinkCandidate[] } | null>(null);

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
      void Promise.all([searchContactsToFileAction(text), searchCompaniesAction(text)])
        .then(([people, companies]) => {
          if (cancelled) return;
          setResults({
            query: text,
            items: [
              ...people.contacts.slice(0, 6).map((person) => ({
                kind: "contact" as const,
                id: person.id,
                name: person.name,
                detail: [person.jobTitle, person.companyName].filter(Boolean).join(" · ") || null,
              })),
              ...companies.slice(0, 4).map((company) => ({ kind: "company" as const, id: company.id, name: company.name, detail: company.domain })),
            ],
          });
        })
        .catch(() => !cancelled && setError("Couldn't search. Try again."));
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

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
  const searched = results && results.query === query.trim() ? results.items : null;
  return (
    <section aria-label={heading} className="flex flex-col gap-1 rounded-xl bg-white/[0.04] p-2.5">
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

function TaskPanelBody({ task, viewer, members, tagged, admins = [], onClose }: PanelProps) {
  const router = useRouter();
  const id = useId();
  const discussion = useDiscussion(
    "task",
    task.id,
    { id: viewer.id, name: viewer.name },
    {
      onSent: (message) => {
        if (message.mentions.length > 0) router.refresh();
      },
    },
  );
  const canChange = canChangeTaskAs(viewer, task);
  const team = members.length > 1;
  const named = (person: string | null) => (person ? (members.find((member) => member.id === person) ?? null) : null);
  const owner = named(task.ownerId) ?? (task.ownerId ? { id: task.ownerId, name: task.ownerName ?? "Former member" } : null);
  const creator = named(task.createdByUserId);
  const description = splitDescription(task.description);
  const [title, setTitle] = useState(task.title);
  const [editingTitle, setEditingTitle] = useState<number | null>(null);
  const [text, setText] = useState(description.text);
  const [due, setDue] = useState(dateTimeInputValue(task.dueAt));
  const [reminder, setReminder] = useState<number | null>(task.remindMinutes);
  const [done, setDone] = useState(Boolean(task.completedAt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removed, setRemoved] = useState<string[]>([]);
  const taggedKey = tagged.join(",");
  const [seenTagged, setSeenTagged] = useState(taggedKey);
  if (seenTagged !== taggedKey) {
    setSeenTagged(taggedKey);
    setRemoved((current) => current.filter((person) => !tagged.includes(person)));
  }
  const people = tagged.filter((person) => person !== task.ownerId && !removed.includes(person));
  const isTagged = tagged.includes(viewer.id);
  const readOnly = !canChange;
  const titleField = useAutoSize(title);
  const textField = useAutoSize(text);
  const saved = useRef({ title: task.title, text: description.text });
  const [sheet, setSheet] = useState<HTMLDivElement | null>(null);
  const sheetRef = useMemo(() => ({ current: sheet }), [sheet]);
  useKeyboardFit(sheetRef, Boolean(sheet));

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
      return false;
    }
    router.refresh();
    return true;
  }

  function saveTitle() {
    const next = title.trim();
    if (!next) {
      setTitle(saved.current.title);
      return;
    }
    const previous = saved.current.title;
    if (next === previous) return;
    saved.current.title = next;
    void save({ title: next }).then((ok) => {
      if (!ok && saved.current.title === next) saved.current.title = previous;
    });
  }

  function saveText() {
    const next = text.trim();
    const previous = saved.current.text;
    if (next === previous) return;
    saved.current.text = next;
    void save({ description: replaceDescriptionText(task.description, next) }).then((ok) => {
      if (!ok && saved.current.text === next) saved.current.text = previous;
    });
  }

  function flush() {
    if (!canChange) return;
    saveTitle();
    saveText();
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
    if (!event.currentTarget.contains(target)) return;
    if (target.closest("input, textarea, select, [contenteditable='true'], [role='combobox'], [role='listbox'], [role='menu']")) return;
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
  const dueLabel = task.dueAt ? formatIn({ weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, task.dueAt) : null;
  const changers = [owner, creator].flatMap((person) => (person && person.id !== viewer.id && !admins.includes(person.id) ? [firstName(person.name)] : []));
  const linked = Boolean(task.companyId || task.contactId || task.opportunityId || description.links.length > 0);
  const unlinked = !task.companyId && !task.contactId && !task.opportunityId;
  const colleagues = members.map((member) => ({ id: member.id, name: member.name }));
  const colleague = (person: { id: string; name: string } | null) =>
    person && person.id !== viewer.id && members.some((member) => member.id === person.id) ? person : null;
  const thread = discussion.threadId;

  return (
    <SheetContent
      ref={setSheet}
      side="right"
      aria-label="Task"
      className="w-full data-[keyboard]:pb-0 md:w-[520px] md:max-w-[520px]"
      onKeyDown={onKeyDown}
      onEscapeKeyDown={(event) => {
        if (holdEscape(discussion)) {
          event.preventDefault();
          return;
        }
        flush();
      }}
      onPointerDownOutside={flush}
      onCloseAutoFocus={flush}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        (event.target as HTMLElement | null)?.focus?.({ preventScroll: true });
      }}
    >
      <DiscussionProvider discussion={discussion}>
        <div className="flex min-h-0 flex-1 flex-col">
          <SheetHeader className="max-md:h-auto max-md:min-h-14 max-md:px-3.5 max-md:pt-[env(safe-area-inset-top)]">
            <div className="flex min-w-0 items-baseline gap-2">
              <SheetTitle>Task</SheetTitle>
              <span className="caption-style text-subtle truncate">{created}</span>
            </div>
            <SheetDescription className="sr-only">{task.title}</SheetDescription>
            <SheetCloseButton label="Close" className="[@media(pointer:coarse)]:size-11" />
          </SheetHeader>
          <div data-chat-room-pane className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-5 pb-4 max-md:px-3.5">
              {thread ? (
                <DiscussionThread discussion={discussion} backLabel="Task" />
              ) : (
                <div className="flex flex-col gap-5">
                  <div className="flex items-start gap-2.5">
                    <span aria-hidden className={cn("mt-px flex size-5 shrink-0 items-center justify-center rounded-full", done ? "bg-success text-white" : "border-line-strong border")}>
                      {done && <CheckIcon className="size-3" />}
                    </span>
                    {readOnly ? (
                      <h2 className="min-w-0 flex-1 leading-[1.3] break-words">
                        <TaskTitle task={task} colleagues={colleagues} viewerId={viewer.id} />
                      </h2>
                    ) : editingTitle === null ? (
                      <div className="relative min-w-0 flex-1">
                        <button
                          type="button"
                          aria-label="Edit title"
                          onClick={() => setEditingTitle(title.length)}
                          className="pointer-events-none absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-(--primary)"
                        />
                        <h2 onClick={(event) => setEditingTitle(caretAt(event.currentTarget, event.clientX, event.clientY) ?? title.length)} className="relative cursor-text leading-[1.3] break-words">
                          <TaskTitle task={{ ...task, title }} colleagues={colleagues} viewerId={viewer.id} />
                        </h2>
                      </div>
                    ) : (
                      <Textarea
                        ref={titleField}
                        id={`${id}-title`}
                        aria-label="Title"
                        rows={1}
                        value={title}
                        maxLength={200}
                        autoFocus
                        onFocus={(event) => event.currentTarget.setSelectionRange(editingTitle, editingTitle)}
                        onChange={(event) => setTitle(event.target.value.replace(/\n/g, " "))}
                        onBlur={() => {
                          saveTitle();
                          setEditingTitle(null);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            event.currentTarget.blur();
                          }
                        }}
                        className="h2-style min-h-0 min-w-0 flex-1 resize-none overflow-hidden rounded-none border-0 bg-transparent p-0 leading-[1.3] shadow-none focus-visible:ring-0"
                      />
                    )}
                  </div>
                  {unlinked && canChange && !done && <LinkPerson taskId={task.id} title={task.title} onLinked={() => router.refresh()} />}
                  {readOnly && isTagged && (
                    <p role="note" className="caption-style text-soft flex items-start gap-2 rounded-xl bg-white/[0.04] px-3 py-2.5">
                      <UsersIcon aria-hidden className="mt-px size-3.5 shrink-0 text-(--tag-blue-text)" />
                      <span>You&apos;re tagged. You can read and discuss this task. {changersLine(changers)}</span>
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
                            <span className={cn("inline-flex items-center [@media(pointer:coarse)]:h-11", CHIP)}>
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
                      {colleague(owner) && (
                        <ColleagueLink colleague={colleague(owner)!} className="text-subtle hover:text-foreground inline-flex size-7 items-center justify-center rounded-full no-underline hover:bg-white/10 [@media(pointer:coarse)]:size-11">
                          <ChatIcon aria-hidden className="size-3.5" />
                        </ColleagueLink>
                      )}
                    </Field>
                    <Field label="Due">
                      {canChange ? (
                        <>
                          <DateTimePicker
                            id={`${id}-due`}
                            aria-label={due && dueLabel ? `Due ${dueLabel}. Change` : "Due date"}
                            placeholder="No due date"
                            value={due}
                            onChange={(value) => {
                              setDue(value);
                              if (!value) setReminder(null);
                              void save(value ? { dueAt: value } : { dueAt: null, remindMinutes: null });
                            }}
                            className={cn(CHIP, "[@media(pointer:coarse)]:h-11 [&_svg]:size-3.5", !due && "text-subtle")}
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
                              className={cn(CHIP, "[@media(pointer:coarse)]:h-11", reminder === null && "text-subtle")}
                            />
                          )}
                        </>
                      ) : (
                        <span className="ui-style text-soft">{dueLabel ? [dueLabel, reminderLabel(task.remindMinutes)?.toLowerCase()].filter(Boolean).join(" · reminder ") : "No due date"}</span>
                      )}
                    </Field>
                    {team && (
                      <Field label="Tagged">
                        {people.map((person) => {
                          const member = named(person) ?? { id: person, name: "Former member" };
                          const removable = canRemoveTag(viewer, task, person);
                          return (
                            <span key={person} className={cn("inline-flex items-center [@media(pointer:coarse)]:h-11", CHIP, removable && "pr-0.5")}>
                              <MemberAvatar member={member} viewerId={viewer.id} size="xs" />
                              {colleague(member) ? (
                                <ColleagueLink colleague={member} className="truncate no-underline hover:underline" />
                              ) : (
                                <span className="truncate">{member.name}</span>
                              )}
                              {removable && (
                                <Button
                                  variant="ghost"
                                  size="none"
                                  aria-label={person === viewer.id ? "Remove yourself" : `Remove ${member.name}`}
                                  title="Remove"
                                  onClick={() => void untag(person)}
                                  className="size-6 rounded-full [@media(pointer:coarse)]:size-11"
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
                        {task.companyId && task.companyName && (
                          <LinkChip href={companyHref(task.companyId)} label={task.companyName} mark={<Monogram name={task.companyName} className="size-4 rounded-full text-[9px]" />} />
                        )}
                        {task.contactId && task.contactName && <LinkChip href={contactHref(task.contactId)} label={task.contactName} icon={ContactIcon} />}
                        {task.opportunityId && task.opportunityName && (
                          <LinkChip href={recordHref("opportunity", task.opportunityId)} label={task.opportunityName} icon={OpportunityIcon} />
                        )}
                        {description.links.map((link, index) => (
                          <LinkChip key={`${index}:${link.href}`} href={link.href} label={link.label} icon={MailIcon} />
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
                  </Section>
                </div>
              )}
            </div>
            <div className="border-line-strong flex shrink-0 flex-col gap-1.5 border-t px-4 pt-3 pb-3 max-md:px-2 max-md:pb-2">
              <DiscussionNotice discussion={discussion} />
              {thread ? (
                <DiscussionComposer key={thread} discussion={discussion} parentId={thread} autoFocus onEscape={discussion.context.closeThread} />
              ) : (
                <DiscussionComposer discussion={discussion} />
              )}
              {team && !thread && <p className="caption-style text-subtle px-1">Tagging someone gives them access to this task and its discussion.</p>}
            </div>
          </div>
          {error && (
            <p role="alert" className="caption-style text-danger border-line-strong border-t px-5 py-2 max-md:px-3.5">
              {error}
            </p>
          )}
          {canChange && (
            <SheetFooter className="max-md:px-3.5">
              <span className="caption-style text-subtle min-w-0 truncate">{task.companyName ?? ""}</span>
              <Button variant="secondary" size="md" disabled={done || busy} onClick={() => void complete()} shortcut={done ? undefined : ["D"]} className="[@media(pointer:coarse)]:h-11">
                {done ? "Done" : "Mark done"}
              </Button>
            </SheetFooter>
          )}
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
