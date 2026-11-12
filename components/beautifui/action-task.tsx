"use client";

import { memo, useEffect, useRef, useState, type ComponentType, type ReactNode, type SVGProps } from "react";
import Link from "next/link";
import Tag from "@/components/_ui/tag";
import { EntityChip } from "@/components/beautifui/record-marks";
import AssigneePicker, { MemberAvatar, type AssignableMember } from "@/components/crm/assignee-picker";
import { ClickUpBadge } from "@/components/crm/clickup";
import Button from "@/components/_ui/button";
import TaskFields, { canChangeTaskAs, TaskTitleField, useTaskDetails } from "@/components/crm/task-fields";
import TaskTitle from "@/components/crm/task-title";
import type { Viewer } from "@/components/crm/viewer";
import { swipeCommit, watchSwipe, type SwipeHandlers } from "@/components/mail/swipe";
import { relativeWhen } from "@/lib/companies";
import { companyHref, contactHref, dealHref } from "@/lib/crm/hrefs";
import { splitDescription } from "@/lib/crm/task-description";
import type { TitleColleague, TitleHere } from "@/lib/crm/task-title";
import { taskDueState } from "@/lib/crm/task-views";
import type { Task } from "@/lib/crm/types";
import { KEYBOARD_ROW_CLASS } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import CheckIcon from "@/public/assets/images/assistant/check.svg";
import ChatIcon from "@/public/assets/images/chat/chat.svg";
import ContactIcon from "@/public/assets/images/companies/sidebar/book-closed.svg";
import OpportunityIcon from "@/public/assets/images/companies/sidebar/clipboard.svg";
import ClockIcon from "@/public/assets/images/mail/clock.svg";
import LinkIcon from "@/public/assets/images/settings/link.svg";

const OUT_MS = 180;

type TaskAssigning = {
  members: AssignableMember[];
  viewerId: string;
  tagged: string[];
  canAssign: boolean;
  pending: boolean;
  onAssign: (ownerId: string) => void;
};

function Assignee({ task, assigning }: { task: Task; assigning: TaskAssigning }) {
  const member = assigning.members.find((item) => item.id === task.ownerId) ?? (task.ownerId ? { id: task.ownerId, name: task.ownerName ?? "Former member" } : null);
  const name = member?.name ?? "No one";
  if (!assigning.canAssign) {
    return (
      <span title={`Assigned to ${name}`} className="inline-flex shrink-0">
        <MemberAvatar member={member} viewerId={assigning.viewerId} />
        <span className="sr-only">Assigned to {name}</span>
      </span>
    );
  }
  return (
    <AssigneePicker
      members={assigning.members}
      value={task.ownerId}
      viewerId={assigning.viewerId}
      tagged={assigning.tagged}
      onPick={assigning.onAssign}
      label={`Assigned to ${name}. Reassign`}
      align="end"
      disabled={assigning.pending}
      handOnNote
      triggerClassName="min-h-11 min-w-11 justify-center @xl:min-h-0 @xl:min-w-0"
      trigger={<MemberAvatar member={member} viewerId={assigning.viewerId} className="hover:ring-line-strong hover:ring-2" />}
    />
  );
}

function RecordChip({ href, label, icon: Icon, className }: { href: string; label: string; icon: ComponentType<SVGProps<SVGSVGElement>>; className?: string }) {
  return (
    <Link
      href={href}
      title={label}
      className={cn("bg-secondary text-foreground inline-flex max-w-[12em] min-w-0 shrink items-center gap-1 rounded-full py-px pr-2 pl-1.5 align-middle text-[12px] leading-5 @xl:max-w-[10em] @6xl:max-w-[12em]", className)}
    >
      <Icon aria-hidden className="text-subtle size-3 shrink-0" />
      <span className="truncate">{label}</span>
    </Link>
  );
}

