"use client";

import { useId, useState } from "react";
import Button from "@/components/_ui/button";
import { Textarea } from "@/components/_ui/textarea";
import { useComposer } from "@/components/mail/compose-dock";
import { firstNames, followUpWhen } from "@/lib/mail/format";
import type { FollowUpReminder, FollowUpReplied } from "@/lib/mail/view";
import FollowUpIcon from "@/public/assets/images/mail/follow-up.svg";

type Busy = "write" | "send" | "save" | null;

class FollowUpProblem extends Error {
  constructor(
    message: string,
    readonly stale: boolean,
  ) {
    super(message);
  }
}

async function followUpAction<T>(id: string, action: string, body?: string): Promise<T> {
  const response = await fetch("/api/mail/follow-up", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, action, body }),
  }).catch(() => null);
  if (!response) throw new FollowUpProblem("Couldn't reach the server. Try again.", false);
  const json = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new FollowUpProblem(json.error ?? "Couldn't change the follow-up. Try again.", response.status === 404 || response.status === 409);
  return json;
}

function isStale(problem: unknown) {
  return problem instanceof FollowUpProblem && problem.stale;
}

export function FollowUpBanner({ followUp, onChanged }: { followUp: FollowUpReminder; onChanged: () => void }) {
  const id = useId();
  const { showToast } = useComposer();
  const [body, setBody] = useState(followUp.body ?? "");
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const names = firstNames(followUp.to ?? []);

  async function run(kind: Exclude<Busy, null>, work: () => Promise<void>) {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      await work();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Couldn't change the follow-up. Try again.");
      if (kind === "send" && isStale(problem)) {
        showToast({ message: (problem as Error).message, tone: "alert" });
        onChanged();
      }
    } finally {
      setBusy(null);
    }
  }

  function write() {
    void run("write", async () => {
      const result = await followUpAction<{ body: string | null }>(followUp.id, "write");
      setBody(result.body ?? "");
    });
  }

  function save() {
    if (editing === null) return;
    void run("save", async () => {
      const result = await followUpAction<{ body: string | null }>(followUp.id, "save", editing);
      setBody(result.body ?? "");
      setEditing(null);
    });
  }

  function sendNow() {
    void run("send", async () => {
      const result = await followUpAction<{ to: string }>(followUp.id, "send");
      setGone(true);
      showToast({ message: `Follow-up sent to ${result.to}.` });
      onChanged();
    });
  }

  function cancel() {
    setGone(true);
    followUpAction(followUp.id, "cancel")
      .then(() => {
        onChanged();
        showToast({
          message: "Follow-up cancelled.",
          action: {
            label: "Undo",
            run: () => {
              followUpAction(followUp.id, "restore")
                .then(() => {
                  setGone(false);
                  onChanged();
                })
                .catch((problem: Error) => showToast({ message: problem.message, tone: "alert" }));
            },
          },
        });
      })
      .catch((problem: Error) => {
        setGone(false);
        setError(problem.message);
        if (isStale(problem)) {
          showToast({ message: problem.message, tone: "alert" });
          onChanged();
        }
      });
  }

  if (gone) return null;

  return (
    <section aria-label="Follow-up" className="animate-rise-in flex items-start gap-3 rounded-2xl border border-dashed border-white/15 px-4 py-3">
      <span
        aria-hidden
        className="text-primary-foreground mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--primary)_24%,transparent)]"
      >
        <FollowUpIcon className="size-3.5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="text-foreground text-[14px] leading-5">
          Follow-up to {names} on {followUpWhen(followUp.at)} if no reply
        </p>
        {editing !== null ? (
          <>
            <label htmlFor={`${id}-text`} className="sr-only">
              Follow-up message
            </label>
            <Textarea
              id={`${id}-text`}
              value={editing}
              autoFocus
              onChange={(event) => setEditing(event.target.value)}
              placeholder="Leave empty for Orbit to write it"
              rows={3}
              maxLength={20_000}
              className="field-sizing-content mt-1 max-h-60 min-h-[4.75rem] resize-none"
            />
          </>
        ) : body.trim() ? (
          <p className="text-soft line-clamp-2 text-[14px] leading-6">{body.replace(/\s*\n+\s*/g, " ")}</p>
        ) : (
          <p className="caption-style text-subtle">{busy === "write" ? "Writing…" : "Orbit writes it when due."}</p>
        )}
        {error && (
          <p role="alert" className="caption-style text-danger">
            {error}
          </p>
        )}
        <div className="mt-1.5 flex flex-wrap gap-2">
          {editing !== null ? (
            <>
              <Button variant="secondary" size="sm" onClick={save} disabled={busy !== null}>
                {busy === "save" ? "Saving…" : "Save"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setEditing(null)} disabled={busy !== null}>
                Discard changes
              </Button>
            </>
          ) : (
            <>
              {body.trim() ? (
                <Button variant="secondary" size="sm" onClick={() => setEditing(body)} disabled={busy !== null}>
                  Edit
                </Button>
              ) : (
                <Button variant="secondary" size="sm" onClick={write} disabled={busy !== null}>
                  {busy === "write" ? "Writing…" : "Write now"}
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={sendNow} disabled={busy !== null}>
                {busy === "send" ? "Sending…" : "Send now"}
              </Button>
              <Button variant="ghost" size="sm" onClick={cancel} disabled={busy !== null}>
                Cancel
              </Button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

export function FollowUpCancelledNote({ replied }: { replied: FollowUpReplied }) {
  return (
    <p role="status" className="caption-style text-subtle flex items-center gap-2 px-4 py-1">
      <FollowUpIcon aria-hidden className="size-3 shrink-0" />
      {replied.name} replied. Follow-up cancelled.
    </p>
  );
}
