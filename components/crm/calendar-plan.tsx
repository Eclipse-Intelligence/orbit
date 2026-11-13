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

const GROUP = "ui-style flex items-center gap-1.5 px-2 pt-4 pb-1.5 font-medium";
const CARD = "border-border flex flex-col gap-2 rounded-lg border px-2.5 py-2";
const SMALL = "hit h-6 px-2.5 py-0 [@media(pointer:coarse)]:min-w-11";
const ACTIONS = "flex flex-wrap items-center gap-x-1.5 gap-y-2 [@media(pointer:coarse)]:gap-y-5";
const BUTTONS = "ml-auto flex flex-wrap items-center justify-end gap-1.5 [@media(pointer:coarse)]:gap-x-2.5 [@media(pointer:coarse)]:gap-y-5";

function EntryRow({ entry, clash, onRemove }: { entry: PreviewEntry; clash: string | null; onRemove: (taskId: string) => void }) {
  return (
    <li className="flex min-h-8 flex-col justify-center rounded-md px-2 hover:bg-white/4 [@media(pointer:coarse)]:min-h-11" data-plan-entry={entry.taskId}>
      <div className="flex items-center gap-2">
        <span className="caption-style text-subtle w-10 shrink-0 tabular-nums">{clockLabel(entry.at)}</span>
        <TaskKindIcon title={entry.title} className="text-subtle size-3.5 shrink-0" />
        <span className="ui-style min-w-0 flex-1 truncate">{entry.title}</span>
        {entry.suggested ? (
          <span className="caption-style text-violet flex shrink-0 items-center gap-1 tabular-nums" title="Suggested duration">
            <SparkleIcon aria-hidden className="size-2.5" />
            {durationLabel(entry.durationMinutes)}
          </span>
        ) : (
          <span className="caption-style text-subtle shrink-0 tabular-nums">{durationLabel(entry.durationMinutes)}</span>
        )}
        <Button variant="ghost" size="icon-sm" className="hit" aria-label={`Remove ${entry.title} from the plan`} onClick={() => onRemove(entry.taskId)}>
          <CloseIcon aria-hidden className="size-3" />
        </Button>
      </div>
      {clash && <span className="caption-style truncate pl-12 text-(--tag-amber-text)">Clashes with {clash}</span>}
    </li>
  );
}

