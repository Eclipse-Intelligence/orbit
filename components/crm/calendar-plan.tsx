"use client";

import { Fragment } from "react";
import Button from "@/components/_ui/button";
import Switch from "@/components/_ui/switch";
import Tag from "@/components/_ui/tag";
import TaskKindIcon from "@/components/crm/task-kind-icon";
import { dateKey } from "@/lib/calendar-view";
import { clockLabel, durationLabel } from "@/lib/crm/task-time";
import {
  missDayLabel,
  previewDayLabel,
  previewRuns,
  previewSummary,
  runHeading,
  wasLabel,
  whenLabel,
  type PlanPreview,
  type PreviewEntry,
} from "@/lib/plan-preview";
import { cn } from "@/lib/utils";
import SparkleIcon from "@/public/assets/images/assistant/sparkle.svg";
import ChevronRightIcon from "@/public/assets/images/_common/chevron-right.svg";
import CloseIcon from "@/public/assets/images/mail/close.svg";

export type PlanPanelHandlers = {
  onRemove: (taskId: string) => void;
  onMoveOverdue: (taskId: string) => void;
  onMoveAll: () => void;
  onLeaveOverdue: (taskId: string) => void;
  onUndoOverdue: (taskId: string) => void;
  onMiss: (taskId: string, choice: "next" | "outside" | "leave") => void;
  onUndoMiss: (taskId: string) => void;
  onReplan: (value: boolean) => void;
  onCancel: () => void;
  onApply: () => void;
};

const GROUP_HEADING = "flex items-center gap-1.5 px-2 pt-4 pb-1.5 text-[12px] leading-4 font-medium";
const CARD = "border-border flex flex-col gap-2 rounded-lg border px-2.5 py-2";

function EntryRow({ entry, onRemove }: { entry: PreviewEntry; onRemove: (taskId: string) => void }) {
  return (
    <li className="group/row flex min-h-8 items-center gap-2 rounded-md px-2 hover:bg-white/4" data-plan-entry={entry.taskId}>
      <span className="caption-style text-subtle w-10 shrink-0 tabular-nums">{clockLabel(entry.at)}</span>
      <TaskKindIcon title={entry.title} className="text-subtle size-3.5 shrink-0" />
      <span className="ui-style min-w-0 flex-1 truncate">{entry.title}</span>
      {entry.suggested ? (
        <span className="text-violet flex shrink-0 items-center gap-1 text-[12px] leading-4 tabular-nums" title="Suggested duration">
          <SparkleIcon aria-hidden className="size-2.5" />
          {durationLabel(entry.durationMinutes)}
        </span>
      ) : (
        <span className="caption-style text-subtle shrink-0 tabular-nums">{durationLabel(entry.durationMinutes)}</span>
      )}
      <Button variant="ghost" size="icon-sm" className="hit" aria-label={`Remove ${entry.title} from the plan`} onClick={() => onRemove(entry.taskId)}>
        <CloseIcon aria-hidden className="size-3" />
      </Button>
    </li>
  );
}

