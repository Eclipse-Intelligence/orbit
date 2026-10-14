"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import Tag from "@/components/_ui/tag";
import { addCompanyTaskAction } from "@/app/(crm)/records";
import DetailSection from "@/components/companies/detail/detail-section";
import CompanyContacts from "@/components/companies/detail/company-contacts";
import { ConnectionMark } from "@/components/beautifui/record-marks";
import { ClickUpBadge, ClickUpPickerField } from "@/components/crm/clickup";
import { formatMoney, formatWhen, relativeWhen } from "@/lib/companies";
import type { ClickUpPicker } from "@/lib/crm/clickup";
import type { CompanyContext } from "@/lib/crm/types";

export default function RelationshipPanel({
  context,
  clickup,
}: {
  context: CompanyContext;
  clickup: ClickUpPicker | null;
}) {
  const companyId = context.company.id;
  const router = useRouter();
  const [taskTitle, setTaskTitle] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [toClickUp, setToClickUp] = useState(true);
  const [clickupListId, setClickupListId] = useState(clickup?.listId ?? "");

  const last = context.lastInteraction;

  async function saveTask() {
    setPending(true);
    const result = await addCompanyTaskAction(
      companyId,
      taskTitle,
      dueAt,
      clickup && toClickUp ? clickupListId : null,
    );
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setTaskTitle("");
    setDueAt("");
    setError(null);
    setWarning(result.warning ?? null);
    router.refresh();
  }

  return (
    <>
      <DetailSection title="Relationship">
        <ConnectionMark at={last?.occurredAt ?? null} />
        <p className="caption-style text-soft">
          {context.relationshipStatus === "quiet"
            ? "Quiet relationship"
            : context.relationshipStatus === "needs_action"
              ? "Needs a task"
              : context.relationshipStatus === "new"
                ? "New relationship"
                : "Active relationship"}
        </p>
        <p className="caption-style text-soft">
          {last
            ? `Last interaction ${relativeWhen(last.occurredAt)}${last.title ? `: ${last.title}` : ""}`
            : "No contact"}
        </p>
        <p className="caption-style text-subtle">
          {context.openTaskCount > 0
            ? `${context.openTaskCount} open task${context.openTaskCount === 1 ? "" : "s"}`
            : "No open tasks."}
        </p>
        {error && (
          <p role="alert" className="caption-style text-danger">
            {error}
          </p>
        )}
        <div className="flex flex-col gap-2">
          <label
            className="caption-style text-subtle"
            htmlFor={`task-${companyId}`}
          >
            Task
          </label>
          <Input
            id={`task-${companyId}`}
            value={taskTitle}
            onChange={(event) => setTaskTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
            placeholder="Follow up on the proposal"
          />
          <Input
            type="datetime-local"
            aria-label="Due date"
            value={dueAt}
            onChange={(event) => setDueAt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
          />
          {clickup && (
            <ClickUpPickerField
              picker={clickup}
              id={`task-${companyId}-clickup`}
              checked={toClickUp}
              onCheckedChange={setToClickUp}
              listId={clickupListId}
              onListChange={setClickupListId}
            />
          )}
          {warning && (
            <p role="status" className="caption-style text-soft">
              {warning}
            </p>
          )}
          <Button
            variant="secondary"
            size="sm"
            type="button"
            className="self-start"
            disabled={pending || taskTitle.trim() === ""}
            onClick={saveTask}
          >
            {pending ? "Saving…" : "Add task"}
          </Button>
        </div>
      </DetailSection>

      <CompanyContacts companyId={companyId} contacts={context.contacts} />

      <DetailSection title="Opportunities">
        {context.opportunities.length === 0 ? (
          <p className="caption-style text-subtle">No opportunities.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {context.opportunities.map((opportunity) => (
              <li
                key={opportunity.id}
                className="flex items-start justify-between gap-3"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[14px] leading-5">
                    {opportunity.name}
                  </span>
                  <span className="caption-style text-subtle block">
                    {opportunity.stageName ?? "No stage"} ·{" "}
                    {formatMoney(opportunity.value, opportunity.currency)}
                  </span>
                </span>
                <Tag
                  tone={
                    opportunity.status === "won"
                      ? "green"
                      : opportunity.status === "lost"
                        ? "red"
                        : "blue"
                  }
                >
                  {opportunity.status}
                </Tag>
              </li>
            ))}
          </ul>
        )}
      </DetailSection>

      <DetailSection title="Tasks" className="shadow-none">
        {context.tasks.length === 0 ? (
          <p className="caption-style text-subtle">No open tasks.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {context.tasks.map((task) => (
              <li key={task.id} className="flex flex-col gap-1">
                <span className="text-[14px] leading-5">{task.title}</span>
                <span className="caption-style text-subtle flex flex-wrap items-center gap-2">
                  {task.dueAt ? `Due ${formatWhen(task.dueAt)}` : "No due date"}
                  <ClickUpBadge task={task} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </DetailSection>

    </>
  );
}
