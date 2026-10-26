"use client";

import { laterDetail } from "@/lib/mail/later";
import { personName } from "@/lib/mail/format";
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
      <p role="status" className="text-subtle px-6 py-16 text-center">
        Loading scheduled email…
      </p>
    );
  }
  if (drafts.length === 0) {
    return (
      <p role="status" className="text-subtle px-6 py-16 text-center">
        Nothing scheduled. Use Send later in any email to pick a time.
      </p>
    );
  }
  return (
    <ul aria-label="Scheduled email" className="flex flex-col gap-px px-2 pb-24">
      {drafts.map((draft) => (
        <li key={draft.id}>
          <button
            type="button"
            onClick={() => onOpen(draft)}
            className="ease-power3-out flex w-full cursor-pointer flex-col gap-0.5 rounded-xl px-3 py-2.5 text-left transition-colors duration-150 outline-none hover:bg-white/[0.035] focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="text-foreground min-w-0 truncate text-[14px]">
                To {draft.to.map((person) => personName(person)).join(", ") || "no one yet"}
              </span>
              {draft.sendError ? (
                <span className="text-danger ml-auto shrink-0 text-[12px]">Didn&apos;t send</span>
              ) : (
                draft.sendAt && (
                  <span className="text-primary-foreground ml-auto flex shrink-0 items-center gap-1 text-[12px] tabular-nums">
                    <ClockIcon aria-hidden className="size-3" />
                    {laterDetail(draft.sendAt, now)}
                  </span>
                )
              )}
            </span>
            <span className="flex min-w-0 items-baseline gap-1.5 text-[13px]">
              <span className="text-soft max-w-[70%] shrink-0 truncate">{draft.subject || "(no subject)"}</span>
              <span className="text-subtle min-w-0 truncate">{draft.sendError ?? draft.body}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
