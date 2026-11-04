"use client";

import Link from "next/link";
import Button from "@/components/_ui/button";
import Tag from "@/components/_ui/tag";
import { EntityChip } from "@/components/beautifui/record-marks";
import SectionHeader from "@/components/crm/section-header";
import TaskPad from "@/components/crm/task-pad";
import type { Viewer } from "@/components/crm/viewer";
import { cn } from "@/lib/utils";
import MailIcon from "@/public/assets/images/mail/mail-open.svg";

type MockTask = {
  title: string;
  due: string;
  tone: "red" | "amber" | "neutral";
  company: string;
  expanded?: boolean;
};

const TASKS: MockTask[] = [
  { title: "Send Brightwave the revised contract", due: "Today", tone: "amber", company: "Brightwave" },
  { title: "Book the Northwind scoping call", due: "Thu 5 Nov", tone: "neutral", company: "Northwind" },
  { title: "Renewal pack for Client Seed", due: "Mon 16 Nov", tone: "neutral", company: "Client Seed" },
  { title: "Check in with Jane Doe", due: "11 Jan 2027", tone: "neutral", company: "Acme", expanded: true },
];

const VIEWS = [
  ["All", 4],
  ["Overdue", 0],
  ["Today", 1],
  ["Upcoming", 3],
  ["Completed", 12],
  ["Companies without tasks", 9],
] as const;

function TaskRow({ task }: { task: MockTask }) {
  return (
    <li data-mock-focus={task.expanded ? "" : undefined} className="border-border overflow-hidden border-b">
      <div className="flex items-start gap-2.5 px-2.5 py-2.5 sm:min-h-11 sm:items-center sm:py-1.5">
        <button
          type="button"
          aria-label={`Mark “${task.title}” done`}
          className="bg-secondary text-subtle flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full"
        >
          <span className="block size-1.5 rounded-full bg-current" />
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2.5">
          <button type="button" aria-expanded={Boolean(task.expanded)} className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 text-left sm:items-center">
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
              className={cn("text-subtle mt-0.5 shrink-0 sm:mt-0", task.expanded && "rotate-180")}
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 sm:shrink-0 sm:flex-nowrap">
            <Tag size="sm" tone={task.tone} className="text-[12px]">
              {task.due}
            </Tag>
            <EntityChip name={task.company} />
          </div>
        </div>
        <Button variant="secondary" size="sm" className="hidden sm:inline-flex" tabIndex={-1}>
          Done
        </Button>
      </div>
      {task.expanded && (
        <div className="text-subtle flex flex-col gap-1 px-11 pt-0.5 pb-3 text-[13px]">
          <p>Asked to pick this up in January.</p>
          <p>
            <Link href="#" className="hover:text-foreground underline-offset-2 hover:underline">
              Jane Doe
            </Link>
          </p>
          <p>Reminder at the due time</p>
          <p>
            <Link href="#" className="text-soft hover:text-foreground inline-flex items-center gap-1.5 underline-offset-2 hover:underline">
              <MailIcon aria-hidden className="size-3" />
              Acme pilot: proposal and next steps
            </Link>
          </p>
        </div>
      )}
    </li>
  );
}

export default function TasksMock({ viewer }: { viewer: Viewer }) {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader title="Tasks" viewer={viewer} />
      <div className="flex flex-wrap gap-2 px-4 pt-4">
        {VIEWS.map(([label, count], index) => (
          <Button key={label} variant={index === 0 ? "secondary" : "ghost"} size="sm" aria-current={index === 0 ? "page" : undefined}>
            {label}
            <span className="text-subtle tabular-nums">{count}</span>
          </Button>
        ))}
      </div>
      <TaskPad clickup={null} className="border-border border-b px-4 py-3" />
      <ul className="min-h-0 flex-1 overflow-auto pb-20">
        {TASKS.map((task) => (
          <TaskRow key={task.title} task={task} />
        ))}
      </ul>
    </section>
  );
}
