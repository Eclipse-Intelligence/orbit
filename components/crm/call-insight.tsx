"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import {
  acceptCallActionAction,
  callTranscriptAction,
  dismissCallActionAction,
  summariseCallAction,
  type CallInsightActionState,
} from "@/app/(crm)/call-insights";
import type { CallActionItem, CallInsight } from "@/lib/crm/types";

function newest(server: CallInsight | null, local: CallInsight | null) {
  if (!local) return server;
  if (!server || server.id !== local.id) return local;
  return new Date(local.updatedAt).getTime() > new Date(server.updatedAt).getTime()
    ? local
    : server;
}

function dueLabel(day: string) {
  const [year, month, date] = day.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, date)));
}

function itemMeta(item: CallActionItem) {
  const parts = [];
  if (item.owner === "me") parts.push("You");
  if (item.owner === "them") parts.push("Them");
  if (item.dueDate) parts.push(`Due ${dueLabel(item.dueDate)}`);
  return parts.join(" · ");
}

export default function CallInsightPanel({
  activityId,
  insight: initial,
}: {
  activityId: string;
  insight: CallInsight | null;
}) {
  const router = useRouter();
  const busy = useRef(false);
  const [saved, setSaved] = useState<CallInsight | null>(null);
  const [pasting, setPasting] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [transcript, setTranscript] = useState<string | null>(null);
  const insight = newest(initial, saved);

  async function run(key: string, action: () => Promise<CallInsightActionState>) {
    if (busy.current) return;
    busy.current = true;
    setPending(key);
    setError(null);
    try {
      const result = await action();
      if (result.insight) setSaved(result.insight);
      if (result.error) setError(result.error);
      if (result.insight) {
        setPasting(false);
        setDraft("");
      }
      router.refresh();
    } finally {
      busy.current = false;
      setPending(null);
    }
  }

  async function toggleTranscript() {
    if (!insight) return;
    const next = !transcriptOpen;
    setTranscriptOpen(next);
    if (!next || transcript !== null) return;
    const result = await callTranscriptAction(insight.id);
    if (result.error) {
      setError(result.error);
      setTranscriptOpen(false);
      return;
    }
    setTranscript(result.transcript ?? "");
  }

  const errorLine = error && (
    <p role="alert" className="caption-style text-danger">
      {error}
    </p>
  );

  if (!insight) {
    const fieldId = `call-transcript-${activityId}`;
    if (!pasting) {
      return (
        <div className="flex flex-col gap-1">
          <Button
            variant="ghost"
            size="sm"
            type="button"
            className="self-start"
            onClick={() => setPasting(true)}
          >
            Add transcript
          </Button>
          {errorLine}
        </div>
      );
    }
    const summarising = pending === "summarise";
    return (
      <div className="flex flex-col gap-2">
        <label className="caption-style text-subtle" htmlFor={fieldId}>
          Transcript
        </label>
        <textarea
          id={fieldId}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Paste the call transcript or the .vtt file text"
          disabled={summarising}
          className="border-line-strong bg-secondary min-h-28 w-full rounded-lg border px-3 py-2 text-[14px] leading-5 outline-none"
        />
        {errorLine}
        <div className="flex flex-wrap gap-1">
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={summarising || draft.trim() === ""}
            onClick={() => run("summarise", () => summariseCallAction(activityId, draft))}
          >
            {summarising ? "Summarising…" : "Summarise"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            disabled={summarising}
            onClick={() => {
              setPasting(false);
              setError(null);
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  const panelId = `call-transcript-panel-${insight.id}`;
  const retrying = pending === "summarise";
  const shown = insight.actionItems.filter((item) => item.status !== "dismissed");

  return (
    <div className="border-line-strong flex flex-col gap-3 rounded-lg border px-3 py-2">
      {(insight.status === "pending" || retrying) && (
        <p className="caption-style text-subtle" role="status">
          Summarising…
        </p>
      )}
      {insight.status === "failed" && !retrying && (
        <div className="flex flex-col gap-2">
          <p role="alert" className="caption-style text-danger">
            {insight.error ?? "Could not summarise the call."}
          </p>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            className="self-start"
            onClick={() => run("summarise", () => summariseCallAction(activityId, ""))}
          >
            Try again
          </Button>
        </div>
      )}
      {insight.status === "ready" && insight.summary && (
        <div className="flex flex-col gap-1">
          <span className="caption-style text-subtle">Summary</span>
          <p className="text-[14px] leading-5 whitespace-pre-wrap">{insight.summary}</p>
        </div>
      )}
      {insight.status === "ready" && insight.keyPoints.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="caption-style text-subtle">Key points</span>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[14px] leading-5">
            {insight.keyPoints.map((point, index) => (
              <li key={index}>{point}</li>
            ))}
          </ul>
        </div>
      )}
      {insight.status === "ready" && shown.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="caption-style text-subtle">Suggested next actions</span>
          <ul className="flex flex-col gap-3">
            {shown.map((item) => {
              const meta = itemMeta(item);
              return (
                <li key={item.id} className="flex flex-col gap-1">
                  <span className="text-[14px] leading-5">{item.title}</span>
                  {meta && <span className="caption-style text-subtle">{meta}</span>}
                  {item.status === "accepted" ? (
                    <span className="caption-style text-soft">Added</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        disabled={pending !== null}
                        onClick={() =>
                          run(`accept:${item.id}`, () =>
                            acceptCallActionAction(insight.id, item.id),
                          )
                        }
                      >
                        {pending === `accept:${item.id}` ? "Adding…" : "Add as next action"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        disabled={pending !== null}
                        onClick={() =>
                          run(`dismiss:${item.id}`, () =>
                            dismissCallActionAction(insight.id, item.id),
                          )
                        }
                      >
                        Dismiss
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {insight.status !== "failed" && errorLine}
      <div className="flex flex-col gap-1">
        <Button
          variant="ghost"
          size="sm"
          type="button"
          className="self-start"
          aria-expanded={transcriptOpen}
          aria-controls={panelId}
          onClick={toggleTranscript}
        >
          {transcriptOpen ? "Hide transcript" : "Transcript"}
        </Button>
        {transcriptOpen && (
          <div
            id={panelId}
            className="max-h-80 overflow-auto px-2 text-[14px] leading-5 whitespace-pre-wrap"
          >
            {transcript ?? "Loading…"}
          </div>
        )}
      </div>
    </div>
  );
}
