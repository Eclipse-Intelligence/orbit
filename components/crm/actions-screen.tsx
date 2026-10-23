"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import RecordTransfer from "@/components/crm/record-transfer";
import SectionHeader from "@/components/crm/section-header";
import KeyboardList from "@/components/shortcuts/keyboard-list";
import ActionTask from "@/components/beautifui/action-task";
import TaskPad from "@/components/crm/task-pad";
import { ConnectionMark, Monogram } from "@/components/beautifui/record-marks";
import { RecordList, RecordRow } from "@/components/crm/record-form";
import type { Viewer } from "@/components/crm/viewer";
import { completeTaskAction } from "@/app/(crm)/records";
import { relativeWhen } from "@/lib/companies";
import type { ClickUpPicker } from "@/lib/crm/clickup";
import { companyHref } from "@/lib/crm/hrefs";
import { tasksHref } from "@/lib/crm/task-views";
import type { Company, Task, TaskView } from "@/lib/crm/types";

const VIEWS: { id: TaskView; label: string }[] = [
  { id: "all", label: "All" },
  { id: "overdue", label: "Overdue" },
  { id: "today", label: "Today" },
  { id: "upcoming", label: "Upcoming" },
  { id: "completed", label: "Completed" },
  { id: "none", label: "Companies without tasks" },
];

export default function ActionsScreen({
  viewer,
  view,
  counts,
  tasks,
  companies,
  clickup,
  now,
  who = "mine",
  shared = false,
}: {
  viewer: Viewer;
  view: TaskView;
  counts: Record<TaskView, number>;
  tasks: Task[];
  companies: Company[];
  clickup: ClickUpPicker | null;
  now: number;
  who?: "mine" | "everyone";
  shared?: boolean;
}) {
  const href = (target: TaskView, person = who) => {
    const base = tasksHref(target);
    if (!shared || person === "mine") return base;
    return `${base}${base.includes("?") ? "&" : "?"}who=everyone`;
  };
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);

  async function complete(id: string) {
    const result = await completeTaskAction(id);
    if (result.error) {
      setMessage(result.error);
      return;
    }
    setMessage(null);
    router.refresh();
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader
        title="Tasks"
        viewer={viewer}
        action={
          <span className="flex items-center gap-1">
            {shared && (
              <>
                <Button variant={who === "mine" ? "secondary" : "ghost"} size="sm" href={href(view, "mine")} aria-current={who === "mine" ? "page" : undefined}>
                  Mine
                </Button>
                <Button
                  variant={who === "everyone" ? "secondary" : "ghost"}
                  size="sm"
                  href={href(view, "everyone")}
                  aria-current={who === "everyone" ? "page" : undefined}
                >
                  Everyone
                </Button>
              </>
            )}
            <RecordTransfer resource="tasks" />
          </span>
        }
      />
      <div className="flex flex-wrap gap-2 px-4 pt-4">
        {VIEWS.map((item, index) => (
          <Button
            key={item.id}
            variant={item.id === view ? "secondary" : "ghost"}
            size="sm"
            href={href(item.id)}
            aria-current={item.id === view ? "page" : undefined}
            data-shortcut={`tab-${index + 1}`}
            title={`${item.label} (${index + 1})`}
          >
            {item.label}
            <span className="text-subtle tabular-nums">{counts[item.id]}</span>
          </Button>
        ))}
      </div>
      <TaskPad clickup={clickup} className="border-border border-b px-4 py-3" />
      {message && (
        <p role="alert" className="caption-style text-danger px-4 pt-3">
          {message}
        </p>
      )}
      <KeyboardList className="flex min-h-0 flex-1 flex-col">
      {view === "none" ? (
        <RecordList
          count={companies.length}
          empty="Every company has an open task."
        >
          {companies.map((company) => (
            <RecordRow
              key={company.id}
              mark={<Monogram name={company.name} />}
              title={company.name}
              meta={`${relativeWhen(company.lastInteractionAt, now)} · ${company.domain ?? "No domain"}`}
              action={
                <span className="flex items-center gap-3">
                  <ConnectionMark relationship={company.relationship} />
                  <Button variant="ghost" size="sm" href={companyHref(company.id)}>
                    Open
                  </Button>
                </span>
              }
            />
          ))}
        </RecordList>
      ) : (
        <RecordList count={tasks.length} empty={view === "all" ? "No open tasks." : "Nothing in this view."}>
          {tasks.map((task) => (
            <ActionTask
              key={task.id}
              task={task}
              completed={view === "completed"}
              dueBadge={view === "all"}
              now={now}
              onComplete={view === "completed" ? undefined : () => complete(task.id)}
            />
          ))}
        </RecordList>
      )}
      </KeyboardList>
    </section>
  );
}