function DoneButton({ task, completed, overdue, onComplete }: { task: Task; completed: boolean; overdue: boolean; onComplete?: () => void }) {
  return (
    <button
      type="button"
      disabled={completed || !onComplete}
      onClick={onComplete}
      aria-label={completed ? "Done" : `Mark “${task.title}” done`}
      title={completed ? "Done" : "Mark done"}
      className={cn(
        "group/done relative flex size-6 shrink-0 items-center justify-center rounded-full text-white transition-colors duration-150 enabled:cursor-pointer disabled:cursor-default",
        "before:absolute before:-inset-2.5 before:content-[''] [@media(pointer:fine)]:before:-inset-1",
        completed
          ? "bg-success"
          : overdue
            ? "bg-danger enabled:hover:bg-success"
            : "bg-secondary text-subtle enabled:hover:bg-success enabled:hover:text-white",
      )}
    >
      {completed ? (
        <CheckIcon aria-hidden className="size-3" />
      ) : (
        <>
          <CheckIcon aria-hidden className="hidden size-3 group-enabled/done:group-hover/done:block" />
          <span className="group-enabled/done:group-hover/done:hidden">
            {overdue ? (
              <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                <path d="M6 6 18 18M18 6 6 18" />
              </svg>
            ) : (
              <span className="block size-1.5 rounded-full bg-current" />
            )}
          </span>
        </>
      )}
    </button>
  );
}

function useExpansion(expanded: boolean) {
  const [mounted, setMounted] = useState(expanded);
  if (expanded && !mounted) setMounted(true);
  const settle = () => {
    if (!expanded) setMounted(false);
  };
  return { mounted: mounted || expanded, settle };
}

const NONE: string[] = [];