function PlacedList({ preview, today, onRemove }: { preview: PlanPreview; today: string; onRemove: (taskId: string) => void }) {
  const runs = previewRuns(preview.entries);
  const runStarts = new Map(runs.map((run) => [run.startsAt, run]));
  const days = new Map<string, PreviewEntry[]>();
  for (const entry of preview.entries) {
    const day = dateKey(entry.at);
    days.set(day, [...(days.get(day) ?? []), entry]);
  }
  return (
    <>
      {[...days.entries()].map(([day, entries]) => (
        <section key={day} aria-label={previewDayLabel(day, today)}>
          <h4 className="eyebrow-style text-subtle px-2 pt-3 pb-1">{previewDayLabel(day, today)}</h4>
          <ul className="flex flex-col">
            {entries.map((entry) => {
              const run = runStarts.get(entry.at);
              return (
                <Fragment key={entry.taskId}>
                  {run && run.group === entry.group && (
                    <li aria-hidden className="text-violet flex items-center gap-1.5 px-2 pt-1 text-[11.5px] leading-4">
                      <TaskKindIcon title={run.group === "call" ? "Call" : "Email"} className="size-3" />
                      {runHeading(run)}
                    </li>
                  )}
                  <EntryRow entry={entry} onRemove={onRemove} />
                </Fragment>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );
}

export default function PlanPanel({
  preview,
  today,
  loading,
  applying,
  replan,
  error,
  handlers,
}: {
  preview: PlanPreview | null;
  today: string;
  loading: boolean;
  applying: boolean;
  replan: boolean;
  error: string | null;
  handlers: PlanPanelHandlers;
}) {
  const proposal = preview?.proposal ?? null;
  const overdue = proposal ? proposal.overdue.filter((item) => preview!.overdue[item.taskId] !== "leave") : [];
  const unplaced = proposal ? proposal.unplaced.filter((item) => preview!.unplaced[item.taskId] !== "leave") : [];
  const movable = overdue.filter((item) => item.at && preview!.overdue[item.taskId] !== "move");
  return (
    <aside
      aria-label="Plan"
      data-plan-panel=""
      data-quick-add-hide=""
      data-task-drop=""
      className="border-border bg-background hidden w-[320px] shrink-0 flex-col border-l md:flex lg:w-[372px]"
    >
      <div className="border-border flex items-center gap-2 border-b py-2.5 pr-3 pl-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <h3>Plan</h3>
            <Tag tone="purple" size="sm" className="h-5 text-[12px]">
              Preview
            </Tag>
          </div>
          <p className="caption-style text-subtle truncate">
            {proposal ? `Today to ${previewDayLabel(proposal.to, today)} · nothing changes until Apply` : "Today and the next 14 days"}
          </p>
        </div>
        <Button variant="ghost" size="icon" className="hit" aria-label="Cancel plan" onClick={handlers.onCancel}>
          <CloseIcon aria-hidden className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-3">
        {loading && (
          <p role="status" className="caption-style text-subtle px-2 pt-4">
            Planning…
          </p>
        )}
        {error && (
          <p role="alert" className="caption-style text-danger px-2 pt-3">
            {error}
          </p>
        )}
        {preview && !loading && (
          <>
            {proposal!.reason && (
              <p className="mx-2 mt-2.5 flex items-start gap-2 rounded-[10px] bg-[color-mix(in_srgb,var(--violet)_9%,transparent)] px-2.5 py-2 text-[12.5px] leading-[18px] text-[#d9d5ff]">
                <SparkleIcon aria-hidden className="text-violet mt-0.5 size-3.5 shrink-0" />
                <span>{proposal!.reason}</span>
              </p>
            )}
            <h3 className={GROUP_HEADING}>
              Placed <span className="text-subtle font-normal tabular-nums">{preview.entries.length}</span>
            </h3>
            {preview.entries.length === 0 ? (
              <p className="caption-style text-subtle px-2">Nothing to place.</p>
            ) : (
              <PlacedList preview={preview} today={today} onRemove={handlers.onRemove} />
            )}
            {overdue.length > 0 && (
              <section aria-label="Overdue">
                <h3 className={cn(GROUP_HEADING, "text-danger")}>
                  Overdue <span className="font-normal tabular-nums">{overdue.length}</span>
                  {movable.length > 0 && (
                    <Button variant="secondary" size="sm" className="text-foreground ml-auto h-6 px-2.5 py-0" onClick={handlers.onMoveAll}>
                      Move all
                    </Button>
                  )}
                </h3>
                <ul className="flex flex-col gap-1.5 px-1">
                  {overdue.map((item) => {
                    const moving = preview.overdue[item.taskId] === "move";
                    return (
                      <li key={item.taskId} className={CARD} data-plan-overdue={item.taskId}>
                        <div className="flex min-w-0 items-center gap-2">
                          <span aria-hidden className="bg-danger flex size-4 shrink-0 items-center justify-center rounded-full text-white">
                            <CloseIcon className="size-2.5" />
                          </span>
                          <span className="ui-style min-w-0 flex-1 truncate">{item.title}</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="caption-style text-subtle tabular-nums">{wasLabel(item, today)}</span>
                          <ChevronRightIcon aria-hidden className="text-subtle size-3" />
                          <span className="caption-style text-soft tabular-nums">{item.at ? whenLabel(item.at, today) : "No free time"}</span>
                          <span className="flex-1" />
                          {moving ? (
                            <Button variant="ghost" size="sm" className="h-6 px-2.5 py-0" onClick={() => handlers.onUndoOverdue(item.taskId)}>
                              Undo
                            </Button>
                          ) : (
                            <>
                              {item.at && (
                                <Button variant="secondary" size="sm" className="h-6 px-2.5 py-0" onClick={() => handlers.onMoveOverdue(item.taskId)}>
                                  Move
                                </Button>
                              )}
                              <Button variant="ghost" size="sm" className="h-6 px-2.5 py-0" onClick={() => handlers.onLeaveOverdue(item.taskId)}>
                                Leave
                              </Button>
                            </>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
            {unplaced.length > 0 && (
              <section aria-label="Couldn't fit">
                <h3 className={GROUP_HEADING}>
                  Couldn&apos;t fit <span className="text-subtle font-normal tabular-nums">{unplaced.length}</span>
                </h3>
                <ul className="flex flex-col gap-1.5 px-1">
                  {unplaced.map((item) => {
                    const chosen = preview.unplaced[item.taskId];
                    const next = missDayLabel(item, today);
                    return (
                      <li key={item.taskId} className={CARD} data-plan-unplaced={item.taskId}>
                        <div className="flex min-w-0 items-center gap-2">
                          <TaskKindIcon title={item.title} className="text-subtle size-3.5 shrink-0" />
                          <span className="ui-style min-w-0 flex-1 truncate">{item.title}</span>
                          <span className="caption-style text-faint shrink-0 tabular-nums">{durationLabel(item.durationMinutes)}</span>
                        </div>
                        <p className="caption-style text-subtle">{chosen === "next" || chosen === "outside" ? `Moves to ${whenLabel((chosen === "next" ? item.nextFree : item.outside)!, today)}` : item.reason}</p>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {chosen === "next" || chosen === "outside" ? (
                            <Button variant="ghost" size="sm" className="h-6 px-2.5 py-0" onClick={() => handlers.onUndoMiss(item.taskId)}>
                              Undo
                            </Button>
                          ) : (
                            <>
                              {item.nextFree && next && (
                                <Button variant="secondary" size="sm" className="h-6 px-2.5 py-0" onClick={() => handlers.onMiss(item.taskId, "next")}>
                                  Next free day <span className="text-subtle font-normal tabular-nums">{next}</span>
                                </Button>
                              )}
                              {item.outside && (
                                <Button variant="secondary" size="sm" className="h-6 px-2.5 py-0" onClick={() => handlers.onMiss(item.taskId, "outside")}>
                                  Outside hours
                                </Button>
                              )}
                              <Button variant="ghost" size="sm" className="h-6 px-2.5 py-0" onClick={() => handlers.onMiss(item.taskId, "leave")}>
                                Leave
                              </Button>
                            </>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
      <div className="border-border flex flex-col gap-2.5 border-t px-4 pt-3 pb-3.5">
        <div className="flex items-start gap-2.5">
          <Switch className="hit mt-px" checked={replan} disabled={loading || applying} label="Replan my blocks" onChange={handlers.onReplan} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="ui-style font-medium">Replan my blocks</span>
            <span className="caption-style text-subtle">Moves blocks Plan placed before, on the same day. Blocks you placed stay.</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="caption-style text-subtle min-w-0 flex-1 truncate tabular-nums">{preview ? previewSummary(preview) : ""}</span>
          <Button variant="secondary" size="sm" onClick={handlers.onCancel} disabled={applying}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={handlers.onApply} disabled={!preview || loading || applying || preview.entries.length === 0}>
            {applying ? "Applying…" : "Apply"}
          </Button>
        </div>
      </div>
    </aside>
  );
}
