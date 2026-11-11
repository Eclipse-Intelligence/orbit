"use client";

import Tag from "@/components/_ui/tag";
import { EntityChip } from "@/components/beautifui/record-marks";
import AssigneePicker, { MemberAvatar, type AssignableMember } from "@/components/crm/assignee-picker";
import { ClickUpBadge } from "@/components/crm/clickup";
import { relativeWhen } from "@/lib/companies";
import { companyHref } from "@/lib/crm/hrefs";
import { taskDueState } from "@/lib/crm/task-views";
import type { Task } from "@/lib/crm/types";
import { KEYBOARD_ROW_CLASS } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import ChatIcon from "@/public/assets/images/chat/chat.svg";

export type TaskAssigning = {
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
      triggerClassName="min-h-11 min-w-11 justify-center sm:min-h-0 sm:min-w-0"
      trigger={<MemberAvatar member={member} viewerId={assigning.viewerId} className="hover:ring-line-strong hover:ring-2" />}
    />
  );
}

export default function ActionTask({
  task,
  completed,
  dueBadge = false,
  now,
  onComplete,
  onOpen,
  comments = 0,
  assigning,
}: {
  task: Task;
  completed: boolean;
  dueBadge?: boolean;
  now: number;
  onComplete?: () => void;
  onOpen: () => void;
  comments?: number;
  assigning?: TaskAssigning;
}) {
  const overdue =
    Boolean(task.dueAt) && !task.completedAt && new Date(task.dueAt ?? 0).getTime() < now;
  const due = dueBadge ? taskDueState(task.dueAt, now) : null;

  return (
    <li data-list-row="" className={cn(KEYBOARD_ROW_CLASS, "border-border overflow-hidden border-b")}>
      <div className="flex items-start gap-2.5 px-2.5 py-2.5 sm:min-h-11 sm:items-center sm:py-1.5">
        <button
          type="button"
          disabled={completed || !onComplete}
          onClick={onComplete}
          data-row-key="d"
          aria-label={completed ? "Done" : `Mark “${task.title}” done`}
          title={completed ? "Done" : "Mark done (D)"}
          className={cn(
            "group/done flex size-6 shrink-0 items-center justify-center rounded-full text-white transition-colors duration-150 disabled:cursor-default enabled:cursor-pointer",
            completed
              ? "bg-success"
              : overdue
                ? "bg-danger enabled:hover:bg-success"
                : "bg-secondary text-subtle enabled:hover:bg-success enabled:hover:text-white",
          )}
        >
          {completed ? (
            <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12.5 10 17.5 19 7.5" />
            </svg>
          ) : (
            <>
              <svg
                aria-hidden
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="hidden group-enabled/done:group-hover/done:block"
              >
                <path d="M5 12.5 10 17.5 19 7.5" />
              </svg>
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
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2.5">
          <button
            type="button"
            data-row-open=""
            data-row-key="space"
            aria-haspopup="dialog"
            onClick={onOpen}
            className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 text-left sm:items-center"
          >
            <span className="min-w-0 flex-1 text-[14px] leading-5 break-words sm:truncate">{task.title}</span>
          </button>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 sm:shrink-0 sm:flex-nowrap">
            {comments > 0 && (
              <span className="caption-style text-subtle flex shrink-0 items-center gap-1 tabular-nums" title={comments === 1 ? "1 comment" : `${comments} comments`}>
                <ChatIcon aria-hidden className="size-3" />
                {comments}
                <span className="sr-only">{comments === 1 ? " comment" : " comments"}</span>
              </span>
            )}
            {due ? (
              <Tag
                size="sm"
                tone={due.kind === "overdue" ? "red" : due.kind === "today" ? "amber" : "neutral"}
                className="text-[12px]"
              >
                {due.label}
              </Tag>
            ) : (
              task.dueAt && <span className="text-subtle shrink-0 text-[13px]">{relativeWhen(task.dueAt, now)}</span>
            )}
            <ClickUpBadge task={task} />
            {task.companyName && (
              <EntityChip
                name={task.companyName}
                href={task.companyId ? companyHref(task.companyId) : undefined}
              />
            )}
            {assigning && <Assignee task={task} assigning={assigning} />}
          </div>
        </div>
      </div>
    </li>
  );
}
