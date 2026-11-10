"use client";

import Button from "@/components/_ui/button";
import { laterDetail } from "@/lib/mail/later";
import { mailFullWhen, personName } from "@/lib/mail/format";
import type { MailDraft } from "@/lib/mail/view";
import ClockIcon from "@/public/assets/images/mail/clock.svg";

export default function ScheduledList({
  drafts,
  now,
  onOpen,
}: {
  drafts: MailDraft[] | null;
  now: number;
  onOpen: (draft: MailDraft) => void;
}) {
  if (!drafts) {
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-3 px-6 py-16">
        <span className="sr-only">Loading scheduled email…</span>
        {Array.from({ length: 3 }, (_, index) => (
          <span key={index} aria-hidden className="flex flex-col gap-2 px-3 py-2">
            <span className="bg-surface-raised h-3 w-1/3 animate-pulse rounded-full" />
            <span className="bg-surface-field h-3 w-4/5 animate-pulse rounded-full" />
          </span>
        ))}
      </div>
    );
  }
  if (drafts.length === 0) {
    return (
      <p role="status" className="text-subtle px-6 py-16 text-center">
        Nothing scheduled
      </p>
    );
  }
  return (
    <ul aria-label="Scheduled email" className="flex flex-col gap-px px-2 pb-24 max-md:pb-[var(--floating-clearance)]">
      {drafts.map((draft) => (
        <li key={draft.id}>
          <Button
            variant="item"
            size="none"
            onClick={() => onOpen(draft)}
            className="hover:bg-surface-hover flex-col gap-0.5 rounded-xl px-3 py-2.5 leading-[1.4] active:scale-100"
          >
            <span className="flex w-full min-w-0 items-center gap-2">
              <span className="text-foreground min-w-0 truncate text-[14px]">
                To {draft.to.map((person) => personName(person)).join(", ") || "no one yet"}
              </span>
              {draft.sendError ? (
                <span className="text-danger ml-auto shrink-0 text-[12px]">Didn&apos;t send</span>
              ) : (
                draft.sendAt && (
                  <time
                    dateTime={draft.sendAt}
                    title={`Sends ${mailFullWhen(draft.sendAt)}`}
                    className="text-primary-foreground ml-auto flex shrink-0 items-center gap-1 text-[12px] tabular-nums"
                  >
                    <ClockIcon aria-hidden className="size-3" />
                    <span className="sr-only">Sends</span>
                    {laterDetail(draft.sendAt, now)}
                  </time>
                )
              )}
            </span>
            <span className="flex w-full min-w-0 items-baseline gap-1.5 text-[13px]">
              <span className="text-soft max-w-[70%] shrink-0 truncate">{draft.subject || "(no subject)"}</span>
              <span className="text-subtle min-w-0 truncate">{draft.sendError ?? draft.body}</span>
            </span>
          </Button>
        </li>
      ))}
    </ul>
  );
}
