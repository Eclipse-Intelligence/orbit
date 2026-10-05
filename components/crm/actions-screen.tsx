"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import RecordTransfer from "@/components/crm/record-transfer";
import SectionHeader from "@/components/crm/section-header";
import { RecordList, RecordRow, RecordSelect } from "@/components/crm/record-form";
import type { Viewer } from "@/components/crm/viewer";
import { completeTaskAction, saveTaskAction, type RecordActionState } from "@/app/(crm)/records";
import { formatWhen } from "@/lib/companies";
import type { Company, Company as CompanyRow, Task, TaskView } from "@/lib/crm/types";

const VIEWS: { id: TaskView; label: string }[] = [
  { id: "overdue", label: "Overdue" },
  { id: "today", label: "Today" },
  { id: "upcoming", label: "Upcoming" },
  { id: "completed", label: "Completed" },
  { id: "none", label: "No next action" },
];

export default function ActionsScreen({
  viewer,
  view,
  tasks,
  companies,
  companyChoices,
}: {
  viewer: Viewer;
  view: TaskView;
  tasks: Task[];
  companies: Company[];
  companyChoices: CompanyRow[];
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState(saveTaskAction, {} as RecordActionState);
  const [message, setMessage] = useState<string | null>(null);
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
      <SectionHeader title="Next actions" viewer={viewer} action={<RecordTransfer resource="tasks" />} />
      <div className="flex flex-wrap gap-2 px-4 pt-4">
        {VIEWS.map((item) => (
          <Button
            key={item.id}
            variant={item.id === view ? "secondary" : "ghost"}
            size="sm"
            href={`/actions?view=${item.id}`}
          >
            {item.label}
          </Button>
        ))}
      </div>
      <form action={action} className="border-border grid gap-3 border-b px-4 py-4 sm:grid-cols-[1fr_180px_180px_auto] sm:items-end">
        <label className="flex flex-col gap-2" htmlFor="task-title">
          <span className="caption-style text-subtle">Next action</span>
          <Input id="task-title" name="title" required placeholder="Send the follow-up" />
        </label>
        <label className="flex flex-col gap-2" htmlFor="task-due">
          <span className="caption-style text-subtle">Due</span>
          <Input id="task-due" name="dueAt" type="datetime-local" />
        </label>
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
      </form>
      {(state.error || message) && (
        <p role="alert" className="caption-style text-danger px-4 pt-3">
          {state.error ?? message}
        </p>
      )}
      {view === "none" ? (
        <RecordList
          count={companies.length}
          empty="Every company has an open next action."
        >
          {companies.map((company) => (
            <RecordRow
              key={company.id}
              title={company.name}
              meta={company.domain ?? "No domain"}
              action={
                <Button variant="ghost" size="sm" href={`/?record=${company.id}`}>
                  Open
                </Button>
              }
            />
          ))}
        </RecordList>
      ) : (
        <RecordList count={tasks.length} empty="Nothing in this view.">
          {tasks.map((task) => (
            <RecordRow
              key={task.id}
              title={task.title}
              meta={[task.companyName, task.dueAt ? formatWhen(task.dueAt) : "No due date", task.priority]
                .filter(Boolean)
                .join(" · ")}
              action={
                view === "completed" ? null : (
                  <Button variant="secondary" size="sm" onClick={() => complete(task.id)}>
                    Done
                  </Button>
                )
              }
            />
          ))}
        </RecordList>
      )}
    </section>
  );
}
