"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import Tag from "@/components/_ui/tag";
import CompanyActivity from "@/components/companies/detail/company-activity";
import DetailSection from "@/components/companies/detail/detail-section";
import InlineField from "@/components/crm/inline-field";
import RecordLayout from "@/components/crm/record-layout";
import { DetailList } from "@/components/crm/record-form";
import SectionHeader from "@/components/crm/section-header";
import type { Viewer } from "@/components/crm/viewer";
import { patchOpportunityAction, type OpportunityPatch } from "@/app/(crm)/records";
import { formatMoney } from "@/lib/companies";
import { companyHref } from "@/lib/crm/hrefs";
import { formatDateLabel } from "@/lib/date-input";
import type { StageStay } from "@/lib/crm/pipeline-history";
import type { CompanyContext, Member, Opportunity, PipelineStage } from "@/lib/crm/types";
import { cn } from "@/lib/utils";

const CURRENCIES = ["GBP", "USD", "EUR"];

const STATUS: Record<Opportunity["status"], { label: string; tone: "blue" | "green" | "red" }> = {
  open: { label: "Open", tone: "blue" },
  won: { label: "Won", tone: "green" },
  lost: { label: "Lost", tone: "red" },
};

const LONDON_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" });

function stayDays(days: number) {
  const whole = Math.floor(days);
  return whole === 1 ? "1 day" : `${whole} days`;
}

