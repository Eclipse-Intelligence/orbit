"use client";

import {
  useActionState,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { DatePicker } from "@/components/_ui/date-picker";
import { Input } from "@/components/_ui/input";
import { cn } from "@/lib/utils";
import PlusIcon from "@/public/assets/images/_common/plus.svg";
import Tag from "@/components/_ui/tag";
import {
  Sheet,
  SheetCloseButton,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/_ui/sheet";
import { EntityChip, HealthMark, Monogram } from "@/components/beautifui/record-marks";
import Pager from "@/components/crm/pager";
import RecordTransfer from "@/components/crm/record-transfer";
import SectionHeader from "@/components/crm/section-header";
import KeyboardList from "@/components/shortcuts/keyboard-list";
import ListSearch from "@/components/shortcuts/list-search";
import { RecordList, RecordRow, RecordSelect } from "@/components/crm/record-form";
import type { Viewer } from "@/components/crm/viewer";
import BoardCardContext from "@/components/crm/board-card-context";
import CompanyContactFields from "@/components/crm/company-contact-fields";
import OpportunityComposer from "@/components/crm/opportunity-composer";
import type { PickedRecord } from "@/components/crm/record-picker";
import BoardSettings from "@/components/crm/board-settings";
import { removeCardAction, updateBoardAction } from "@/app/(crm)/boards";
import { moveOpportunityStageAction, saveOpportunityAction, type RecordActionState } from "@/app/(crm)/records";
import { saveStagesAction } from "@/app/(crm)/settings/actions";
import type { StageDraft } from "@/lib/crm/pipeline";
import { formatMoney } from "@/lib/companies";
import { formatDateLabel } from "@/lib/date-input";
import { startPointerGesture, type GestureResult } from "@/lib/pointer-gesture";
import { companyHref, dealHref } from "@/lib/crm/hrefs";
import type { Board, Opportunity, OpportunityStatus, PipelineStage } from "@/lib/crm/types";
import Link from "next/link";
import { statusTag } from "@/components/proposals/status";
import type { DealProposal } from "@/lib/proposals/documents";
import HoldButton from "@/components/_ui/hold-button";

export default function OpportunitiesScreen({
  viewer,
  opportunities,
  total,
  page,
  query,
  stages,
  view,
  board,
  proposals = {},
}: {
  viewer: Viewer;
  proposals?: Record<string, DealProposal>;
  opportunities: Opportunity[];
  total: number;
  page: number;
  query: string;
  stages: PipelineStage[];
  view: "list" | "board";
  board?: Board;
}) {
  const router = useRouter();
  const basePath = board ? `/boards/${board.id}` : "/opportunities";
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Opportunity | null>(null);
  const [session, setSession] = useState(0);
  const close = useCallback(() => setOpen(false), []);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [composerStage, setComposerStage] = useState<string | null>(null);
  const closeComposer = useCallback(() => setComposerStage(null), []);
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
      const result = await saveStagesAction(drafts, board?.id ?? null);
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
    let lastX = event.clientX;
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

    startPointerGesture(event, {
      start() {
        dragRef.current = true;
        previewRef.current = orderedRef.current.slice();
        setDragId(stageId);
        setPreview(previewRef.current);
        frame = window.requestAnimationFrame(tick);
      },
      move(clientX) {
        lastX = clientX;
        applyIndex(clientX);
      },
      end(result) {
        window.cancelAnimationFrame(frame);
        const next = previewRef.current;
        const previous = orderedRef.current;
        previewRef.current = null;
        dragRef.current = false;
        setDragId(null);
        setPreview(null);
        if (result !== "drop" || !next) return;
        commitOrder(next, previous);
      },
    });
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
    let lastX = event.clientX;
    let lastY = event.clientY;
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

    function finish(result: GestureResult) {
      window.cancelAnimationFrame(frame);
      const preview = cardPreviewRef.current;
      const previous = placedRef.current;
      cardPreviewRef.current = null;
      cardDragRef.current = false;
      setCardDragId(null);
      setDropStageId(null);
      setCardPreview(null);
      if (result === "tap") {
        const opportunity = previous.find((item) => item.id === opportunityId);
        if (opportunity) openCard(opportunity);
        return;
      }
      if (result !== "drop") return;
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

    startPointerGesture(event, {
      start() {
        cardDragRef.current = true;
        cardPreviewRef.current = placedRef.current.slice();
        setCardDragId(opportunityId);
        setCardPreview(cardPreviewRef.current);
        frame = window.requestAnimationFrame(tick);
      },
      move(clientX, clientY) {
        lastX = clientX;
        lastY = clientY;
        applyPoint(clientX, clientY);
      },
      end: finish,
    });
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
  function startAdding() {
    if (view === "board") {
      const first = ordered.find((stage) => !stage.isWon && !stage.isLost) ?? ordered[0];
      if (first) setComposerStage(first.id);
      return;
    }
    const input = document.getElementById("list-add-company");
    input?.scrollIntoView({ block: "center" });
    input?.focus();
  }

  function edit(opportunity: Opportunity) {
    setEditing(opportunity);
    setSession((current) => current + 1);
    setOpen(true);
  }

  function openCard(opportunity: Opportunity) {
    if (board) edit(opportunity);
    else router.push(dealHref(opportunity.id));
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader
        title={board?.name ?? "Opportunities"}
        viewer={viewer}
        heading={board ? <BoardTitle key={board.name} board={board} /> : undefined}
        action={
          <div className="flex items-center gap-1">
            <Button
              variant={view === "list" ? "secondary" : "ghost"}
              size="sm"
              href={board ? `${basePath}?view=list` : basePath}
              data-shortcut={view === "list" ? undefined : "toggle-view"}
              title="List (V)"
            >
              List
            </Button>
            <Button
              variant={view === "board" ? "secondary" : "ghost"}
              size="sm"
              href={board ? basePath : `${basePath}?view=board`}
              data-shortcut={view === "board" ? undefined : "toggle-view"}
              title="Board (V)"
            >
              Board
            </Button>
            {board ? (
              <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)}>
                Settings
              </Button>
            ) : (
              <RecordTransfer resource="opportunities" />
            )}
            <Button
              variant="primary"
              size="sm"
              data-shortcut="add-record"
              title={board ? "Add a company (C then P)" : "Add opportunity (C then P)"}
              shortcut={["C", "P"]}
              onClick={startAdding}
            >
              {board ? "Add company" : "Add opportunity"}
            </Button>
          </div>
        }
      />
      <div className="flex items-center gap-2 px-4 py-4">
        <ListSearch noun={board ? "companies" : "opportunities"} />
      </div>
      <p className="caption-style text-subtle px-4 pb-2">
        {total} {board ? (total === 1 ? "company" : "companies") : total === 1 ? "opportunity" : "opportunities"}
      </p>
      {boardError && view === "board" && (
        <p role="alert" className="caption-style text-danger px-4 pb-2">
          {boardError}
        </p>
      )}
      {view === "board" ? (
        <div
          ref={boardRef}
          className="flex min-h-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden overscroll-x-contain px-4 pb-4"
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
                    if (target.closest("input, textarea, a, label, [data-opportunity], [data-composer]")) return;
                    beginDrag(event, stage.id);
                  }}
                  className={cn(
                    "border-sidebar-border bg-sidebar-accent flex min-h-0 w-64 cursor-grab flex-col gap-2 rounded-xl border p-3 select-none [-webkit-touch-callout:none]",
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
                        aria-keyshortcuts="Shift+ArrowLeft Shift+ArrowRight"
                        data-stage-button={stage.id}
                        title="Double-click to rename"
                        onDoubleClick={() => setNamingId(stage.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === "F2") {
                            event.preventDefault();
                            setNamingId(stage.id);
                            return;
                          }
                          if (event.key === "ArrowDown") {
                            event.preventDefault();
                            focusBoardCard(stage.id, 0);
                            return;
                          }
                          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                          event.preventDefault();
                          const direction = event.key === "ArrowLeft" ? -1 : 1;
                          if (event.shiftKey) {
                            moveStage(stage.id, direction);
                            window.requestAnimationFrame(() => focusStageButton(stage.id));
                            return;
                          }
                          focusAdjacentStage(stage.id, direction);
                        }}
                      >
                        {stage.name}
                      </button>
                    </h2>
                  )}
                  <p className="caption-style text-subtle">{cards.length}</p>
                  <div
                    data-stage-cards=""
                    className="relative -mx-1 flex min-h-0 flex-1 cursor-default flex-col gap-2 overflow-y-auto overscroll-y-contain px-1 pb-1"
                    onClick={(event) => {
                      if (event.target === event.currentTarget && !stage.isWon && !stage.isLost) setComposerStage(stage.id);
                    }}
                  >
                    {cards.map((opportunity) => (
                      <div
                        key={opportunity.id}
                        data-opportunity=""
                        data-opportunity-id={opportunity.id}
                        tabIndex={0}
                        aria-label={`${opportunity.name}, ${stage.name}`}
                        aria-keyshortcuts="Enter Shift+ArrowLeft Shift+ArrowRight"
                        onPointerDown={(event) => beginCardDrag(event, opportunity.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            openCard(opportunity);
                            return;
                          }
                          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                            event.preventDefault();
                            focusCardInColumn(event.currentTarget, event.key === "ArrowUp" ? -1 : 1);
                            return;
                          }
                          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                          event.preventDefault();
                          const direction = event.key === "ArrowLeft" ? -1 : 1;
                          if (event.shiftKey) {
                            moveCard(opportunity.id, direction);
                            window.requestAnimationFrame(() =>
                              document.querySelector<HTMLElement>(`[data-opportunity-id="${opportunity.id}"]`)?.focus(),
                            );
                            return;
                          }
                          focusAdjacentColumnCard(event.currentTarget, direction);
                        }}
                        className={cn(
                          "border-border bg-card flex shrink-0 cursor-grab flex-col gap-2 rounded-lg border p-3 select-none focus-visible:ring-2 focus-visible:ring-ring/60 [-webkit-touch-callout:none]",
                          cardDragId === opportunity.id && "cursor-grabbing opacity-70",
                        )}
                      >
                        <span className="flex items-start justify-between gap-2">
                          <span className="min-w-0 text-[14px] leading-5">{board ? (opportunity.companyName ?? opportunity.name) : opportunity.name}</span>
                          {opportunity.companyHealth && <HealthMark health={opportunity.companyHealth} />}
                        </span>
                        <span className="caption-style text-subtle">
                          {board
                            ? cardMeta(opportunity) || "No contact"
                            : `${opportunity.companyName ?? "No company"} · ${formatMoney(opportunity.value, opportunity.currency)}`}
                        </span>
                        {!board && proposals[opportunity.id] && (
                          <span className="caption-style text-subtle">Proposal: {statusTag(proposals[opportunity.id].status).label}</span>
                        )}
                      </div>
                    ))}
                    {composerStage === stage.id ? (
                      <div data-composer="">
                        <OpportunityComposer
                          key={stage.id}
                          id={`compose-${stage.id}`}
                          board={board ?? null}
                          stages={ordered}
                          stageId={stage.id}
                          layout="card"
                          autoFocus
                          onClose={closeComposer}
                        />
                      </div>
                    ) : (
                      !stage.isWon &&
                      !stage.isLost && (
                        <button
                          type="button"
                          data-composer=""
                          onClick={() => setComposerStage(stage.id)}
                          className="text-subtle hover:text-foreground focus-visible:ring-ring/60 flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-left text-[13px] leading-5 outline-none hover:bg-white/5 focus-visible:ring-2"
                        >
                          <PlusIcon aria-hidden className="size-3" />
                          {board ? "Add company" : "Add opportunity"}
                          <span className="sr-only"> to {stage.name}</span>
                        </button>
                      )
                    )}
                  </div>
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
      <KeyboardList className="flex min-h-0 flex-1 flex-col">
      <RecordList
        count={opportunities.length}
        footer={<OpportunityComposer id="list-add" board={board ?? null} stages={ordered} layout="row" />}
        empty={
          board
            ? query
              ? "No companies match the search."
              : `Nothing on ${board.name} yet.`
            : query
              ? "No opportunities match the search."
              : "No opportunities yet."
        }
      >
        {opportunities.map((opportunity) =>
          board ? (
            <RecordRow
              key={opportunity.id}
              mark={<Monogram name={opportunity.companyName || opportunity.name} />}
              title={opportunity.companyName ?? opportunity.name}
              meta={[opportunity.stageName ?? "No stage", cardMeta(opportunity)].filter(Boolean).join(" · ")}
              onClick={() => edit(opportunity)}
              action={opportunity.companyHealth ? <HealthMark health={opportunity.companyHealth} /> : undefined}
            />
          ) : (
          <RecordRow
            key={opportunity.id}
            mark={<Monogram name={opportunity.companyName || opportunity.name} />}
            title={opportunity.name}
            meta={`${opportunity.stageName ?? "No stage"} · ${formatMoney(opportunity.value, opportunity.currency)}`}
            href={dealHref(opportunity.id)}
            action={
              <span className="flex items-center gap-2">
                {proposals[opportunity.id] ? (
                  <Link
                    href={proposals[opportunity.id].href}
                    onClick={(event) => event.stopPropagation()}
                    title={`Proposal: ${proposals[opportunity.id].title}`}
                    className="hidden rounded-full sm:inline-flex"
                  >
                    <Tag tone={statusTag(proposals[opportunity.id].status).tone}>Proposal {statusTag(proposals[opportunity.id].status).label.toLowerCase()}</Tag>
                  </Link>
                ) : null}
                {opportunity.companyName && opportunity.companyId ? (
                  <EntityChip name={opportunity.companyName} href={companyHref(opportunity.companyId)} />
                ) : null}
                <Tag tone={opportunity.status === "won" ? "green" : opportunity.status === "lost" ? "red" : "blue"}>
                  {opportunity.status === "won" ? "Won" : opportunity.status === "lost" ? "Lost" : "Open"}
                </Tag>
              </span>
            }
          />
          ),
        )}
      </RecordList>
      </KeyboardList>
      )}
      <Pager
        page={page}
        count={opportunities.length}
        total={total}
        noun={board ? ["company", "companies"] : ["opportunity", "opportunities"]}
      />
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="sm:w-[480px] sm:max-w-[480px]">
          <SheetHeader>
            <SheetTitle>
              {board ? (editing?.companyName ?? editing?.name) : "Edit opportunity"}
            </SheetTitle>
            <SheetDescription className="sr-only">{board ? "Card details" : "Opportunity details"}</SheetDescription>
            <SheetCloseButton />
          </SheetHeader>
          {board ? (
            <BoardCardEditor
              key={`${editing?.id ?? "new"}-${session}`}
              board={board}
              editing={editing}
              stages={ordered}
              onClose={close}
            />
          ) : (
            <OpportunityEditor
              key={`${editing?.id ?? "new"}-${session}`}
              editing={editing}
              stages={ordered}
              onClose={close}
            />
          )}
        </SheetContent>
      </Sheet>
      {board && (
        <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
          <SheetContent side="right" className="sm:w-[480px] sm:max-w-[480px]">
            <SheetHeader>
              <SheetTitle>Board settings</SheetTitle>
              <SheetDescription className="sr-only">Name, stages and automation for {board.name}</SheetDescription>
              <SheetCloseButton />
            </SheetHeader>
            {settingsOpen && (
              <BoardSettings
                board={{ ...board, stages: ordered }}
                count={total}
                onClose={() => setSettingsOpen(false)}
              />
            )}
          </SheetContent>
        </Sheet>
      )}
    </section>
  );
}

