"use client";

import RecordTasks from "@/components/crm/record-tasks";
import type { Viewer } from "@/components/crm/viewer";
import Link from "next/link";
import Tag from "@/components/_ui/tag";
import DetailSection from "@/components/companies/detail/detail-section";
import CompanyContacts from "@/components/companies/detail/company-contacts";
import { ConnectionMark } from "@/components/beautifui/record-marks";
import TaskPad from "@/components/crm/task-pad";
import { RelationshipError, RelationshipSelect, RelationshipSource, useRelationshipPicker } from "@/components/crm/relationship-picker";
import { formatMoney, relativeWhen } from "@/lib/companies";
import type { ClickUpPicker } from "@/lib/crm/clickup";
import type { CompanyContext, Member } from "@/lib/crm/types";
import { dealHref } from "@/lib/crm/hrefs";

export default function RelationshipPanel({
  context,
  clickup,
  findEmail = false,
  viewerId,
  viewer,
  members = [],
}: {
  context: CompanyContext;
  clickup: ClickUpPicker | null;
  findEmail?: boolean;
  viewerId?: string | null;
  viewer?: Viewer;
  members?: Member[];
}) {
  const companyId = context.company.id;
  const picker = useRelationshipPicker("company", companyId);
  const relationship = context.relationship;
  const last = context.lastInteraction;
  const deals = context.opportunities.filter((opportunity) => opportunity.pipelineKind !== "board");
  const cards = context.opportunities.filter((opportunity) => opportunity.pipelineKind === "board");

  return (
    <>
      <DetailSection
        title="Relationship"
        action={
          <RelationshipSelect
            relationship={relationship}
            pending={picker.pending}
            disabled={Boolean(context.company.archivedAt)}
            onChange={picker.change}
          />
        }
      >
        <ConnectionMark relationship={relationship} className="text-foreground text-[14px]" />
        {(!relationship.override || relationship.override.reason) && (
          <p className="caption-style text-soft leading-[1.45]">{relationship.reason}</p>
        )}
        <RelationshipSource relationship={relationship} viewerId={viewerId} />
        <RelationshipError error={picker.error} />
        <p className="caption-style text-soft">
          {last
            ? `Last interaction ${relativeWhen(last.occurredAt)}${last.title ? `: ${last.title}` : ""}`
            : "No interactions"}
        </p>
      </DetailSection>

      <CompanyContacts companyId={companyId} contacts={context.contacts} findEmail={findEmail} />

      <DetailSection title="Opportunities">
        {deals.length === 0 ? (
          <p className="caption-style text-subtle">No opportunities</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {deals.map((opportunity) => (
              <li
                key={opportunity.id}
                className="flex items-start justify-between gap-3"
              >
                <span className="min-w-0">
                  <Link href={dealHref(opportunity.id)} className="block truncate text-[14px] leading-5 hover:underline hover:decoration-white/40 hover:underline-offset-2">
                    {opportunity.name}
                  </Link>
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
                  {opportunity.status === "won" ? "Won" : opportunity.status === "lost" ? "Lost" : "Open"}
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
        <TaskPad
          clickup={clickup}
          company={{ id: companyId, name: context.company.name }}
          placeholder={`Next thing to do with ${context.company.name}`}
          members={members}
          viewerId={viewerId ?? null}
        />
        {viewer ? (
          <RecordTasks tasks={context.tasks} viewer={viewer} members={members} here={{ kind: "company", id: companyId }} />
        ) : (
          context.tasks.length === 0 && <p className="caption-style text-subtle">No tasks</p>
        )}
      </DetailSection>

    </>
  );
}
