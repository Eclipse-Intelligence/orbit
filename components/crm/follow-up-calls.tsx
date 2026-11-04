"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import Tag from "@/components/_ui/tag";
import { useComposer } from "@/components/mail/compose-dock";
import { closeFollowUpAction } from "@/app/(crm)/capture/actions";
import type { FollowUpSuggestion } from "@/lib/crm/follow-ups";
import SparkleIcon from "@/public/assets/images/mail/sparkle.svg";

const SOURCE_LABELS: Record<FollowUpSuggestion["source"], string> = { teams: "Teams", granola: "Granola" };

function FollowUpCard({ suggestion, onClosed }: { suggestion: FollowUpSuggestion; onClosed: (id: string) => void }) {
  const router = useRouter();
  const { openComposer } = useComposer();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const who = suggestion.to.name ?? suggestion.to.address;

  async function close(state: "used" | "dismissed") {
    setBusy(true);
    setError(null);
    const result = await closeFollowUpAction(suggestion.id, state);
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onClosed(suggestion.id);
    router.refresh();
  }

  function review() {
    openComposer({ to: [suggestion.to], subject: suggestion.subject, body: suggestion.body });
    void close("used");
  }

  return (
    <li className="bg-card border-line-strong flex flex-col gap-3 rounded-2xl border p-4">
      <div className="flex items-start gap-2.5">
        <Tag tone={suggestion.source === "granola" ? "teal" : "purple"} size="sm" className="text-[12px]">
          {SOURCE_LABELS[suggestion.source]}
        </Tag>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[14px] leading-5 break-words">{suggestion.title}</span>
          <span className="caption-style text-subtle leading-[1.4]">{suggestion.line}</span>
        </span>
      </div>
      <div className="flex flex-col gap-1.5 rounded-xl bg-white/[0.035] px-3 py-2.5">
        <span className="caption-style text-subtle flex min-w-0 items-center gap-1.5">
          <SparkleIcon aria-hidden className="text-primary-foreground size-3 shrink-0" />
          <span className="truncate">
            To {who} · {suggestion.subject}
          </span>
        </span>
        <p className="text-soft line-clamp-6 text-[13px] leading-[1.5] sm:line-clamp-4">{suggestion.body.replace(/\s*\n+\s*/g, " ")}</p>
      </div>
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" disabled={busy} onClick={review}>
          Review and send
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void close("dismissed")}>
          Not needed
        </Button>
      </div>
    </li>
  );
}

export default function FollowUpCalls({ suggestions }: { suggestions: FollowUpSuggestion[] }) {
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const shown = suggestions.filter((suggestion) => !closed.has(suggestion.id));
  if (shown.length === 0) return null;
  return (
    <section aria-labelledby="follow-up-heading" className="flex flex-col gap-3">
      <h2 id="follow-up-heading" className="eyebrow-style text-subtle flex items-center gap-2 font-normal">
        Follow up
        <span className="text-soft tracking-normal tabular-nums">{shown.length}</span>
      </h2>
      <ul className="flex flex-col gap-2">
        {shown.map((suggestion) => (
          <FollowUpCard key={suggestion.id} suggestion={suggestion} onClosed={(id) => setClosed((current) => new Set(current).add(id))} />
        ))}
      </ul>
    </section>
  );
}