function PlacedList({
  preview,
  today,
  clashes,
  onRemove,
}: {
  preview: PlanPreview;
  today: string;
  clashes: Record<string, string>;
  onRemove: (taskId: string) => void;
}) {
  const runStarts = new Map(previewRuns(preview.entries).map((run) => [run.startsAt, run]));
  const days = new Map<string, PreviewEntry[]>();
  for (const entry of preview.entries) {
    const day = dateKey(entry.at);
    days.set(day, [...(days.get(day) ?? []), entry]);
  }
  return (
    <>
      {[...days.entries()].map(([day, entries]) => (
        <section key={day} aria-label={previewDayLabel(day, today)}>
          <div className="eyebrow-style text-subtle px-2 pt-3 pb-1">{previewDayLabel(day, today)}</div>
          <ul className="flex flex-col">
            {entries.map((entry) => {
              const run = runStarts.get(entry.at);
              return (
                <Fragment key={entry.taskId}>
                  {run && run.group === entry.group && (
                    <li className="caption-style text-violet flex items-center gap-1.5 px-2 pt-1">
                      <TaskKindIcon title={run.group === "call" ? "Call" : "Email"} className="size-3" />
                      {runHeading(run)}
                    </li>
                  )}
                  <EntryRow entry={entry} clash={clashes[entry.taskId] ?? null} onRemove={onRemove} />
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
  clashes,
  handlers,
}: {
  preview: PlanPreview | null;
  today: string;
  loading: boolean;
  applying: boolean;
  replan: boolean;
  error: string | null;
  clashes: Record<string, string>;
  handlers: PlanPanelHandlers;
}) {
  const proposal = preview?.proposal ?? null;
  const overdue = proposal?.overdue ?? [];
  const unplaced = proposal?.unplaced ?? [];
  const movable = overdue.filter((item) => item.at && !preview!.overdue[item.taskId]);
  const busy = loading || applying;
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
          <span className="caption-style text-subtle truncate">
            {proposal ? `Today to ${previewDayLabel(proposal.to, today)} · nothing changes until Apply` : "Today and the next 14 days"}
          </span>
        </div>
        <Button variant="ghost" size="icon" className="hit" aria-label="Cancel plan" disabled={applying} onClick={handlers.onCancel}>
          <CloseIcon aria-hidden className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-3">
        {loading && (
          <div role="status" className="caption-style text-subtle px-2 pt-4">
            Planning…
          </div>
        )}
        {preview && !loading && (
          <>
            {proposal!.reason && (
              <div className="caption-style text-soft mx-2 mt-2.5 flex items-start gap-2 rounded-[10px] bg-[color-mix(in_srgb,var(--violet)_9%,transparent)] px-2.5 py-2">
                <SparkleIcon aria-hidden className="text-violet mt-0.5 size-3.5 shrink-0" />
                <span>{proposal!.reason}</span>
              </div>
            )}
            {overdue.length > 0 && (
              <section aria-label="Overdue">
                <div className={cn(GROUP, "text-danger")}>
                  Overdue <span className="font-normal tabular-nums">{overdue.length}</span>
                  {movable.length > 0 && (
                    <Button variant="secondary" size="sm" className={cn(SMALL, "text-foreground ml-auto")} onClick={handlers.onMoveAll}>
                      Move all
                    </Button>
                  )}
                </div>
                <ul className="flex flex-col gap-1.5 px-1 [@media(pointer:coarse)]:gap-3">
                  {overdue.map((item) => {
                    const choice = preview.overdue[item.taskId];
                    return (
                      <li key={item.taskId} className={cn(CARD, choice === "leave" && "opacity-70")} data-plan-overdue={item.taskId}>
                        <div className="flex min-w-0 items-center gap-2">
                          <span aria-hidden className="bg-danger flex size-4 shrink-0 items-center justify-center rounded-full text-white">
                            <CloseIcon className="size-2.5" />
                          </span>
                          <span className="ui-style min-w-0 flex-1 truncate">{item.title}</span>
                        </div>
                        <div className={ACTIONS}>
                          <span className="caption-style text-subtle tabular-nums">{wasLabel(item, today)}</span>
                          {choice === "leave" ? (
                            <span className="caption-style text-subtle">Left</span>
                          ) : (
                            <>
                              <ChevronRightIcon aria-hidden className="text-subtle size-3" />
                              <span className="caption-style text-soft tabular-nums">{item.at ? whenLabel(item.at, today) : "No free time"}</span>
                            </>
                          )}
                          <span className={BUTTONS}>
                            {choice ? (
                              <Button variant="ghost" size="sm" className={SMALL} onClick={() => handlers.onUndoOverdue(item.taskId)}>
                                Undo
                              </Button>
                            ) : (
                              <>
                                {item.at && (
                                  <Button variant="secondary" size="sm" className={SMALL} onClick={() => handlers.onMoveOverdue(item.taskId)}>
                                    Move
                                  </Button>
                                )}
                                <Button variant="ghost" size="sm" className={SMALL} onClick={() => handlers.onLeaveOverdue(item.taskId)}>
                                  Leave
                                </Button>
                              </>
                            )}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
            {unplaced.length > 0 && (
              <section aria-label="Couldn't fit">
                <div className={GROUP}>
                  Couldn&apos;t fit <span className="text-subtle font-normal tabular-nums">{unplaced.length}</span>
                </div>
                <ul className="flex flex-col gap-1.5 px-1 [@media(pointer:coarse)]:gap-3">
                  {unplaced.map((item) => {
                    const chosen = preview.unplaced[item.taskId];
                    const next = missDayLabel(item, today);
                    const moved = chosen === "next" || chosen === "outside";
                    return (
                      <li key={item.taskId} className={cn(CARD, chosen === "leave" && "opacity-70")} data-plan-unplaced={item.taskId}>
                        <div className="flex min-w-0 items-center gap-2">
                          <TaskKindIcon title={item.title} className="text-subtle size-3.5 shrink-0" />
                          <span className="ui-style min-w-0 flex-1 truncate">{item.title}</span>
                          <span className="caption-style text-faint shrink-0 tabular-nums">{durationLabel(item.durationMinutes)}</span>
                        </div>
                        <span className="caption-style text-subtle">
                          {moved ? `Moves to ${whenLabel((chosen === "next" ? item.nextFree : item.outside)!, today)}` : chosen === "leave" ? "Left off the calendar" : item.reason}
                        </span>
                        <div className={ACTIONS}>
                          {chosen ? (
                            <Button variant="ghost" size="sm" className={SMALL} onClick={() => handlers.onUndoMiss(item.taskId)}>
                              Undo
                            </Button>
                          ) : (
                            <>
                              {item.nextFree && next && (
                                <Button variant="secondary" size="sm" className={SMALL} onClick={() => handlers.onMiss(item.taskId, "next")}>
                                  Next free day <span className="text-subtle font-normal tabular-nums">{next}</span>
                                </Button>
                              )}
                              {item.outside && (
                                <Button variant="secondary" size="sm" className={SMALL} onClick={() => handlers.onMiss(item.taskId, "outside")}>
                                  Outside hours
                                </Button>
                              )}
                              <Button variant="ghost" size="sm" className={SMALL} onClick={() => handlers.onMiss(item.taskId, "leave")}>
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
            <div className={GROUP}>
              Placed <span className="text-subtle font-normal tabular-nums">{preview.entries.length}</span>
            </div>
            {preview.entries.length === 0 ? (
              <span className="caption-style text-subtle block px-2">Nothing to place.</span>
            ) : (
              <PlacedList preview={preview} today={today} clashes={clashes} onRemove={handlers.onRemove} />
            )}
          </>
        )}
      </div>
      <div className="border-border flex flex-col gap-2.5 border-t px-4 pt-3 pb-3.5">
        <div className="flex items-start gap-2.5">
          <Switch className="hit mt-px" checked={replan} disabled={busy || !preview} label="Replan my blocks" onChange={handlers.onReplan} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="ui-style font-medium">Replan my blocks</span>
            <span className="caption-style text-subtle">Moves blocks Plan placed before, on the same day. Blocks you placed stay.</span>
          </div>
        </div>
        {error && (
          <div role="alert" className="caption-style text-danger">
            {error}
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="caption-style text-subtle min-w-0 flex-1 truncate tabular-nums">{preview ? previewSummary(preview) : ""}</span>
          <Button variant="secondary" size="sm" className="hit" onClick={handlers.onCancel} disabled={applying}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" className="hit" onClick={handlers.onApply} disabled={!preview || busy || preview.entries.length === 0}>
            {applying ? "Applying…" : "Apply"}
          </Button>
        </div>
      </div>
    </aside>
  );
}
