"use client";

import { useEffect, useState, type ReactNode } from "react";
import Button from "@/components/_ui/button";
import { useComposer } from "@/components/mail/compose-dock";
import { taskPreparationAction } from "@/app/(crm)/task-act";
import { taskKind } from "@/lib/crm/task-kind";
import { briefRows, composeFromPreparation, preparable, type TaskPreparation } from "@/lib/crm/task-preparation";
import type { Task } from "@/lib/crm/types";
import { appTimeZone } from "@/lib/time";
import { cn } from "@/lib/utils";
import SparkleIcon from "@/public/assets/images/assistant/sparkle.svg";
import ComposeIcon from "@/public/assets/images/mail/compose.svg";
import RefreshIcon from "@/public/assets/images/mail/refresh.svg";

const FAILED = "Couldn't prepare it. Try again.";

type State = { key: string; preparation: TaskPreparation | null };

function preparedLabel(value: string) {
  const timeZone = appTimeZone();
  const date = new Date(value);
  const dayOf = (when: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(when);
  if (dayOf(date) === dayOf(new Date())) return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  return new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short" }).format(date);
}

function heading(task: Task, preparation: TaskPreparation) {
  if (preparation.kind === "draft") return "Draft";
  return taskKind(task.title) === "meeting" ? "Meeting brief" : "Call brief";
}

async function requestPreparation(taskId: string): Promise<{ preparation?: TaskPreparation; error?: string }> {
  const response = await fetch("/api/tasks/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId }) });
  const json = (await response.json().catch(() => ({}))) as { preparation?: TaskPreparation; error?: string };
  if (!response.ok || !json.preparation) return { error: json.error ?? FAILED };
  return { preparation: json.preparation };
}

function BriefBody({ preparation }: { preparation: TaskPreparation }) {
  const rows = preparation.brief ? briefRows(preparation.brief) : [];
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
  const draft = preparation.draft;
  if (!draft) return null;
  const to = draft.to.map((person) => person.name || person.address).join(", ");
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
        <Button variant="primary" size="md" onClick={() => composer.openComposer(composeFromPreparation(draft))} className="hit">
          <ComposeIcon aria-hidden className="size-3.5" />
          Open in compose
        </Button>
        <span className="caption-style text-subtle">Nothing is sent until you press Send.</span>
      </div>
    </>
  );
}

function PreparedCard({ task, preparation, preparing, onPrepare }: { task: Task; preparation: TaskPreparation; preparing: boolean; onPrepare: () => void }) {
  const title = heading(task, preparation);
  return (
    <section aria-label={title} data-task-preparation="" className="ring-line-subtle flex flex-col gap-2.5 rounded-xl bg-white/[0.025] px-3.5 pt-3 pb-3.5 ring-1 ring-inset">
      <div className="flex min-w-0 items-center gap-2">
        <SparkleIcon aria-hidden className="size-3.5 shrink-0 text-(--tag-purple-text)" />
        <h3 className="ui-style font-medium">{title}</h3>
        <span className="caption-style text-subtle min-w-0 truncate">
          Prepared {preparedLabel(preparation.preparedAt)}
          {preparation.stale && <span className="text-(--tag-amber-text)"> · out of date</span>} · only you see this
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Prepare again"
          title="Prepare again"
          disabled={preparing}
          aria-busy={preparing || undefined}
          onClick={onPrepare}
          className="hit ml-auto size-[34px]"
        >
          <RefreshIcon aria-hidden className={cn("size-3.5", preparing && "animate-spin")} />
        </Button>
      </div>
      {preparation.kind === "draft" ? <DraftBody preparation={preparation} /> : <BriefBody preparation={preparation} />}
    </section>
  );
}

export function TaskPrepare({ task, children }: { task: Task; children?: (button: ReactNode) => ReactNode }) {
  const enabled = preparable(task) && !task.completedAt && !task.archivedAt;
  const key = `${task.id}|${task.updatedAt}|${task.title}|${task.contactId}|${task.companyId}|${task.opportunityId}`;
  const [state, setState] = useState<State | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void taskPreparationAction(task.id)
      .catch(() => ({ preparation: null }))
      .then((result) => {
        if (!cancelled) setState({ key, preparation: "preparation" in result ? (result.preparation ?? null) : null });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, key, task.id]);

  async function prepare() {
    if (preparing) return;
    setPreparing(true);
    setError(null);
    const result = await requestPreparation(task.id).catch(() => ({ error: FAILED }) as { preparation?: TaskPreparation; error?: string });
    setPreparing(false);
    if (result.preparation) setState({ key, preparation: result.preparation });
    else setError(result.error ?? FAILED);
  }

  const preparation = enabled && state?.key === key ? state.preparation : null;
  const loaded = enabled && state?.key === key;
  const button =
    loaded && !preparation ? (
      <Button variant="ghost" size="md" disabled={preparing} aria-busy={preparing || undefined} onClick={() => void prepare()} className="hit max-sm:flex-1">
        <SparkleIcon aria-hidden className="size-3.5" />
        {preparing ? "Preparing…" : "Prepare"}
      </Button>
    ) : null;
  return (
    <>
      {preparation && <PreparedCard task={task} preparation={preparation} preparing={preparing} onPrepare={() => void prepare()} />}
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      {children ? children(button) : button}
    </>
  );
}
