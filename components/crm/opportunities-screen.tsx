"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import { cn } from "@/lib/utils";
import PlusIcon from "@/public/assets/images/_common/plus.svg";
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
import { saveStagesAction } from "@/app/(crm)/settings/actions";
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
  const [boardError, setBoardError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [hovered, setHovered] = useState<number | null>(null);
  const [namingId, setNamingId] = useState<string | null>(null);
  const [state, action, pending] = useActionState(saveOpportunityAction, {} as RecordActionState);

  async function insertStage(index: number) {
    if (adding || stages.length >= 20) return;
    setAdding(true);
    setBoardError(null);
    const name = unusedStageName(stages);
    const drafts = stages.map(stageDraft);
    drafts.splice(index, 0, {
      name,
      probability: probabilityAt(stages, index),
      isWon: false,
      isLost: false,
    });
    const result = await saveStagesAction(drafts);
    setAdding(false);
    if (result.error) {
      setBoardError(result.error);
      return;
    }
    const created = result.stages?.find((stage) => stage.name === name);
    setNamingId(created?.id ?? null);
    router.refresh();
  }

  async function renameStage(stage: PipelineStage, value: string) {
    const name = value.trim();
    setNamingId(null);
    if (!name || name === stage.name) return;
    setBoardError(null);
    const result = await saveStagesAction(
      stages.map((item) => stageDraft({ ...item, name: item.id === stage.id ? name : item.name })),
    );
    if (result.error) {
      setBoardError(result.error);
      return;
    }
    router.refresh();
  }
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
      {boardError && view === "board" && (
        <p role="alert" className="caption-style text-danger px-4 pb-2">
          {boardError}
        </p>
      )}
      {view === "board" ? (
        <div
          className="flex min-h-0 flex-1 items-stretch overflow-auto px-4 pb-4"
          onMouseLeave={() => setHovered(null)}
        >
          {stages.map((stage, index) => {
            const cards = opportunities.filter((opportunity) => opportunity.stageId === stage.id);
            return (
              <div
                key={stage.id}
                className="flex shrink-0 items-stretch"
                onMouseEnter={() => setHovered(index)}
              >
                {index > 0 && (
                  <StageInsert
                    label={`Add a stage between ${stages[index - 1]?.name} and ${stage.name}`}
                    shown={hovered === index - 1 || hovered === index}
                    disabled={adding || stages.length >= 20}
                    onAdd={() => insertStage(index)}
                    onHover={() => setHovered(index)}
                  />
                )}
                <section className="border-sidebar-border bg-sidebar-accent flex w-64 flex-col gap-2 rounded-xl border p-3">
                  {namingId === stage.id ? (
                    <Input
                      aria-label={`${stage.name} name`}
                      autoFocus
                      defaultValue={stage.name}
                      className="h-8"
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                        if (event.key === "Escape") setNamingId(null);
                      }}
                      onBlur={(event) => renameStage(stage, event.target.value)}
                    />
                  ) : (
                    <h2 className="text-[14px] leading-5">{stage.name}</h2>
                  )}
                  <p className="caption-style text-subtle">{cards.length}</p>
                  {cards.map((opportunity) => (
                    <div key={opportunity.id} className="border-border bg-card flex flex-col gap-2 rounded-lg border p-3">
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
              </div>
            );
          })}
          <div className="flex shrink-0" onMouseEnter={() => setHovered(stages.length)}>
            <StageInsert
              label="Add a stage at the end"
              shown={hovered === stages.length - 1 || hovered === stages.length}
              disabled={adding || stages.length >= 20}
              onAdd={() => insertStage(stages.length)}
              onHover={() => setHovered(stages.length)}
            />
          </div>
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

function stageDraft(stage: PipelineStage) {
  return {
    id: stage.id,
    name: stage.name,
    probability: stage.probability,
    isWon: stage.isWon,
    isLost: stage.isLost,
  };
}

function unusedStageName(stages: PipelineStage[]) {
  const names = new Set(stages.map((stage) => stage.name.toLowerCase()));
  if (!names.has("new stage")) return "New stage";
  for (let count = 2; count < 50; count += 1) {
    const candidate = `New stage ${count}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
  return "New stage";
}

function probabilityAt(stages: PipelineStage[], index: number) {
  const left = stages[index - 1];
  const right = stages[index];
  if (left && right && !left.isWon && !left.isLost && !right.isWon && !right.isLost) {
    return Math.round((left.probability + right.probability) / 2);
  }
  if (left && !left.isWon && !left.isLost) return left.probability;
  return 20;
}

function StageInsert({
  label,
  shown,
  disabled,
  onAdd,
  onHover,
}: {
  label: string;
  shown: boolean;
  disabled: boolean;
  onAdd: () => void;
  onHover: () => void;
}) {
  return (
    <div className="relative w-3 shrink-0" onMouseEnter={onHover}>
      <Button
        variant="secondary"
        size="icon-sm"
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onAdd}
        className={cn(
          "absolute top-2 left-1/2 z-10 -translate-x-1/2 transition-opacity duration-150",
          shown ? "opacity-100" : "pointer-events-none opacity-0 focus-visible:pointer-events-auto focus-visible:opacity-100",
        )}
      >
        <PlusIcon aria-hidden className="size-3" />
      </Button>
    </div>
  );
}
