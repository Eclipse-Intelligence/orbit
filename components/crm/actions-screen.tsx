"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { DateTimePicker } from "@/components/_ui/date-picker";
import { Input } from "@/components/_ui/input";
import RecordTransfer from "@/components/crm/record-transfer";
import SectionHeader from "@/components/crm/section-header";
import ActionTask from "@/components/beautifui/action-task";
import { ClickUpPickerField } from "@/components/crm/clickup";
import ReminderSelect from "@/components/crm/reminder-select";
import { ConnectionMark, Monogram } from "@/components/beautifui/record-marks";
import { RecordList, RecordRow, RecordSelect } from "@/components/crm/record-form";
import type { Viewer } from "@/components/crm/viewer";
import { completeTaskAction, saveTaskAction, type RecordActionState } from "@/app/(crm)/records";
import { relativeWhen } from "@/lib/companies";
import type { ClickUpPicker } from "@/lib/crm/clickup";
import { companyHref } from "@/lib/crm/hrefs";
import { tasksHref } from "@/lib/crm/task-views";
import type { Company, Company as CompanyRow, Task, TaskView } from "@/lib/crm/types";

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
  companyChoices,
  clickup,
  now,
}: {
  viewer: Viewer;
  view: TaskView;
  counts: Record<TaskView, number>;
  tasks: Task[];
  companies: Company[];
  companyChoices: CompanyRow[];
  clickup: ClickUpPicker | null;
  now: number;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState(saveTaskAction, {} as RecordActionState);
  const [message, setMessage] = useState<string | null>(null);
  const [toClickUp, setToClickUp] = useState(true);
  const [clickupListId, setClickupListId] = useState(clickup?.listId ?? "");
  const [dueAt, setDueAt] = useState("");
  const [reminder, setReminder] = useState("none");
  const [settled, setSettled] = useState(state);
  if (settled !== state) {
    setSettled(state);
    if (state.ok) {
      setDueAt("");
      setReminder("none");
    }
  }
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state, router]);

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
      <SectionHeader title="Tasks" viewer={viewer} action={<RecordTransfer resource="tasks" />} />
      <div className="flex flex-wrap gap-2 px-4 pt-4">
        {VIEWS.map((item) => (
          <Button
            key={item.id}
            variant={item.id === view ? "secondary" : "ghost"}
            size="sm"
            href={tasksHref(item.id)}
            aria-current={item.id === view ? "page" : undefined}
          >
            {item.label}
            <span className="text-subtle tabular-nums">{counts[item.id]}</span>
          </Button>
        ))}
      </div>
      <form action={action} className="border-border grid gap-3 border-b px-4 py-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_14em_12em_12em_auto] lg:items-end">
        <label className="flex flex-col gap-2" htmlFor="task-title">
          <span className="caption-style text-subtle">Task</span>
          <Input id="task-title" name="title" required placeholder="Send the follow-up" />
        </label>
        <div className="flex min-w-0 flex-col gap-2">
          <label className="caption-style text-subtle" htmlFor="task-due">
            Due
          </label>
          <DateTimePicker id="task-due" name="dueAt" placeholder="Add a due date" value={dueAt} onChange={setDueAt} />
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <label className="caption-style text-subtle" htmlFor="task-reminder">
            Reminder
          </label>
          <ReminderSelect
            id="task-reminder"
            name="remindMinutes"
            value={reminder}
            onChange={setReminder}
            disabled={!dueAt}
          />
        </div>
        <RecordSelect id="task-company" name="companyId" label="Company" defaultValue="none">
          <option value="none">No company</option>
          {companyChoices.map((company) => (
            <option key={company.id} value={company.id}>
              {company.name}
            </option>
          ))}
        </RecordSelect>
        <Button variant="primary" size="sm" type="submit" disabled={pending}>
          {pending ? "Saving…" : "Add"}
        </Button>
        <input type="hidden" name="priority" value="normal" />
        {clickup && (
          <ClickUpPickerField
            picker={clickup}
            id="task-clickup"
            checked={toClickUp}
            onCheckedChange={setToClickUp}
            listId={clickupListId}
            onListChange={setClickupListId}
            className="sm:col-span-2 lg:col-span-5"
          />
        )}
      </form>
      {(state.error || message) && (
        <p role="alert" className="caption-style text-danger px-4 pt-3">
          {state.error ?? message}
        </p>
      )}
      {state.warning && !state.error && (
        <p role="status" className="caption-style text-soft px-4 pt-3">
          {state.warning}
        </p>
      )}
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
                  <ConnectionMark at={company.lastInteractionAt} now={now} />
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
    </section>
  );
}
