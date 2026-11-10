"use client";

import { useState } from "react";
import Button from "@/components/_ui/button";
import { useComposer } from "@/components/mail/compose-dock";
import type { DeferredFollowUp } from "@/lib/mail/view";
import { appTimeZone, zonedParts } from "@/lib/time";
import ClockIcon from "@/public/assets/images/mail/clock.svg";

function dayLabel(at: string, now = Date.now()) {
  const timeZone = appTimeZone();
  const when = zonedParts(new Date(at), timeZone);
  const year = when.year !== zonedParts(new Date(now), timeZone).year;
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}), timeZone })
    .format(new Date(at))
    .replace(",", "");
  if (when.hour === 9 && when.minute === 0) return day;
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(at));
  return `${day} at ${time}`;
}

async function postDeferral(body: { id: string; action: "move" | "cancel"; at?: string }) {
  const response = await fetch("/api/mail/deferral", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);
  const json = (await response?.json().catch(() => null)) as { error?: string } | null;
  if (!response?.ok) throw new Error(json?.error ?? "That didn't save. Try again.");
}

export default function DeferralNotice({ deferral }: { deferral: DeferredFollowUp }) {
  const { pickLater } = useComposer();
  const [at, setAt] = useState(deferral.at);
  const [cancelled, setCancelled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function changeDate() {
    const now = Date.now();
    pickLater({
      title: "Change date",
      description: "The task moves too.",
      options: deferral.options.filter((option) => new Date(option.at).getTime() > now),
      now,
      onPick: (picked) => {
        const previous = at;
        setAt(picked);
        setError(null);
        setBusy(true);
        postDeferral({ id: deferral.id, action: "move", at: picked })
          .catch((failure: Error) => {
            setAt(previous);
            setError(failure.message);
          })
          .finally(() => setBusy(false));
      },
    });
  }

  function stop() {
    setCancelled(true);
    setError(null);
    setBusy(true);
    postDeferral({ id: deferral.id, action: "cancel" })
      .catch((failure: Error) => {
        setCancelled(false);
        setError(failure.message);
      })
      .finally(() => setBusy(false));
  }

  if (cancelled) {
    return (
      <p role="status" className="caption-style text-subtle flex items-center gap-2 py-1">
        <ClockIcon aria-hidden className="size-3 shrink-0" />
        Follow-up cancelled.
      </p>
    );
  }

  return (
    <section aria-label="Follow-up" className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1 rounded-xl bg-white/[0.035] py-1 pr-1 pl-3">
        <p role="status" className="text-soft mr-auto flex min-w-0 items-center gap-2 py-1.5 text-[13px] leading-5">
          <ClockIcon aria-hidden className="text-primary-foreground size-3.5 shrink-0" />
          Follow-up draft on {dayLabel(at)} if no reply
        </p>
        <span className="flex items-center gap-1 max-sm:-ml-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={changeDate}>
            Change date
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={stop} aria-label="Cancel follow-up">
            Cancel
          </Button>
        </span>
      </div>
      {error && (
        <p role="alert" className="caption-style text-danger px-3">
          {error}
        </p>
      )}
    </section>
  );
}
