"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import Tag from "@/components/_ui/tag";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/_ui/sheet";
import RecordTransfer from "@/components/crm/record-transfer";
import SectionHeader from "@/components/crm/section-header";
import { RecordList, RecordRow, RecordSelect } from "@/components/crm/record-form";
import type { Viewer } from "@/components/crm/viewer";
import { moveOpportunityStageAction, saveOpportunityAction, type RecordActionState } from "@/app/(crm)/records";
import { formatMoney } from "@/lib/companies";
import type { Company, Contact, Opportunity, PipelineStage } from "@/lib/crm/types";

export default function OpportunitiesScreen({
  viewer,
  opportunities,
  total,
  query,
  companies,
  contacts,
  stages,
  view,
}: {
  viewer: Viewer;
  opportunities: Opportunity[];
  total: number;
  query: string;
  companies: Company[];
  contacts: Contact[];
  stages: PipelineStage[];
  view: "list" | "board";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Opportunity | null>(null);
  const [state, action, pending] = useActionState(saveOpportunityAction, {} as RecordActionState);
  const [closedFor, setClosedFor] = useState<RecordActionState | null>(null);
  if (state.ok && closedFor !== state) {
    setClosedFor(state);
    setOpen(false);
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader
        title="Opportunities"
        viewer={viewer}
        action={
          <div className="flex items-center gap-1">
            <Button variant={view === "list" ? "secondary" : "ghost"} size="sm" href="/opportunities">
              List
            </Button>
            <Button variant={view === "board" ? "secondary" : "ghost"} size="sm" href="/opportunities?view=board">
              Board
            </Button>
            <RecordTransfer resource="opportunities" />
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setEditing(null);
                setOpen(true);
              }}
            >
              Add opportunity
            </Button>
          </div>
        }
      />
      <form action="/opportunities" className="flex items-center gap-2 px-4 py-4">
        <label className="sr-only" htmlFor="opportunity-search">
          Search opportunities
        </label>
        <Input
          id="opportunity-search"
          name="q"
          defaultValue={query}
          placeholder="Search name or company"
          className="w-[240px]"
        />
      </form>
      <p className="caption-style text-subtle px-4 pb-2">
        {total} {total === 1 ? "opportunity" : "opportunities"}
      </p>
      {view === "board" ? (
        <div className="flex min-h-0 flex-1 gap-3 overflow-auto px-4 pb-4">
          {stages.map((stage) => {
            const cards = opportunities.filter((opportunity) => opportunity.stageId === stage.id);
            return (
              <section key={stage.id} className="bg-card flex w-64 shrink-0 flex-col gap-2 rounded-xl p-3">
                <h2 className="text-[14px] leading-5">{stage.name}</h2>
                <p className="caption-style text-subtle">{cards.length}</p>
                {cards.map((opportunity) => (
                  <div key={opportunity.id} className="border-border flex flex-col gap-2 rounded-lg border p-3">
                    <span className="text-[14px] leading-5">{opportunity.name}</span>
                    <span className="caption-style text-subtle">
                      {opportunity.companyName ?? "No company"} · {formatMoney(opportunity.value, opportunity.currency)}
                    </span>
                    <label className="sr-only" htmlFor={`move-${opportunity.id}`}>
                      Move {opportunity.name}
                    </label>
                    <select
                      id={`move-${opportunity.id}`}
                      className="border-line-strong bg-secondary h-9 rounded-lg border px-2 text-[14px]"
                      value={opportunity.stageId ?? stage.id}
                      onChange={async (event) => {
                        await moveOpportunityStageAction(opportunity.id, event.target.value);
                        router.refresh();
                      }}
                    >
                      {stages.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </section>
            );
          })}
        </div>
      ) : (
      <RecordList count={opportunities.length} empty="No opportunities yet.">
        {opportunities.map((opportunity) => (
          <RecordRow
            key={opportunity.id}
            title={opportunity.name}
            meta={`${opportunity.companyName ?? "No company"} · ${opportunity.stageName ?? "No stage"} · ${formatMoney(opportunity.value, opportunity.currency)}`}
            onClick={() => {
              setEditing(opportunity);
              setOpen(true);
            }}
            action={
              <Tag tone={opportunity.status === "won" ? "green" : opportunity.status === "lost" ? "red" : "blue"}>
                {opportunity.status}
              </Tag>
            }
          />
        ))}
      </RecordList>
      )}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="sm:w-[480px] sm:max-w-[480px]">
          <SheetHeader>
            <SheetTitle>{editing ? "Edit opportunity" : "New opportunity"}</SheetTitle>
            <SheetDescription className="sr-only">Opportunity details</SheetDescription>
          </SheetHeader>
          <form key={editing?.id ?? "new"} action={action} className="flex min-h-0 flex-1 flex-col">
            <input type="hidden" name="id" value={editing?.id ?? ""} />
            <div className="flex flex-col gap-4 overflow-auto p-5">
              {state.error && !state.ok && (
                <p role="alert" className="caption-style text-danger">
                  {state.error}
                </p>
              )}
              <label className="flex flex-col gap-2" htmlFor="opp-name">
                <span className="caption-style text-subtle">Name</span>
                <Input id="opp-name" name="name" required defaultValue={editing?.name ?? ""} />
              </label>
              <RecordSelect
                id="opp-company"
                name="companyId"
                label="Company"
                defaultValue={editing?.companyId ?? companies[0]?.id ?? ""}
              >
                {companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </RecordSelect>
              <RecordSelect
                id="opp-stage"
                name="stageId"
                label="Stage"
                defaultValue={editing?.stageId ?? stages[0]?.id ?? "none"}
              >
                <option value="none">Default stage</option>
                {stages.map((stage) => (
                  <option key={stage.id} value={stage.id}>
                    {stage.name}
                  </option>
                ))}
              </RecordSelect>
              <RecordSelect
                id="opp-contact"
                name="primaryContactId"
                label="Primary contact"
                defaultValue={editing?.primaryContactId ?? "none"}
              >
                <option value="none">No contact</option>
                {contacts.map((contact) => (
                  <option key={contact.id} value={contact.id}>
                    {contact.name}
                  </option>
                ))}
              </RecordSelect>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="flex flex-col gap-2" htmlFor="opp-value">
                  <span className="caption-style text-subtle">Value</span>
                  <Input id="opp-value" name="value" inputMode="decimal" defaultValue={editing?.value ?? ""} />
                </label>
                <label className="flex flex-col gap-2" htmlFor="opp-currency">
                  <span className="caption-style text-subtle">Currency</span>
                  <Input id="opp-currency" name="currency" defaultValue={editing?.currency ?? "USD"} maxLength={3} />
                </label>
              </div>
              <label className="flex flex-col gap-2" htmlFor="opp-close">
                <span className="caption-style text-subtle">Expected close</span>
                <Input
                  id="opp-close"
                  name="expectedCloseDate"
                  type="date"
                  defaultValue={editing?.expectedCloseDate ?? ""}
                />
              </label>
              <label className="flex flex-col gap-2" htmlFor="opp-source">
                <span className="caption-style text-subtle">Source</span>
                <Input id="opp-source" name="source" defaultValue={editing?.source ?? ""} />
              </label>
            </div>
            <SheetFooter>
              <Button variant="subtle" size="sm" type="button" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" type="submit" disabled={pending || companies.length === 0}>
                {pending ? "Saving…" : "Save"}
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>
    </section>
  );
}