function personName(contact: { firstName: string | null; lastName: string | null; email: string | null }) {
  return [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.email || "Unnamed";
}

export default function OpportunityRecord({
  viewer,
  opportunity: saved,
  stages,
  stays,
  context,
  members,
  mailboxConnected,
}: {
  viewer: Viewer;
  opportunity: Opportunity;
  stages: PipelineStage[];
  stays: StageStay[];
  context: CompanyContext;
  members: Member[];
  mailboxConnected: boolean;
}) {
  const router = useRouter();
  const [local, setLocal] = useState<Opportunity | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const opportunity = local && local.updatedAt >= saved.updatedAt ? local : saved;
  const status = STATUS[opportunity.status];
  const openStages = stages.filter((stage) => !stage.isWon && !stage.isLost);
  const currentStage = moving ?? opportunity.stageId;
  const tasks = context.tasks.filter((task) => !task.completedAt);

  async function patch(input: OpportunityPatch) {
    setError(null);
    const result = await patchOpportunityAction(opportunity.id, input);
    if (result.error || !result.opportunity) {
      setError(result.error ?? "That didn't save. Try again.");
      return result.error ?? "That didn't save.";
    }
    setLocal(result.opportunity);
    router.refresh();
    return null;
  }

  async function move(stageId: string) {
    if (stageId === opportunity.stageId) return;
    setMoving(stageId);
    await patch({ stageId });
    setMoving(null);
  }

  async function mark(next: Opportunity["status"]) {
    setMoving(next === "open" ? (openStages[0]?.id ?? null) : (stages.find((stage) => (next === "won" ? stage.isWon : stage.isLost))?.id ?? null));
    await patch({ status: next });
    setMoving(null);
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader
        title={opportunity.name}
        viewer={viewer}
        list="opportunities"
        action={
          opportunity.status === "open" ? (
            <span className="flex items-center gap-1.5">
              <Button variant="secondary" size="sm" disabled={moving !== null} onClick={() => void mark("lost")}>
                Mark lost
              </Button>
              <Button variant="primary" size="sm" disabled={moving !== null} onClick={() => void mark("won")}>
                Mark won
              </Button>
            </span>
          ) : (
            <Button variant="secondary" size="sm" disabled={moving !== null} onClick={() => void mark("open")}>
              Reopen
            </Button>
          )
        }
      />
      <RecordLayout
        activityCount={context.timeline.length}
        summary={
          <div className="flex flex-col gap-4 p-5 shadow-[inset_0_-1px_0_var(--line-strong)]">
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Tag tone={status.tone}>{status.label}</Tag>
                {context.company.health && context.company.health !== "healthy" && (
                  <Tag tone={context.company.health === "at_risk" ? "red" : "amber"}>{context.company.health === "at_risk" ? "At risk" : "Watch"}</Tag>
                )}
              </div>
              <h2 className="text-[20px] leading-7 font-semibold tracking-[-0.01em]">{opportunity.name}</h2>
              <p className="text-soft">
                <Link href={companyHref(opportunity.companyId)} className="text-foreground underline decoration-white/30 underline-offset-2 hover:decoration-white">
                  {opportunity.companyName ?? "Company"}
                </Link>
                {" · "}
                <span className="tabular-nums">{formatMoney(opportunity.value, opportunity.currency)}</span>
                {opportunity.expectedCloseDate && ` · closes ${formatDateLabel(opportunity.expectedCloseDate)}`}
              </p>
            </div>
            {opportunity.status === "open" && openStages.length > 0 && (
              <nav aria-label="Stage" className="-mx-1 overflow-x-auto px-1 pb-1">
                <ol className="flex min-w-max items-center gap-1">
                  {openStages.map((stage, index) => {
                    const reached = openStages.findIndex((item) => item.id === currentStage) >= index;
                    const here = stage.id === currentStage;
                    return (
                      <li key={stage.id}>
                        <button
                          type="button"
                          aria-current={here ? "step" : undefined}
                          disabled={moving !== null}
                          onClick={() => void move(stage.id)}
                          className={cn(
                            "focus-visible:ring-ring/60 flex h-8 items-center rounded-full px-3 text-[13px] whitespace-nowrap outline-none transition-colors duration-150 focus-visible:ring-2 disabled:cursor-default",
                            here ? "bg-primary text-primary-foreground font-medium" : reached ? "bg-white/10 text-foreground hover:bg-white/15" : "text-subtle hover:bg-white/6 hover:text-foreground",
                          )}
                        >
                          {stage.name}
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </nav>
            )}
            {error && (
              <p role="alert" className="caption-style text-danger">
                {error}
              </p>
            )}
          </div>
        }
        details={
          <>
            <DetailSection title="Details">
              <DetailList>
                <InlineField label="Name" value={opportunity.name} onSave={(value) => (value ? patch({ name: value }) : Promise.resolve("Give it a name."))} />
                <InlineField
                  label="Value"
                  type="number"
                  value={opportunity.value ?? ""}
                  display={formatMoney(opportunity.value, opportunity.currency)}
                  onSave={(value) => patch({ value: value || null })}
                />
                <InlineField
                  label="Currency"
                  type="select"
                  value={opportunity.currency}
                  options={[...new Set([...CURRENCIES, opportunity.currency])].map((code) => ({ value: code, label: code }))}
                  onSave={(value) => patch({ currency: value })}
                />
                <InlineField
                  label="Close date"
                  type="date"
                  value={opportunity.expectedCloseDate ?? ""}
                  display={opportunity.expectedCloseDate ? formatDateLabel(opportunity.expectedCloseDate) : undefined}
                  onSave={(value) => patch({ expectedCloseDate: value || null })}
                />
                <InlineField
                  label="Contact"
                  type="select"
                  value={opportunity.primaryContactId ?? ""}
                  options={[{ value: "", label: "No contact" }, ...context.contacts.map((contact) => ({ value: contact.id, label: personName(contact) }))]}
                  onSave={(value) => patch({ primaryContactId: value || null })}
                />
                <InlineField
                  label="Owner"
                  type="select"
                  value={opportunity.ownerId ?? ""}
                  options={[{ value: "", label: "Unassigned" }, ...members.map((member) => ({ value: member.id, label: member.name }))]}
                  emptyLabel="Unassigned"
                  onSave={(value) => patch({ ownerId: value || null })}
                />
                <InlineField
                  label="Probability"
                  type="number"
                  value={opportunity.probability === null ? "" : String(opportunity.probability)}
                  display={opportunity.probability === null ? undefined : `${opportunity.probability}%`}
                  emptyLabel="From the stage"
                  onSave={(value) => patch({ probability: value === "" ? null : Number(value) })}
                />
                <InlineField label="Source" value={opportunity.source ?? ""} onSave={(value) => patch({ source: value || null })} />
              </DetailList>
            </DetailSection>
            <DetailSection title="Stage history">
              {stays.length === 0 ? (
                <p className="caption-style text-subtle">No stage changes yet.</p>
              ) : (
                <ol className="flex flex-col gap-2">
                  {[...stays].reverse().map((stay) => (
                    <li key={`${stay.stageId ?? "none"}-${stay.enteredAt}`} className="flex items-baseline justify-between gap-3 text-[14px] leading-5">
                      <span className="min-w-0 truncate">{stay.stageName ?? "No stage"}</span>
                      <span className="caption-style text-subtle shrink-0 tabular-nums">
                        {formatDateLabel(LONDON_DAY.format(new Date(stay.enteredAt)))} · {stayDays(stay.daysInStage)}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </DetailSection>
            <DetailSection title={tasks.length ? `Open tasks · ${tasks.length}` : "Open tasks"}>
              {tasks.length === 0 ? (
                <p className="caption-style text-subtle">No open tasks for {opportunity.companyName ?? "this company"}.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {tasks.slice(0, 8).map((task) => (
                    <li key={task.id} className="flex items-baseline justify-between gap-3 text-[14px] leading-5">
                      <span className="min-w-0 truncate">{task.title}</span>
                      {task.dueAt && <span className="caption-style text-subtle shrink-0 tabular-nums">{formatDateLabel(task.dueAt.slice(0, 10))}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </DetailSection>
          </>
        }
        activity={
          <CompanyActivity
            companyId={context.company.id}
            companyName={context.company.name}
            contacts={context.contacts}
            timeline={context.timeline}
            insights={context.insights}
            mailboxConnected={mailboxConnected}
            viewerId={viewer.id}
          />
        }
      />
    </section>
  );
}
