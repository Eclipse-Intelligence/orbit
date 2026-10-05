"use client";

import { useActionState, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
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
import { EntityChip, Monogram } from "@/components/beautifui/record-marks";
import RecordTransfer from "@/components/crm/record-transfer";
import SectionHeader from "@/components/crm/section-header";
import { RecordList, RecordRow, RecordSelect } from "@/components/crm/record-form";
import type { Viewer } from "@/components/crm/viewer";
import { moveOpportunityStageAction, saveOpportunityAction, type RecordActionState } from "@/app/(crm)/records";
import { saveStagesAction } from "@/app/(crm)/settings/actions";
import type { StageDraft } from "@/lib/crm/pipeline";
import { formatMoney } from "@/lib/companies";
import type { Company, Contact, Opportunity, OpportunityStatus, PipelineStage } from "@/lib/crm/types";

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
  const [ordered, setOrdered] = useState(stages);
  const [stageSource, setStageSource] = useState(stages);
  const [preview, setPreview] = useState<PipelineStage[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [placed, setPlaced] = useState(opportunities);
  const [placedSource, setPlacedSource] = useState(opportunities);
  const [cardPreview, setCardPreview] = useState<Opportunity[] | null>(null);
  const [cardDragId, setCardDragId] = useState<string | null>(null);
  const [dropStageId, setDropStageId] = useState<string | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const orderedRef = useRef(stages);
  const previewRef = useRef<PipelineStage[] | null>(null);
  const dragRef = useRef(false);
  const placedRef = useRef(opportunities);
  const cardPreviewRef = useRef<Opportunity[] | null>(null);
  const cardDragRef = useRef(false);
  const boardRef = useRef<HTMLDivElement>(null);
  const saveChain = useRef(Promise.resolve());
  const saveGen = useRef(0);
  const [state, action, pending] = useActionState(saveOpportunityAction, {} as RecordActionState);
  if (stageSource !== stages && dragId === null) {
    setStageSource(stages);
    setOrdered(stages);
  }
  if (placedSource !== opportunities && cardDragId === null) {
    setPlacedSource(opportunities);
    setPlaced(opportunities);
  }
  const shown = preview ?? ordered;
  const boardCards = cardPreview ?? placed;

  useEffect(() => {
    if (!dragRef.current) orderedRef.current = ordered;
  }, [ordered]);

  useEffect(() => {
    if (!cardDragRef.current) placedRef.current = placed;
  }, [placed]);

  function enqueueStageSave(drafts: StageDraft[]) {
    const generation = ++saveGen.current;
    setSavingOrder(true);
    setBoardError(null);
    const run = saveChain.current.then(async () => {
      const result = await saveStagesAction(drafts);
      if (generation !== saveGen.current) return { stale: true as const };
      setSavingOrder(false);
      if (result.error) {
        setBoardError(result.error);
        return result;
      }
      router.refresh();
      return result;
    });
    saveChain.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function commitOrder(next: PipelineStage[], previous: PipelineStage[]) {
    if (next.every((stage, index) => stage.id === previous[index]?.id)) return;
    orderedRef.current = next;
    setOrdered(next);
    void enqueueStageSave(next.map(stageDraft)).then((result) => {
      if (!result || !("error" in result) || !result.error) return;
      orderedRef.current = previous;
      setOrdered(previous);
    });
  }

  function beginDrag(event: ReactPointerEvent<HTMLElement>, stageId: string) {
    if (event.button !== 0 || namingId || cardDragRef.current) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let active = false;
    let lastX = startX;
    let frame = 0;

    function columnNodes() {
      return [...document.querySelectorAll<HTMLElement>("[data-stage-column]")];
    }

    function indexAt(clientX: number) {
      const current = previewRef.current ?? orderedRef.current;
      const from = current.findIndex((stage) => stage.id === stageId);
      const nodes = columnNodes();
      let to = from;
      for (let index = 0; index < nodes.length; index += 1) {
        if (index === from) continue;
        const rect = nodes[index].getBoundingClientRect();
        const mid = rect.left + rect.width / 2;
        if (index < from && clientX < mid) return index;
        if (index > from && clientX > mid) to = index;
      }
      return to;
    }

    function applyIndex(clientX: number) {
      const current = previewRef.current ?? orderedRef.current;
      const nodes = columnNodes();
      const domMatches =
        nodes.length === current.length &&
        nodes.every((node, index) => node.dataset.stageId === current[index]?.id);
      if (!domMatches) return;
      const from = current.findIndex((stage) => stage.id === stageId);
      const to = indexAt(clientX);
      if (from < 0 || to === from) return;
      const next = reorderStages(current, from, to);
      previewRef.current = next;
      setPreview(next);
    }

    function tick() {
      if (!dragRef.current) return;
      const board = boardRef.current;
      if (board) {
        const rect = board.getBoundingClientRect();
        if (lastX > rect.right - 56) board.scrollLeft += 18;
        else if (lastX < rect.left + 56) board.scrollLeft -= 18;
      }
      applyIndex(lastX);
      frame = window.requestAnimationFrame(tick);
    }

    function onMove(move: PointerEvent) {
      lastX = move.clientX;
      if (!active) {
        if (Math.hypot(move.clientX - startX, move.clientY - startY) < 4) return;
        active = true;
        dragRef.current = true;
        previewRef.current = orderedRef.current.slice();
        setDragId(stageId);
        setPreview(previewRef.current);
        frame = window.requestAnimationFrame(tick);
      }
      applyIndex(move.clientX);
    }

    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.cancelAnimationFrame(frame);
      const next = previewRef.current;
      const previous = orderedRef.current;
      previewRef.current = null;
      dragRef.current = false;
      setDragId(null);
      setPreview(null);
      if (!active || !next) return;
      commitOrder(next, previous);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function stageAt(clientX: number, clientY: number) {
    const nodes = [...document.querySelectorAll<HTMLElement>("[data-stage-column]")];
    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      const inside =
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom;
      if (inside) return node.dataset.stageId ?? null;
    }
    let nearest: { id: string; distance: number } | null = null;
    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      if (clientY < rect.top - 24 || clientY > rect.bottom + 24) continue;
      const distance = Math.abs(clientX - (rect.left + rect.width / 2));
      const id = node.dataset.stageId;
      if (!id) continue;
      if (!nearest || distance < nearest.distance) nearest = { id, distance };
    }
    return nearest?.id ?? null;
  }

  function beginCardDrag(event: ReactPointerEvent<HTMLElement>, opportunityId: string) {
    if (event.button !== 0 || dragRef.current || cardDragRef.current) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let active = false;
    let lastX = startX;
    let lastY = startY;
    let frame = 0;

    function applyPoint(clientX: number, clientY: number) {
      const target = stageAt(clientX, clientY);
      setDropStageId(target);
      if (!target) return;
      const current = cardPreviewRef.current ?? placedRef.current;
      const next = placeOpportunity(current, orderedRef.current, opportunityId, target);
      if (!next || next === current) return;
      cardPreviewRef.current = next;
      setCardPreview(next);
    }

    function tick() {
      if (!cardDragRef.current) return;
      const board = boardRef.current;
      if (board) {
        const rect = board.getBoundingClientRect();
        if (lastX > rect.right - 56) board.scrollLeft += 18;
        else if (lastX < rect.left + 56) board.scrollLeft -= 18;
      }
      applyPoint(lastX, lastY);
      frame = window.requestAnimationFrame(tick);
    }

    function onMove(move: PointerEvent) {
      lastX = move.clientX;
      lastY = move.clientY;
      if (!active) {
        if (Math.hypot(move.clientX - startX, move.clientY - startY) < 4) return;
        active = true;
        cardDragRef.current = true;
        cardPreviewRef.current = placedRef.current.slice();
        setCardDragId(opportunityId);
        setCardPreview(cardPreviewRef.current);
        frame = window.requestAnimationFrame(tick);
      }
      applyPoint(move.clientX, move.clientY);
    }

    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.cancelAnimationFrame(frame);
      const preview = cardPreviewRef.current;
      const previous = placedRef.current;
      cardPreviewRef.current = null;
      cardDragRef.current = false;
      setCardDragId(null);
      setDropStageId(null);
      setCardPreview(null);
      if (!active) {
        const opportunity = previous.find((item) => item.id === opportunityId);
        if (opportunity) {
          setEditing(opportunity);
          setOpen(true);
        }
        return;
      }
      const moved = preview?.find((item) => item.id === opportunityId);
      const before = previous.find((item) => item.id === opportunityId);
      if (!moved?.stageId || !before || moved.stageId === before.stageId || !preview) return;
      placedRef.current = preview;
      setPlaced(preview);
      void moveOpportunityStageAction(opportunityId, moved.stageId).then((result) => {
        if (!result.error) {
          router.refresh();
          return;
        }
        placedRef.current = previous;
        setPlaced(previous);
        setBoardError(result.error);
      });
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function moveCard(opportunityId: string, direction: -1 | 1) {
    if (dragRef.current || cardDragRef.current) return;
    const current = placedRef.current;
    const opportunity = current.find((item) => item.id === opportunityId);
    if (!opportunity) return;
    const index = orderedRef.current.findIndex((stage) => stage.id === opportunity.stageId);
    const target = orderedRef.current[index + direction];
    if (!target) return;
    const next = placeOpportunity(current, orderedRef.current, opportunityId, target.id);
    if (!next || next === current) return;
    placedRef.current = next;
    setPlaced(next);
    setBoardError(null);
    void moveOpportunityStageAction(opportunityId, target.id).then((result) => {
      if (!result.error) {
        router.refresh();
        return;
      }
      placedRef.current = current;
      setPlaced(current);
      setBoardError(result.error);
    });
  }

  function moveStage(stageId: string, direction: -1 | 1) {
    if (dragRef.current) return;
    const current = orderedRef.current;
    const from = current.findIndex((stage) => stage.id === stageId);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= current.length) return;
    commitOrder(reorderStages(current, from, to), current);
  }

  async function insertStage(index: number) {
    const current = orderedRef.current;
    if (adding || dragRef.current || current.length >= 20) return;
    setAdding(true);
    const name = unusedStageName(current);
    const drafts = current.map(stageDraft);
    drafts.splice(index, 0, {
      name,
      probability: probabilityAt(current, index),
      isWon: false,
      isLost: false,
    });
    const result = await enqueueStageSave(drafts);
    setAdding(false);
    if (!result || !("stages" in result)) return;
    const created = result.stages?.find((stage) => stage.name === name);
    setNamingId(created?.id ?? null);
  }

  async function renameStage(stage: PipelineStage, value: string) {
    const name = value.trim();
    setNamingId(null);
    if (!name || name === stage.name) return;
    await enqueueStageSave(
      orderedRef.current.map((item) => stageDraft({ ...item, name: item.id === stage.id ? name : item.name })),
    );
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
          ref={boardRef}
          className="flex min-h-0 flex-1 items-stretch overflow-auto px-4 pb-4"
          onMouseLeave={() => setHovered(null)}
        >
          {shown.map((stage, index) => {
            const cards = boardCards.filter((opportunity) => opportunity.stageId === stage.id);
            return (
              <div
                key={stage.id}
                className="flex shrink-0 items-stretch"
                onMouseEnter={() => setHovered(index)}
              >
                {index > 0 && (
                  <StageInsert
                    label={`Add a stage between ${shown[index - 1]?.name} and ${stage.name}`}
                    shown={dragId === null && (hovered === index - 1 || hovered === index)}
                    disabled={adding || savingOrder || shown.length >= 20}
                    onAdd={() => insertStage(index)}
                    onHover={() => setHovered(index)}
                  />
                )}
                <section
                  data-stage-column=""
                  data-stage-id={stage.id}
                  onPointerDown={(event) => {
                    const target = event.target;
                    if (!(target instanceof Element)) return;
                    if (target.closest("input, textarea, a, label, [data-opportunity]")) return;
                    beginDrag(event, stage.id);
                  }}
                  className={cn(
                    "border-sidebar-border bg-sidebar-accent flex w-64 cursor-grab touch-none flex-col gap-2 rounded-xl border p-3 select-none",
                    dragId === stage.id && "cursor-grabbing opacity-70 ring-1 ring-white/15",
                    cardDragId && dropStageId === stage.id && "ring-1 ring-white/25",
                  )}
                >
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
                    <h2 className="text-[14px] leading-5">
                      <button
                        type="button"
                        className="cursor-grab rounded-sm border-0 bg-transparent p-0 text-left font-normal text-inherit select-none focus-visible:ring-2 focus-visible:ring-ring/60"
                        aria-label={`Reorder ${stage.name}`}
                        aria-keyshortcuts="ArrowLeft ArrowRight"
                        onKeyDown={(event) => {
                          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                          event.preventDefault();
                          moveStage(stage.id, event.key === "ArrowLeft" ? -1 : 1);
                        }}
                      >
                        {stage.name}
                      </button>
                    </h2>
                  )}
                  <p className="caption-style text-subtle">{cards.length}</p>
                  {cards.map((opportunity) => (
                    <div
                      key={opportunity.id}
                      data-opportunity=""
                      tabIndex={0}
                      aria-label={`${opportunity.name}, ${stage.name}`}
                      aria-keyshortcuts="ArrowLeft ArrowRight"
                      onPointerDown={(event) => beginCardDrag(event, opportunity.id)}
                      onKeyDown={(event) => {
                        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                        event.preventDefault();
                        moveCard(opportunity.id, event.key === "ArrowLeft" ? -1 : 1);
                      }}
                      className={cn(
                        "border-border bg-card flex cursor-grab touch-none flex-col gap-2 rounded-lg border p-3 focus-visible:ring-2 focus-visible:ring-ring/60",
                        cardDragId === opportunity.id && "cursor-grabbing opacity-70",
                      )}
                    >
                      <span className="text-[14px] leading-5">{opportunity.name}</span>
                      <span className="caption-style text-subtle">
                        {opportunity.companyName ?? "No company"} · {formatMoney(opportunity.value, opportunity.currency)}
                      </span>
                    </div>
                  ))}
                </section>
              </div>
            );
          })}
          <div className="flex shrink-0" onMouseEnter={() => setHovered(shown.length)}>
            <StageInsert
              label="Add a stage at the end"
              shown={dragId === null && (hovered === shown.length - 1 || hovered === shown.length)}
              disabled={adding || savingOrder || shown.length >= 20}
              onAdd={() => insertStage(shown.length)}
              onHover={() => setHovered(shown.length)}
            />
          </div>
        </div>
      ) : (
      <RecordList count={opportunities.length} empty="No opportunities yet.">
        {opportunities.map((opportunity) => (
          <RecordRow
            key={opportunity.id}
            mark={<Monogram name={opportunity.companyName || opportunity.name} />}
            title={opportunity.name}
            meta={`${opportunity.stageName ?? "No stage"} · ${formatMoney(opportunity.value, opportunity.currency)}`}
            onClick={() => {
              setEditing(opportunity);
              setOpen(true);
            }}
            action={
              <span className="flex items-center gap-2">
                {opportunity.companyName && opportunity.companyId ? (
                  <EntityChip name={opportunity.companyName} href={`/?record=${opportunity.companyId}`} />
                ) : null}
                <Tag tone={opportunity.status === "won" ? "green" : opportunity.status === "lost" ? "red" : "blue"}>
                  {opportunity.status}
                </Tag>
              </span>
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
                defaultValue={editing?.stageId ?? ordered[0]?.id ?? "none"}
              >
                <option value="none">Default stage</option>
                {ordered.map((stage) => (
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

function placeOpportunity(
  opportunities: Opportunity[],
  stages: PipelineStage[],
  id: string,
  stageId: string,
) {
  const stage = stages.find((item) => item.id === stageId);
  const current = opportunities.find((item) => item.id === id);
  if (!stage || !current || current.stageId === stageId) return opportunities;
  const status: OpportunityStatus = stage.isWon ? "won" : stage.isLost ? "lost" : "open";
  return opportunities.map((item) =>
    item.id === id
      ? {
          ...item,
          stageId,
          stageName: stage.name,
          pipelineId: stage.pipelineId,
          status,
        }
      : item,
  );
}

function reorderStages(stages: PipelineStage[], from: number, to: number) {
  const next = stages.slice();
  const [stage] = next.splice(from, 1);
  next.splice(to, 0, stage);
  return next;
}

function stageDraft(stage: PipelineStage): StageDraft {
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
