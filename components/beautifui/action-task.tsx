"use client";

import { useState } from "react";
import Link from "next/link";
import Tag from "@/components/_ui/tag";
import { EntityChip } from "@/components/beautifui/record-marks";
import AssigneePicker, { MemberAvatar, type AssignableMember } from "@/components/crm/assignee-picker";
import { ClickUpBadge } from "@/components/crm/clickup";
import RecordNotes from "@/components/docs/record-notes";
import { relativeWhen } from "@/lib/companies";
import { companyHref, contactHref } from "@/lib/crm/hrefs";
import { reminderLabel } from "@/lib/crm/reminder-options";
import { taskDueState } from "@/lib/crm/task-views";
import type { Task } from "@/lib/crm/types";
import { KEYBOARD_ROW_CLASS } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import MailIcon from "@/public/assets/images/mail/mail-open.svg";

const MAIL_LINK = /^\[([^\]\n]+)\]\((\/mail\?thread=[^)\s]+)\)$/;

function splitDescription(description: string | null) {
  const links: { label: string; href: string }[] = [];
  const text = (description ?? "")
    .split("\n")
    .filter((line) => {
      const match = MAIL_LINK.exec(line.trim());
      if (match) links.push({ label: match[1], href: match[2] });
      return !match;
    })
    .join("\n")
    .trim();
  return { text, links };
}

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
  assigning,
}: {
  task: Task;
  completed: boolean;
  dueBadge?: boolean;
  now: number;
  onComplete?: () => void;
  assigning?: TaskAssigning;
}) {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  const overdue =
    Boolean(task.dueAt) && !task.completedAt && new Date(task.dueAt ?? 0).getTime() < now;
  const due = dueBadge ? taskDueState(task.dueAt, now) : null;
  const reminder = task.dueAt ? reminderLabel(task.remindMinutes) : null;
  const description = splitDescription(task.description);

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
            aria-expanded={open}
            onClick={() => {
              setOpen((current) => !current);
              setOpened(true);
            }}
            className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 text-left sm:items-center"
          >
            <span className="min-w-0 flex-1 text-[14px] leading-5 break-words sm:truncate">{task.title}</span>
            <svg
              aria-hidden
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={cn("text-subtle mt-0.5 shrink-0 transition-transform duration-300 sm:mt-0", open && "rotate-180")}
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 sm:shrink-0 sm:flex-nowrap">
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
      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{
          gridTemplateRows: open ? "1fr" : "0fr",
          opacity: open ? 1 : 0,
          transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
        }}
      >
        <div className="overflow-hidden" inert={!open}>
          <div className="text-subtle flex flex-col gap-1 px-11 pt-0.5 pb-3 text-[13px]">
            {description.text && <p>{description.text}</p>}
            {task.contactName && (
              <p>
                {task.contactId ? (
                  <Link
                    href={contactHref(task.contactId)}
                    className="hover:text-foreground underline-offset-2 hover:underline"
                  >
                    {task.contactName}
                  </Link>
                ) : (
                  task.contactName
                )}
              </p>
            )}
            {task.opportunityName && <p>{task.opportunityName}</p>}
            {reminder && <p>Reminder {reminder.toLowerCase()}</p>}
            {description.links.map((link, index) => (
              <p key={`${index}:${link.href}`}>
                <Link href={link.href} className="text-soft hover:text-foreground inline-flex items-center gap-1.5 underline-offset-2 hover:underline">
                  <MailIcon aria-hidden className="size-3 shrink-0" />
                  {link.label}
                </Link>
              </p>
            ))}
            {task.clickupError && <p className="text-danger">ClickUp: {task.clickupError}</p>}
            {task.priority !== "normal" && <p>Priority {task.priority}</p>}
            {opened && <RecordNotes compact record={{ kind: "task", id: task.id, name: task.title }} className="mt-2" />}
          </div>
        </div>
      </div>
    </li>
  );
}