function pickedCompany(editing: Opportunity | null): PickedRecord | null {
  return editing?.companyId ? { id: editing.companyId, name: editing.companyName ?? editing.name } : null;
}

function pickedContact(editing: Opportunity | null): PickedRecord | null {
  if (!editing?.primaryContactId) return null;
  return { id: editing.primaryContactId, name: editing.primaryContactName ?? "Current contact", company: pickedCompany(editing) };
}

function OpportunityEditor({
  editing,
  stages,
  onClose,
}: {
  editing: Opportunity | null;
  stages: PipelineStage[];
  onClose: () => void;
}) {
  const [state, action, pending] = useActionState(saveOpportunityAction, {} as RecordActionState);
  const [hasCompany, setHasCompany] = useState(Boolean(editing?.companyId));
  useEffect(() => {
    if (state.ok) onClose();
  }, [state, onClose]);

  return (
    <form action={action} className="flex min-h-0 flex-1 flex-col">
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
        <CompanyContactFields
          idPrefix="opp"
          initialCompany={pickedCompany(editing)}
          initialContact={pickedContact(editing)}
          contactLabel="Primary contact"
          onCompanyChange={(company) => setHasCompany(Boolean(company))}
        >
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
        </CompanyContactFields>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-2" htmlFor="opp-value">
            <span className="caption-style text-subtle">Value</span>
            <Input id="opp-value" name="value" inputMode="decimal" defaultValue={editing?.value ?? ""} />
          </label>
          <label className="flex flex-col gap-2" htmlFor="opp-currency">
            <span className="caption-style text-subtle">Currency</span>
            <Input id="opp-currency" name="currency" defaultValue={editing?.currency ?? "GBP"} maxLength={3} />
          </label>
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <label className="caption-style text-subtle" htmlFor="opp-close">
            Expected close
          </label>
          <DatePicker
            id="opp-close"
            name="expectedCloseDate"
            placeholder="Pick a close date"
            defaultValue={editing?.expectedCloseDate ?? ""}
          />
        </div>
        <label className="flex flex-col gap-2" htmlFor="opp-source">
          <span className="caption-style text-subtle">Source</span>
          <Input id="opp-source" name="source" defaultValue={editing?.source ?? ""} />
        </label>
      </div>
      <SheetFooter>
        <Button variant="subtle" size="sm" type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          type="submit"
          disabled={pending || !hasCompany}
          data-shortcut="save"
          title="Save (⌘S)"
        >
          {pending ? "Saving…" : "Save"}
        </Button>
      </SheetFooter>
    </form>
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

function boardColumns() {
  return [...document.querySelectorAll<HTMLElement>("[data-stage-column]")];
}

function columnCards(column: Element | null | undefined) {
  return column ? [...column.querySelectorAll<HTMLElement>("[data-opportunity]")] : [];
}

function focusBoardCard(stageId: string, index: number) {
  const column = document.querySelector(`[data-stage-column][data-stage-id="${stageId}"]`);
  const cards = columnCards(column);
  cards[Math.min(index, cards.length - 1)]?.focus();
}

function focusStageButton(stageId: string) {
  document.querySelector<HTMLElement>(`[data-stage-button="${stageId}"]`)?.focus();
}

function focusAdjacentStage(stageId: string, direction: -1 | 1) {
  const columns = boardColumns();
  const index = columns.findIndex((column) => column.dataset.stageId === stageId);
  const next = columns[index + direction]?.dataset.stageId;
  if (next) focusStageButton(next);
}

function focusCardInColumn(card: HTMLElement, direction: -1 | 1) {
  const cards = columnCards(card.closest("[data-stage-column]"));
  const index = cards.indexOf(card);
  const next = cards[index + direction];
  if (next) {
    next.focus();
    return;
  }
  if (direction < 0) {
    const stageId = card.closest<HTMLElement>("[data-stage-column]")?.dataset.stageId;
    if (stageId) focusStageButton(stageId);
  }
}

function focusAdjacentColumnCard(card: HTMLElement, direction: -1 | 1) {
  const columns = boardColumns();
  const column = card.closest<HTMLElement>("[data-stage-column]");
  const position = columnCards(column).indexOf(card);
  for (let index = columns.indexOf(column as HTMLElement) + direction; index >= 0 && index < columns.length; index += direction) {
    const cards = columnCards(columns[index]);
    if (cards.length > 0) {
      const next = cards[Math.min(position, cards.length - 1)];
      next.focus();
      next.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }
  }
}

function cardMeta(opportunity: Opportunity) {
  return [
    opportunity.primaryContactName,
    opportunity.expectedCloseDate ? `Due ${formatDateLabel(opportunity.expectedCloseDate)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function BoardTitle({ board }: { board: Board }) {
  const router = useRouter();
  const [naming, setNaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);

  async function save(value: string) {
    setNaming(false);
    const name = value.trim();
    if (cancelled.current || !name || name === board.name) {
      cancelled.current = false;
      return;
    }
    const result = await updateBoardAction(board.id, { name });
    if (result.error) {
      setError(result.error);
      return;
    }
    setError(null);
    router.refresh();
  }

  return (
    <div className="flex min-w-0 flex-col">
      {naming ? (
        <Input
          autoFocus
          aria-label="Board name"
          defaultValue={board.name}
          maxLength={120}
          className="h-8 max-w-xs"
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              cancelled.current = true;
              event.currentTarget.blur();
            }
          }}
          onBlur={(event) => save(event.currentTarget.value)}
        />
      ) : (
        <h1 className="truncate">
          <button
            type="button"
            title="Rename board"
            onClick={() => setNaming(true)}
            className="focus-visible:ring-ring/60 max-w-full cursor-text truncate rounded-sm border-0 bg-transparent p-0 text-left font-[inherit] text-inherit outline-none focus-visible:ring-2"
          >
            {board.name}
          </button>
        </h1>
      )}
      {error && (
        <span role="alert" className="caption-style text-danger truncate">
          {error}
        </span>
      )}
    </div>
  );
}

function BoardCardEditor({
  board,
  editing,
  stages,
  onClose,
}: {
  board: Board;
  editing: Opportunity | null;
  stages: PipelineStage[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState(saveOpportunityAction, {} as RecordActionState);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  useEffect(() => {
    if (state.ok) onClose();
  }, [state, onClose]);

  const [hasCompany, setHasCompany] = useState(Boolean(editing?.companyId));
  const formId = `board-card-${editing?.id ?? "new"}`;
  const error = removeError ?? (state.error && !state.ok ? state.error : null);

  async function remove() {
    if (!editing) return;
    setRemoving(true);
    const result = await removeCardAction(editing.id);
    setRemoving(false);
    if (result.error) {
      setRemoveError(result.error);
      return;
    }
    onClose();
    router.refresh();
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-6 overflow-auto p-5">
        <form id={formId} action={action} className="flex flex-col gap-4">
          <input type="hidden" name="id" value={editing?.id ?? ""} />
          <input type="hidden" name="pipelineId" value={board.id} />
          {editing && <input type="hidden" name="name" value={editing.name} />}
          {error && (
            <p role="alert" className="caption-style text-danger">
              {error}
            </p>
          )}
          <CompanyContactFields
            idPrefix="card"
            initialCompany={pickedCompany(editing)}
            initialContact={pickedContact(editing)}
            contactLabel="Main contact"
            onCompanyChange={(company) => setHasCompany(Boolean(company))}
          >
            <RecordSelect id="card-stage" name="stageId" label="Stage" defaultValue={editing?.stageId ?? stages[0]?.id ?? ""}>
              {stages.map((stage) => (
                <option key={stage.id} value={stage.id}>
                  {stage.name}
                </option>
              ))}
            </RecordSelect>
          </CompanyContactFields>
          <div className="flex min-w-0 flex-col gap-2">
            <label className="caption-style text-subtle" htmlFor="card-due">
              Due
            </label>
            <DatePicker id="card-due" name="expectedCloseDate" placeholder="Pick a due date" defaultValue={editing?.expectedCloseDate ?? ""} />
          </div>
        </form>
        {editing && <BoardCardContext companyId={editing.companyId} companyName={editing.companyName ?? editing.name} />}
      </div>
      <SheetFooter>
        {editing ? (
          <HoldButton disabled={removing} onConfirm={() => void remove()}>
            Hold to remove from board
          </HoldButton>
        ) : (
          <span />
        )}
        <span className="flex items-center gap-2">
          <Button variant="subtle" size="sm" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="submit"
            form={formId}
            disabled={pending || !hasCompany}
            data-shortcut="save"
            title="Save (⌘S)"
          >
            {pending ? "Saving…" : "Save"}
          </Button>
        </span>
      </SheetFooter>
    </div>
  );
}
