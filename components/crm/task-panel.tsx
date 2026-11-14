"use client";

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Sheet, SheetCloseButton, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/_ui/sheet";
import { DiscussionComposer, DiscussionMessages, DiscussionNotice, DiscussionProvider, DiscussionThread, holdEscape } from "@/components/chat/discussion";
import { useDiscussion } from "@/components/chat/use-discussion";
import { useKeyboardFit } from "@/components/chat/use-keyboard-fit";
import type { AssignableMember } from "@/components/crm/assignee-picker";
import { activateRow } from "@/components/shortcuts/keyboard-list";
import { TaskAct } from "@/components/crm/task-actions";
import TaskAskButton from "@/components/crm/task-ask";
import { TaskPrepare } from "@/components/crm/task-prepare";
import { TaskWorkspace } from "@/components/crm/task-workspace";
import TaskOutcomeForm, { type OutcomeHandlers } from "@/components/crm/task-outcome";
import TaskFields, { canChangeTaskAs, changersLine, firstName, formatTaskWhen, TaskSection, TaskTitleField, useTaskDetails } from "@/components/crm/task-fields";
import type { Viewer } from "@/components/crm/viewer";
import RecordNotes from "@/components/docs/record-notes";
import { untagTaskAction } from "@/app/(crm)/discussions";
import type { Task } from "@/lib/crm/types";
import { cn } from "@/lib/utils";
import { usePageFocus } from "@/stores/page-context-store";
import CheckIcon from "@/public/assets/images/assistant/check.svg";
import UsersIcon from "@/public/assets/images/companies/sidebar/users.svg";

type PanelProps = {
  task: Task;
  viewer: Viewer;
  members: AssignableMember[];
  tagged: string[];
  admins?: string[];
  completed?: boolean;
  onComplete: (task: Task) => void;
  onReopen?: (task: Task) => void;
  onClose: () => void;
  outcome?: { focus: boolean; saving: boolean; outcomeId: string } | null;
  outcomeHandlers?: OutcomeHandlers;
  recordNotes?: boolean;
  returnTo?: HTMLElement | null;
};

export function TaskDoneCircle({ done, disabled, title, onClick, className }: { done: boolean; disabled: boolean; title: string; onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      disabled={done || disabled}
      onClick={onClick}
      aria-label={done ? "Done" : `Mark “${title}” done`}
      title={done ? "Done" : "Mark done"}
      className={cn(
        "group/done relative flex size-5 shrink-0 items-center justify-center rounded-full transition-colors duration-150 enabled:cursor-pointer disabled:cursor-default",
        "before:absolute before:-inset-3 before:content-[''] [@media(pointer:fine)]:before:-inset-1",
        done ? "bg-success text-white" : "border-line-strong text-subtle enabled:hover:bg-success border enabled:hover:border-transparent enabled:hover:text-white",
        className,
      )}
    >
      <CheckIcon aria-hidden className={cn("size-3", !done && "hidden group-enabled/done:group-hover/done:block")} />
    </button>
  );
}

const PANEL_IGNORED = new Set(["o", "j", "k", "1", "2", "3", "4", "5", "6"]);
const FIELD = "input, textarea, select, [contenteditable='true'], [role='combobox'], [role='listbox'], [role='menu']";

function shown(element: HTMLElement) {
  return element.isConnected && element.getClientRects().length > 0;
}

function focusRow(row: HTMLElement) {
  if (row.hasAttribute("data-list-row")) {
    activateRow(row);
    return;
  }
  if (row instanceof HTMLButtonElement) {
    row.focus({ preventScroll: true });
    return;
  }
  row.querySelector<HTMLElement>("button[aria-expanded]")?.focus({ preventScroll: true });
}

function returnFocus(id: string, returnTo: HTMLElement | null, opener: HTMLElement | null) {
  if (returnTo && shown(returnTo)) {
    focusRow(returnTo);
    return;
  }
  if (opener && opener.matches(`[data-task-id="${id}"]`) && shown(opener)) {
    focusRow(opener);
    return;
  }
  const row = [...document.querySelectorAll<HTMLElement>(`[data-task-id="${id}"]`)].find(shown);
  if (row) {
    focusRow(row);
    return;
  }
  document.querySelector<HTMLElement>("[data-calendar-scroller]")?.focus({ preventScroll: true });
}