function ActionTask({
  task,
  completed,
  dueBadge = false,
  now,
  viewer,
  members = NONE as unknown as AssignableMember[],
  tagged = NONE,
  expanded = false,
  onToggle,
  onComplete,
  onOpen,
  onRemind,
  canComplete = false,
  comments = 0,
  onAssign,
  canAssign = false,
  assignPending = false,
  colleagues = NONE as unknown as TitleColleague[],
  canLink = false,
  keyboard = false,
  here,
  actions,
}: {
  task: Task;
  completed: boolean;
  dueBadge?: boolean;
  now: number;
  viewer: Pick<Viewer, "id" | "role">;
  members?: AssignableMember[];
  tagged?: string[];
  expanded?: boolean;
  onToggle: (task: Task) => void;
  onComplete?: (task: Task) => void;
  onOpen: (task: Task) => void;
  onRemind?: (task: Task) => void;
  canComplete?: boolean;
  comments?: number;
  onAssign?: (task: Task, ownerId: string) => void;
  canAssign?: boolean;
  assignPending?: boolean;
  colleagues?: TitleColleague[];
  canLink?: boolean;
  keyboard?: boolean;
  here?: TitleHere;
  actions?: ReactNode;
}) {
  const complete = canComplete && onComplete ? () => onComplete(task) : undefined;
  const remind = canComplete && onRemind ? () => onRemind(task) : undefined;
  const open = () => onOpen(task);
  const assigning: TaskAssigning | undefined = onAssign
    ? { members, viewerId: viewer.id, tagged, canAssign, pending: assignPending, onAssign: (ownerId) => onAssign(task, ownerId) }
    : undefined;
  const overdue = Boolean(task.dueAt) && !task.completedAt && new Date(task.dueAt ?? 0).getTime() < now;
  const due = dueBadge ? taskDueState(task.dueAt, now) : null;
  const canChange = canChangeTaskAs(viewer, task);
  const details = useTaskDetails(task, canChange, expanded);
  const flushDetails = useRef(details.flush);
  const wasExpanded = useRef(expanded);
  useEffect(() => {
    flushDetails.current = details.flush;
  });
  useEffect(() => {
    if (wasExpanded.current && !expanded) flushDetails.current();
    wasExpanded.current = expanded;
  }, [expanded]);
  const preview = splitDescription(task.description).text.split("\n")[0]?.trim();
  const expansion = useExpansion(expanded);
  const row = useRef<HTMLLIElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [width, setWidth] = useState(360);
  const handlers = useRef<SwipeHandlers>({});
  const armedBefore = useRef(false);
  const timers = useRef<number[]>([]);
  const swiped = useRef<(() => void) | null>(null);
  const allowed = { left: Boolean(complete) && !completed, right: Boolean(remind) && !completed };
  const swipeable = !expanded && (allowed.left || allowed.right);
  const armed = offset !== 0 && swipeCommit(offset, 0, width, allowed) !== null;

  useEffect(() => {
    handlers.current = {
      canLeft: allowed.left && !expanded,
      canRight: allowed.right && !expanded,
      scroller: () => row.current?.closest<HTMLElement>(".overflow-auto, .overflow-y-auto") ?? null,
      width: () => row.current?.offsetWidth ?? window.innerWidth,
      onDrag: (dx) => {
        const rowWidth = row.current?.offsetWidth ?? 360;
        setWidth(rowWidth);
        setDragging(true);
        const nowArmed = swipeCommit(dx, 0, rowWidth, allowed) !== null;
        if (nowArmed && !armedBefore.current) navigator.vibrate?.(8);
        armedBefore.current = nowArmed;
        setOffset(dx);
      },
      onRelease: (commit) => {
        armedBefore.current = false;
        setDragging(false);
        if (commit === "left" && complete) {
          setOffset(-(row.current?.offsetWidth ?? width));
          swiped.current = complete;
          timers.current.push(
            window.setTimeout(() => {
              swiped.current = null;
              complete();
              setOffset(0);
            }, OUT_MS),
          );
          return;
        }
        setOffset(0);
        if (commit === "right") remind?.();
      },
    };
  });

  useEffect(() => {
    const element = body.current;
    const pending = timers.current;
    const stop = element && swipeable ? watchSwipe(element, () => handlers.current) : undefined;
    const leaving = swiped;
    return () => {
      stop?.();
      pending.forEach((timer) => window.clearTimeout(timer));
      const finish = leaving.current;
      leaving.current = null;
      finish?.();
    };
  }, [swipeable]);

  const toggle = () => {
    if (expanded) details.flush();
    onToggle(task);
    window.requestAnimationFrame(() => {
      if (keyboard && row.current && !row.current.contains(document.activeElement)) row.current.focus({ preventScroll: true });
    });
  };

  return (
    <li
      ref={row}
      data-list-row={keyboard ? "" : undefined}
      data-task-id={task.id}
      tabIndex={keyboard ? -1 : undefined}
      className={cn(keyboard && KEYBOARD_ROW_CLASS, "border-border @container relative overflow-hidden border-b", expanded && "bg-white/[0.025]")}
    >
      {offset !== 0 && (
        <span
          aria-hidden
          className={cn(
            "ease-power3-out absolute inset-0 flex items-center px-5 text-[13px] font-medium transition-colors duration-150",
            offset < 0 ? "justify-end" : "justify-start",
            !armed ? "text-soft bg-white/[0.06]" : offset < 0 ? "bg-[color-mix(in_srgb,var(--success)_78%,black)] text-white" : "bg-primary text-white",
          )}
        >
          <span className={cn("ease-power3-out flex items-center gap-2 transition-transform duration-150", armed ? "scale-100" : "scale-90", offset < 0 && "flex-row-reverse")}>
            {offset < 0 ? <CheckIcon className="size-[18px]" /> : <ClockIcon className="size-[18px]" />}
            {offset < 0 ? "Done" : "Remind me"}
          </span>
        </span>
      )}
      <div
        ref={body}
        className={cn("relative touch-pan-y", offset !== 0 && "bg-card", dragging ? "transition-none" : "ease-power3-out transition-transform duration-200")}
        style={offset ? { transform: `translateX(${offset}px)` } : undefined}
      >
        <div className={cn("flex items-start gap-2.5 px-2.5 py-2.5 @xl:min-h-11 @xl:py-1.5", expanded ? "@xl:items-start @xl:pt-3" : "@xl:items-center")}>
          <span className={cn("flex", expanded && "@xl:mt-px")}>
            <DoneButton task={task} completed={completed} overdue={overdue} onComplete={complete} />
          </span>
          {expanded ? (
            <div className="flex min-w-0 flex-1 items-start gap-2">
              <div className="flex min-w-0 flex-1 pt-0.5">
                <TaskTitleField details={details} colleagues={colleagues} viewerId={viewer.id} here={here} size="row" />
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Collapse"
                aria-expanded
                data-row-open={keyboard ? "" : undefined}
                data-row-key={keyboard ? "space" : undefined}
                onClick={toggle}
                className="-mt-0.5 max-sm:size-11"
              >
                <ChevronDownIcon aria-hidden className="size-3.5 rotate-180" />
              </Button>
            </div>
          ) : (
            <div className="flex min-w-0 flex-1 flex-col gap-1.5 @xl:flex-row @xl:items-center @xl:gap-2.5">
              <div className="relative flex min-h-11 min-w-0 flex-1 flex-col justify-center @xl:min-h-0">
                <button
                  type="button"
                  data-row-open={keyboard ? "" : undefined}
                  data-row-key={keyboard ? "space" : undefined}
                  aria-expanded={false}
                  aria-label={task.title}
                  onClick={toggle}
                  className="absolute inset-0 cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-(--primary)"
                />
                <span className="pointer-events-none relative min-w-0 text-[14px] leading-5 break-words @xl:min-w-[12em] @xl:truncate">
                  <TaskTitle task={task} colleagues={colleagues} viewerId={viewer.id} here={here} />
                </span>
                {preview && <span className="caption-style text-subtle pointer-events-none relative hidden truncate @xl:block">{preview}</span>}
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-1.5 @xl:max-w-[55%] @xl:shrink @xl:flex-nowrap @xl:justify-end">
                {comments > 0 && (
                  <span className="caption-style text-subtle flex shrink-0 items-center gap-1 tabular-nums" title={comments === 1 ? "1 comment" : `${comments} comments`}>
                    <ChatIcon aria-hidden className="size-3" />
                    {comments}
                    <span className="sr-only">{comments === 1 ? " comment" : " comments"}</span>
                  </span>
                )}
                {due ? (
                  <Tag size="sm" tone={due.kind === "overdue" ? "red" : due.kind === "today" ? "amber" : "neutral"} className="text-[12px]">
                    {due.label}
                  </Tag>
                ) : (
                  task.dueAt && <span className="text-subtle shrink-0 text-[13px]">{relativeWhen(task.dueAt, now)}</span>
                )}
                <ClickUpBadge task={task} />
                {task.contactId && task.contactName && here?.kind !== "contact" && (
                  <RecordChip href={contactHref(task.contactId)} label={task.contactName} icon={ContactIcon} className="@xl:@max-4xl:hidden" />
                )}
                {task.companyName && here?.kind !== "company" && <EntityChip name={task.companyName} href={task.companyId ? companyHref(task.companyId) : undefined} />}
                {task.opportunityId && task.opportunityName && here?.kind !== "opportunity" && (
                  <RecordChip href={dealHref(task.opportunityId)} label={task.opportunityName} icon={OpportunityIcon} className="@xl:@max-6xl:hidden" />
                )}
                {canLink && !completed && !task.companyId && !task.contactId && !task.opportunityId && (
                  <Button
                    variant="chip"
                    size="none"
                    onClick={toggle}
                    aria-expanded={false}
                    className="shrink-0 gap-1 rounded-full py-px pr-2 pl-1.5 text-[12px] leading-5 ring-1 ring-white/10 ring-inset max-sm:min-h-11"
                  >
                    <LinkIcon aria-hidden className="size-3" />
                    Link a person
                  </Button>
                )}
                {assigning && <Assignee task={task} assigning={assigning} />}
              </div>
            </div>
          )}
        </div>
        <div
          className={cn("ease-power3-out grid transition-[grid-template-rows] duration-300", expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}
          onTransitionEnd={(event) => {
            if (event.target === event.currentTarget) expansion.settle();
          }}
        >
          <div className="min-h-0 overflow-hidden" inert={!expanded}>
            {expansion.mounted && (
              <div className="flex flex-col gap-3 pt-1 pr-3 pb-3 pl-3 @xl:pl-[46px]">
                {actions}
                <TaskFields details={details} viewer={viewer} members={members} tagged={tagged} layout="row" done={completed} />
                <div className="flex items-center gap-2 max-sm:pt-1">
                  <span className="flex-1 max-sm:hidden" />
                  <Button variant="secondary" size="md" onClick={open} aria-haspopup="dialog" shortcut={keyboard ? ["⇧", "↵"] : undefined} className="max-sm:h-11 max-sm:flex-1">
                    Open
                  </Button>
                  {complete && !completed && (
                    <Button variant="secondary" size="md" onClick={complete} shortcut={keyboard ? ["E"] : undefined} className="max-sm:h-11 max-sm:flex-1">
                      <CheckIcon aria-hidden className="size-3.5" />
                      Done
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

export default memo(ActionTask);
