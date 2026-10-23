"use client";

import Link from "next/link";
import Tag from "@/components/_ui/tag";
import DetailSection from "@/components/companies/detail/detail-section";
import CompanyContacts from "@/components/companies/detail/company-contacts";
import { ConnectionMark } from "@/components/beautifui/record-marks";
import { ClickUpBadge } from "@/components/crm/clickup";
import TaskPad from "@/components/crm/task-pad";
import { formatMoney, formatWhen, relativeWhen } from "@/lib/companies";
import type { ClickUpPicker } from "@/lib/crm/clickup";
import type { CompanyContext } from "@/lib/crm/types";

export default function RelationshipPanel({
  context,
  clickup,
  findEmail = false,
}: {
  context: CompanyContext;
  clickup: ClickUpPicker | null;
  findEmail?: boolean;
}) {
  const companyId = context.company.id;
  const last = context.lastInteraction;
  const deals = context.opportunities.filter((opportunity) => opportunity.pipelineKind !== "board");
  const cards = context.opportunities.filter((opportunity) => opportunity.pipelineKind === "board");

  return (
    <>
      <DetailSection title="Relationship">
        <ConnectionMark relationship={context.relationship} className="text-foreground text-[14px]" />
        <p className="caption-style text-soft leading-[1.45]">{context.relationship.reason}</p>
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
        <TaskPad
          clickup={clickup}
          company={{ id: companyId, name: context.company.name }}
          placeholder="Add a task, e.g. Send the proposal Friday 10am"
        />
      </DetailSection>

      <CompanyContacts companyId={companyId} contacts={context.contacts} findEmail={findEmail} />

      <DetailSection title="Opportunities">
        {deals.length === 0 ? (
          <p className="caption-style text-subtle">No opportunities.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {deals.map((opportunity) => (
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

      {cards.length > 0 && (
        <DetailSection title="Boards">
          <ul className="flex flex-col gap-3">
            {cards.map((card) => (
              <li key={card.id} className="flex items-start justify-between gap-3">
                <Link href={`/boards/${card.pipelineId}`} className="min-w-0 hover:underline">
                  <span className="block truncate text-[14px] leading-5">{card.pipelineName}</span>
                </Link>
                <Tag tone="blue">{card.stageName ?? "No stage"}</Tag>
              </li>
            ))}
          </ul>
        </DetailSection>
      )}

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