function focusedElement() {
  if (typeof document === "undefined") return null;
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

function TaskPanelBody({ task, viewer, members, tagged, admins = [], completed = false, onComplete, onReopen, onClose, instant, modal, outcome = null, outcomeHandlers, recordNotes = true, returnTo = null }: PanelProps & { instant: boolean; modal: boolean }) {
  const router = useRouter();
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
  const details = useTaskDetails(task, canChange, true, viewer.id);
  const team = members.length > 1;
  const named = (person: string | null) => (person ? (members.find((member) => member.id === person) ?? null) : null);
  const owner = named(task.ownerId) ?? (task.ownerId ? { id: task.ownerId, name: task.ownerName ?? "Former member" } : null);
  const creator = named(task.createdByUserId);
  const [opener] = useState(focusedElement);
  const asking = useRef(false);
  const done = completed || Boolean(task.completedAt);
  const [removed, setRemoved] = useState<string[]>([]);
  const taggedKey = tagged.join(",");
  const [seenTagged, setSeenTagged] = useState(taggedKey);
  if (seenTagged !== taggedKey) {
    setSeenTagged(taggedKey);
    setRemoved((current) => current.filter((person) => !tagged.includes(person)));
  }
  const isTagged = tagged.includes(viewer.id);
  const readOnly = !canChange;
  const [sheet, setSheet] = useState<HTMLDivElement | null>(null);
  const sheetRef = useMemo(() => ({ current: sheet }), [sheet]);
  useKeyboardFit(sheetRef, Boolean(sheet));
  const { error, setError } = details;

  function flush() {
    details.flush();
  }

  function complete() {
    if (done || !canChange) return;
    onComplete(task);
  }

  async function untag(person: string) {
    setRemoved((current) => [...current, person]);
    setError(null);
    const result = await untagTaskAction(task.id, person).catch(() => ({ error: "Couldn't remove them. Try again." }));
    if (result.error) {
      setRemoved((current) => current.filter((item) => item !== person));
      setError(result.error);
      return;
    }
    if (person === viewer.id && !canChange) onClose();
    router.refresh();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    if (!event.currentTarget.contains(target) || target.closest(FIELD)) return;
    const key = event.key.toLowerCase();
    if (PANEL_IGNORED.has(key)) {
      event.preventDefault();
      return;
    }
    if (key !== "d" && key !== "e") return;
    event.preventDefault();
    if (!canChange || done) return;
    complete();
  }

  const created = [
    creator ? `Created by ${firstName(creator.name)}` : task.createdByAgentId ? "Created by an agent" : null,
    formatTaskWhen({ day: "numeric", month: "short" }, task.createdAt),
  ]
    .filter(Boolean)
    .join(" · ");
  const changers = [owner, creator].flatMap((person) => (person && person.id !== viewer.id && !admins.includes(person.id) ? [firstName(person.name)] : []));
  const colleagues = members.map((member) => ({ id: member.id, name: member.name }));
  const thread = discussion.threadId;

  return (
    <SheetContent
      ref={setSheet}
      side="right"
      aria-label="Task"
      className={cn("w-full data-[keyboard]:pb-0 md:w-[min(640px,85vw)] md:max-w-[640px] xl:w-[480px]", instant && "data-[state=open]:animate-none")}
      onKeyDown={onKeyDown}
      onEscapeKeyDown={(event) => {
        if (event.isComposing) {
          event.preventDefault();
          return;
        }
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && !sheet?.contains(focused) && focused.closest(FIELD)) {
          event.preventDefault();
          focused.blur();
          return;
        }
        if (holdEscape(discussion)) {
          event.preventDefault();
          return;
        }
        flush();
      }}
      onPointerDownOutside={flush}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        flush();
        if (asking.current) {
          asking.current = false;
          return;
        }
        returnFocus(task.id, returnTo, opener);
      }}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        const lost = !document.activeElement || document.activeElement === document.body;
        if (instant && !lost) return;
        const content = event.target as HTMLElement | null;
        const first = content?.querySelector<HTMLElement>('button[aria-label="Edit title"], textarea, input');
        (first ?? content)?.focus?.({ preventScroll: true });
      }}
    >
      <TaskWorkspace.Provider value={task.workspaceId}>
      <DiscussionProvider discussion={discussion}>
        <div className="flex min-h-0 flex-1 flex-col">
          <SheetHeader className="max-md:h-auto max-md:min-h-14 max-md:px-3.5 max-md:pt-[env(safe-area-inset-top)]">
            <div className="flex min-w-0 items-baseline gap-2">
              <SheetTitle>Task</SheetTitle>
              <span className="caption-style text-subtle truncate">{created}</span>
            </div>
            <SheetDescription className="sr-only">{task.title}</SheetDescription>
            <div className="flex shrink-0 items-center gap-2 [@media(pointer:coarse)]:gap-3">
              <TaskAskButton
                taskId={task.id}
                variant="secondary"
                onAsk={
                  modal
                    ? () => {
                        asking.current = true;
                        flush();
                        onClose();
                      }
                    : undefined
                }
              />
              <SheetCloseButton label="Close" className="hit" />
            </div>
          </SheetHeader>
          <div data-chat-room-pane className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-5 pb-4 max-md:px-3.5">
              {thread ? (
                <DiscussionThread discussion={discussion} backLabel="Task" />
              ) : (
                <div className="flex flex-col gap-5">
                  <div className="flex items-start gap-2.5">
                    <span className="mt-px flex">
                      <TaskDoneCircle done={done} disabled={!canChange} title={task.title} onClick={complete} />
                    </span>
                    <TaskTitleField details={details} colleagues={colleagues} viewerId={viewer.id} />
                  </div>
                  {done && canChange && onReopen && (
                    <div className="flex">
                      <Button variant="secondary" size="sm" onClick={() => onReopen(task)} className="hit">
                        Reopen
                      </Button>
                    </div>
                  )}
                  {outcome && outcomeHandlers ? (
                    <TaskOutcomeForm
                      key={outcome.outcomeId}
                      task={task}
                      outcomeId={outcome.outcomeId}
                      focusNote={outcome.focus}
                      keyboard={false}
                      saving={outcome.saving}
                      onSkip={() => outcomeHandlers.skip(task)}
                      onSave={() => outcomeHandlers.save(task)}
                      onLeave={() => outcomeHandlers.leave(task)}
                    />
                  ) : (
                    <>
                      <TaskAct task={task} canChange={canChange} />
                      <TaskPrepare task={task}>{(prepare) => (prepare ? <div className="flex">{prepare}</div> : null)}</TaskPrepare>
                    </>
                  )}
                  <TaskFields
                    details={details}
                    viewer={viewer}
                    members={members}
                    tagged={tagged}
                    layout="panel"
                    done={done}
                    tagging={{ removed, remove: (person) => void untag(person) }}
                    extra={
                      readOnly && isTagged ? (
                        <p role="note" className="caption-style text-soft flex items-start gap-2 rounded-xl bg-white/[0.04] px-3 py-2.5">
                          <UsersIcon aria-hidden className="mt-px size-3.5 shrink-0 text-(--tag-blue-text)" />
                          <span>You&apos;re tagged. You can read and discuss this task. {changersLine(changers)}</span>
                        </p>
                      ) : null
                    }
                  />
                  {(task.priority !== "normal" || task.clickupError) && (
                    <div className="caption-style text-subtle flex flex-col gap-1">
                      {task.priority !== "normal" && <p>Priority {task.priority}</p>}
                      {task.clickupError && <p className="text-danger">ClickUp: {task.clickupError}</p>}
                    </div>
                  )}
                  {recordNotes && <RecordNotes compact record={{ kind: "task", id: task.id, name: task.title }} />}
                  <TaskSection label="Discussion" count={discussion.count}>
                    <DiscussionMessages discussion={discussion} />
                  </TaskSection>
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
        </div>
      </DiscussionProvider>
      </TaskWorkspace.Provider>
    </SheetContent>
  );
}

export default function TaskPanel({
  task,
  open,
  onOpenChange,
  modal = true,
  ...rest
}: Omit<PanelProps, "onClose" | "task"> & {
  task: Task | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  modal?: boolean;
}) {
  const shown = open && task ? task.id : null;
  usePageFocus("task", task?.id ?? "", Boolean(shown));
  const [last, setLast] = useState<string | null>(shown);
  const [instant, setInstant] = useState(false);
  if (last !== shown) {
    setLast(shown);
    setInstant(Boolean(last && shown));
  }
  return (
    <Sheet open={open && Boolean(task)} onOpenChange={onOpenChange} modal={modal}>
      {task && <TaskPanelBody key={task.id} task={task} instant={instant} modal={modal} onClose={() => onOpenChange(false)} {...rest} />}
    </Sheet>
  );
}
