"use client";

import { useState } from "react";
import Link from "next/link";
import Button from "@/components/_ui/button";
import Tag from "@/components/_ui/tag";
import { EntityChip } from "@/components/beautifui/record-marks";
import { ClickUpBadge } from "@/components/crm/clickup";
import { relativeWhen } from "@/lib/companies";
import { companyHref, contactHref } from "@/lib/crm/hrefs";
import { taskDueState } from "@/lib/crm/task-views";
import type { Task } from "@/lib/crm/types";
import { cn } from "@/lib/utils";

export default function ActionTask({
  task,
  completed,
  dueBadge = false,
  now,
  onComplete,
}: {
  task: Task;
  completed: boolean;
  dueBadge?: boolean;
  now: number;
  onComplete?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const overdue =
    Boolean(task.dueAt) && !task.completedAt && new Date(task.dueAt ?? 0).getTime() < now;
  const due = dueBadge ? taskDueState(task.dueAt, now) : null;
  const hasDetail = Boolean(
    task.description || task.contactName || task.opportunityName || task.clickupError,
  );

  return (
    <li className="border-border overflow-hidden border-b">
      <div className="flex h-11 items-center gap-2.5 px-2.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left"
        >
          <span
            aria-hidden
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-full text-white",
              completed ? "bg-success" : overdue ? "bg-danger" : "bg-secondary text-subtle",
            )}
          >
            {completed ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12.5 10 17.5 19 7.5" />
              </svg>
            ) : overdue ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                <path d="M6 6 18 18M18 6 6 18" />
              </svg>
            ) : (
              <span className="size-1.5 rounded-full bg-current" />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate text-[14px] leading-5">{task.title}</span>
          {due ? (
            <Tag
              size="sm"
              tone={due.kind === "overdue" ? "red" : due.kind === "today" ? "amber" : "neutral"}
              className="text-[12px]"
            >
              {due.label}
            </Tag>
          ) : (
            <span className="text-subtle shrink-0 text-[13px]">
              {task.dueAt ? relativeWhen(task.dueAt, now) : "No due date"}
            </span>
          )}
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
            className={cn("text-subtle shrink-0 transition-transform duration-300", open && "rotate-180")}
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <ClickUpBadge task={task} />
        {task.companyName && (
          <EntityChip
            name={task.companyName}
            href={task.companyId ? companyHref(task.companyId) : undefined}
          />
        )}
        {!completed && onComplete && (
          <Button variant="secondary" size="sm" onClick={onComplete}>
            Done
          </Button>
        )}
      </div>
      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{
          gridTemplateRows: open ? "1fr" : "0fr",
          opacity: open ? 1 : 0,
          transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
        }}
      >
        <div className="overflow-hidden">
          <div className="text-subtle flex flex-col gap-1 px-11 pt-0.5 pb-3 text-[13px]">
            {task.description && <p>{task.description}</p>}
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
            {task.clickupError && <p className="text-danger">ClickUp: {task.clickupError}</p>}
            {!hasDetail && <p>No extra detail.</p>}
            {task.priority !== "normal" && <p>Priority {task.priority}</p>}
          </div>
        </div>
      </div>
    </li>
  );
}
