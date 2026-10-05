"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import Tag from "@/components/_ui/tag";
import { addCompanyNoteAction, addCompanyTaskAction } from "@/app/(crm)/records";
import DetailSection from "@/components/companies/detail/detail-section";
import { ConnectionMark } from "@/components/beautifui/record-marks";
import { formatDate, formatMoney, formatWhen, relativeWhen } from "@/lib/companies";
import type { CompanyContext } from "@/lib/crm/types";

const ACTIVITY_LABELS: Record<string, string> = {
  email: "Email",
  meeting: "Meeting",
  call: "Call",
  note: "Note",
  research: "Research",
  linkedin: "LinkedIn",
  agent_update: "Agent update",
  other: "Other",
};

export default function RelationshipPanel({
  companyId,
  context,
}: {
  companyId: string;
  context: CompanyContext | null;
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"note" | "task" | null>(null);

  if (!context || context.company.id !== companyId) {
    return (
      <DetailSection title="Relationship" className="shadow-none">
        <p className="caption-style text-subtle">Loading the relationship…</p>
      </DetailSection>
    );
  }

  const last = context.lastInteraction;

  async function saveNote() {
    setPending("note");
    const result = await addCompanyNoteAction(companyId, note);
    setPending(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    setNote("");
    setError(null);
    router.refresh();
  }

  async function saveTask() {
    setPending("task");
    const result = await addCompanyTaskAction(companyId, taskTitle, dueAt);
    setPending(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    setTaskTitle("");
    setDueAt("");
    setError(null);
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
              ? "Needs a next action"
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
            ? `${context.openTaskCount} open next action${context.openTaskCount === 1 ? "" : "s"}`
            : "No next action."}
        </p>
        {error && (
          <p role="alert" className="caption-style text-danger">
            {error}
          </p>
        )}
        <div className="flex flex-col gap-2">
          <label className="caption-style text-subtle" htmlFor={`note-${companyId}`}>
            Add a note
          </label>
          <textarea
            id={`note-${companyId}`}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="What did you discuss?"
            className="border-line-strong bg-secondary min-h-20 w-full rounded-lg border px-3 py-2 text-[14px] leading-5 outline-none"
          />
          <Button
            variant="secondary"
            size="sm"
            type="button"
            className="self-start"
            disabled={pending !== null || note.trim() === ""}
            onClick={saveNote}
          >
            {pending === "note" ? "Saving…" : "Save note"}
          </Button>
        </div>
        <div className="flex flex-col gap-2">
          <label className="caption-style text-subtle" htmlFor={`task-${companyId}`}>
            Next action
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
          />
          <Button
            variant="secondary"
            size="sm"
            type="button"
            className="self-start"
            disabled={pending !== null || taskTitle.trim() === ""}
            onClick={saveTask}
          >
            {pending === "task" ? "Saving…" : "Add next action"}
          </Button>
        </div>
      </DetailSection>

      <DetailSection title="People">
        {context.contacts.length === 0 ? (
          <p className="caption-style text-subtle">No contacts on this company.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {context.contacts.map((contact) => (
              <li key={contact.id} className="flex flex-col gap-1">
                <span className="text-[14px] leading-5">{contact.name}</span>
                <span className="caption-style text-subtle">
                  {[contact.jobTitle, contact.email].filter(Boolean).join(" · ") || "No email"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </DetailSection>

      <DetailSection title="Opportunities">
        {context.opportunities.length === 0 ? (
          <p className="caption-style text-subtle">No opportunities.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {context.opportunities.map((opportunity) => (
              <li key={opportunity.id} className="flex items-start justify-between gap-3">
                <span className="min-w-0">
                  <span className="block truncate text-[14px] leading-5">{opportunity.name}</span>
                  <span className="caption-style text-subtle block">
                    {opportunity.stageName ?? "No stage"} · {formatMoney(opportunity.value, opportunity.currency)}
                  </span>
                </span>
                <Tag tone={opportunity.status === "won" ? "green" : opportunity.status === "lost" ? "red" : "blue"}>
                  {opportunity.status}
                </Tag>
              </li>
            ))}
          </ul>
        )}
      </DetailSection>

      <DetailSection title="Next actions">
        {context.tasks.length === 0 ? (
          <p className="caption-style text-subtle">Nothing scheduled.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {context.tasks.map((task) => (
              <li key={task.id} className="flex flex-col gap-1">
                <span className="text-[14px] leading-5">{task.title}</span>
                <span className="caption-style text-subtle">
                  {task.dueAt ? `Due ${formatWhen(task.dueAt)}` : "No due date"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </DetailSection>

      <DetailSection title="Timeline" className="shadow-none">
        {context.activities.length === 0 ? (
          <p className="caption-style text-subtle">No interactions yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {context.activities.map((activity) => (
              <li key={activity.id} className="flex flex-col gap-1">
                <span className="text-[14px] leading-5">
                  {ACTIVITY_LABELS[activity.type] ?? activity.type}
                  {activity.title ? ` · ${activity.title}` : ""}
                </span>
                {activity.body && <span className="caption-style text-soft">{activity.body}</span>}
                <span className="caption-style text-subtle">{formatDate(activity.occurredAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </DetailSection>
    </>
  );
}
