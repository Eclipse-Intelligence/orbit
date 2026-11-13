"use client";

import { useRef, type ReactNode } from "react";
import Button from "@/components/_ui/button";
import { useComposer } from "@/components/mail/compose-dock";
import { taskKind } from "@/lib/crm/task-kind";
import { briefRows, composeFromPreparation, preparable, type TaskPreparation } from "@/lib/crm/task-preparation";
import type { Task } from "@/lib/crm/types";
import { appTimeZone } from "@/lib/time";
import { cn } from "@/lib/utils";
import { preparationEntry, useTaskPreparations } from "@/stores/task-preparation-store";
import SparkleIcon from "@/public/assets/images/assistant/sparkle.svg";
import ComposeIcon from "@/public/assets/images/mail/compose.svg";
import RefreshIcon from "@/public/assets/images/mail/refresh.svg";

const FAILED = "Couldn't prepare it. Try again.";
const OPEN_GUARD_MS = 1_500;

function preparedLabel(value: string) {
  const timeZone = appTimeZone();
  const date = new Date(value);
  const dayOf = (when: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(when);
  if (dayOf(date) === dayOf(new Date())) return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  return new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short" }).format(date);
}

function heading(meeting: boolean, preparation: TaskPreparation) {
  if (preparation.kind === "draft") return "Draft";
  return meeting ? "Meeting brief" : "Call brief";
}

async function requestPreparation(taskId: string): Promise<{ preparation?: TaskPreparation; error?: string }> {
  const response = await fetch("/api/tasks/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId }) });
  const json = (await response.json().catch(() => ({}))) as { preparation?: TaskPreparation; error?: string };
  if (!response.ok || !json.preparation) return { error: json.error ?? FAILED };
  return { preparation: json.preparation };
}

function BriefBody({ preparation, meeting }: { preparation: TaskPreparation; meeting: boolean }) {
  const rows = preparation.brief ? briefRows(preparation.brief, meeting) : [];
  if (rows.length === 0) return <p className="caption-style text-subtle">Nothing to go on yet.</p>;
  return (
    <dl className="grid grid-cols-1 gap-x-3.5 gap-y-1 text-[13px] leading-[19px] sm:grid-cols-[9.5em_minmax(0,1fr)] sm:gap-y-2">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-subtle max-sm:pt-1.5">{row.label}</dt>
          <dd className="text-foreground min-w-0 break-words">
            {row.items.length > 0 ? (
              <ul className="flex flex-col gap-[3px]">
                {row.items.map((item, index) => (
                  <li key={index} className="before:bg-faint relative pl-3 before:absolute before:top-2 before:left-px before:size-1 before:rounded-full">
                    {item}
                  </li>
                ))}
              </ul>
            ) : (
              row.text
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function DraftBody({ preparation }: { preparation: TaskPreparation }) {
  const composer = useComposer();
  const openedAt = useRef(0);
  const draft = preparation.draft;
  if (!draft) return null;
  const to = draft.to.map((person) => person.name || person.address).join(", ");

  function open() {
    if (!draft) return;
    const now = Date.now();
    if (now - openedAt.current < OPEN_GUARD_MS) return;
    openedAt.current = now;
    composer.openComposer(composeFromPreparation(draft));
  }

  return (
    <>
      <div className="bg-secondary rounded-[10px] px-3 py-2.5 text-[13.5px] leading-[21px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]">
        <div className="caption-style text-subtle border-line-subtle mb-2 flex min-w-0 flex-wrap gap-x-1.5 gap-y-0.5 border-b pb-2">
          {to && (
            <>
              <span>To</span>
              <span className="text-foreground mr-2.5 min-w-0 truncate">{to}</span>
            </>
          )}
          <span>Subject</span>
          <span className="text-foreground min-w-0 truncate">{draft.subject || "No subject"}</span>
        </div>
        <p data-prepared-draft="" className="text-foreground break-words whitespace-pre-wrap">
          {draft.body}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button variant="primary" size="md" onClick={open} className="hit">
          <ComposeIcon aria-hidden className="size-3.5" />
          Open in compose
        </Button>
        <span className="caption-style text-subtle">Nothing is sent until you press Send.</span>
      </div>
    </>
  );
}

function PreparedCard({ task, preparation, preparing, onPrepare }: { task: Task; preparation: TaskPreparation; preparing: boolean; onPrepare: () => void }) {
  const meeting = taskKind(task.title) === "meeting";
  const title = heading(meeting, preparation);
  return (
    <section aria-label={title} data-task-preparation="" className="ring-line-subtle flex flex-col gap-2.5 rounded-xl bg-white/[0.025] px-3.5 pt-3 pb-3.5 ring-1 ring-inset">
      <div className="flex min-w-0 items-start gap-2">
        <SparkleIcon aria-hidden className="mt-[3px] size-3.5 shrink-0 text-(--tag-purple-text)" />
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h3 className="ui-style font-medium">{title}</h3>
          <span className="caption-style text-subtle">
            Prepared {preparedLabel(preparation.preparedAt)}
            {preparation.stale && <span className="text-(--tag-amber-text)"> · out of date</span>}
          </span>
          <span data-preparation-private="" className="caption-style text-subtle">
            Only you see this
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Prepare again"
          title="Prepare again"
          disabled={preparing}
          aria-busy={preparing || undefined}
          onClick={onPrepare}
          className="hit -my-1 size-[34px]"
        >
          <RefreshIcon aria-hidden className={cn("size-3.5", preparing && "animate-spin")} />
        </Button>
      </div>
      {preparation.kind === "draft" ? <DraftBody preparation={preparation} /> : <BriefBody preparation={preparation} meeting={meeting} />}
    </section>
  );
}

export function TaskPrepare({ task, children }: { task: Task; children?: (button: ReactNode) => ReactNode }) {
  const enabled = preparable(task) && !task.completedAt && !task.archivedAt;
  const entry = useTaskPreparations((state) => preparationEntry(state.entries, task.id));
  const start = useTaskPreparations((state) => state.start);
  const finish = useTaskPreparations((state) => state.finish);

  async function prepare() {
    if (!start(task.id)) return;
    const result = await requestPreparation(task.id).catch(() => ({ error: FAILED }) as { preparation?: TaskPreparation; error?: string });
    finish(task.id, result);
  }

  const preparation = enabled ? entry.preparation : null;
  const button =
    enabled && (entry.loaded || entry.pending) && !preparation ? (
      <Button variant="ghost" size="md" disabled={entry.pending} aria-busy={entry.pending || undefined} onClick={() => void prepare()} className="hit max-sm:flex-1">
        <SparkleIcon aria-hidden className="size-3.5" />
        {entry.pending ? "Preparing…" : "Prepare"}
      </Button>
    ) : null;
  return (
    <>
      {preparation && <PreparedCard task={task} preparation={preparation} preparing={entry.pending} onPrepare={() => void prepare()} />}
      {enabled && entry.error && (
        <p role="alert" className="caption-style text-danger">
          {entry.error}
        </p>
      )}
      {children ? children(button) : button}
    </>
  );
}
