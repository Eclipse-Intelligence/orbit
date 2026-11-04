"use client";

import type { ReactNode } from "react";
import Button from "@/components/_ui/button";
import { Monogram, tagBase } from "@/components/beautifui/record-marks";
import { cn } from "@/lib/utils";
import CalendarIcon from "@/public/assets/images/_common/calendar.svg";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import ChevronLeftIcon from "@/public/assets/images/_common/chevron-left.svg";
import ArchiveIcon from "@/public/assets/images/mail/archive.svg";
import ClockIcon from "@/public/assets/images/mail/clock.svg";
import FlagIcon from "@/public/assets/images/mail/flag.svg";
import FollowUpIcon from "@/public/assets/images/mail/follow-up.svg";
import ForwardIcon from "@/public/assets/images/mail/forward.svg";
import MailOpenIcon from "@/public/assets/images/mail/mail-open.svg";
import ReplyAllIcon from "@/public/assets/images/mail/reply-all.svg";
import ReplyIcon from "@/public/assets/images/mail/reply.svg";
import TrashIcon from "@/public/assets/images/mail/trash.svg";
import { WRITTEN_FOLLOW_UP } from "./composer-mock";

const ACCOUNT = "mark@cntent.ai";

const PROPOSAL = `Hi Jane,

Here's the pilot we talked about on Tuesday: six weeks, both sales teams, and a fixed fee of £18,000.

Could we find 30 minutes next week to agree a start date?

Mark`;

type MockMessageProps = {
  sender: string;
  address: string;
  when: string;
  to: string;
  snippet: string;
  body?: string;
  expanded?: boolean;
  unread?: boolean;
  children?: ReactNode;
};

function MockMessage({ sender, address, when, to, snippet, body, expanded = false, unread = false, children }: MockMessageProps) {
  return (
    <article className={cn("rounded-2xl", expanded ? "bg-white/[0.025]" : "hover:bg-white/[0.025]")}>
      <div className="flex items-start">
        <button type="button" className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-2xl px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
          <Monogram name={sender} className="mt-0.5 size-7 rounded-full text-[11px]" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className={cn("truncate text-[14px]", unread ? "text-foreground font-medium" : "text-foreground")}>{sender}</span>
              {expanded && <span className="text-subtle hidden min-w-0 truncate text-[12px] sm:inline">{address}</span>}
              <span className="text-subtle ml-auto shrink-0 text-[12px] tabular-nums">{when}</span>
            </span>
            {expanded ? (
              <span className="text-subtle flex min-w-0 items-center gap-1 text-[12px]">
                <span className="truncate">To {to}</span>
                <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
              </span>
            ) : (
              <span className="text-subtle truncate text-[13px]">{snippet}</span>
            )}
          </span>
        </button>
        {expanded && (
          <Button variant="ghost" size="icon" aria-label="Collapse this email" title="Collapse" className="mt-2 mr-2 shrink-0">
            <ChevronDownIcon aria-hidden className="size-4 rotate-180" />
          </Button>
        )}
      </div>
      {expanded && (
        <div className="flex flex-col gap-3 px-4 pb-4 sm:pl-14">
          <p className="text-foreground whitespace-pre-wrap">{body}</p>
          {children}
        </div>
      )}
    </article>
  );
}

function ToolButton({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Button variant="ghost" size="icon" aria-label={label} title={label}>
      {children}
    </Button>
  );
}

function ReplyRow() {
  return (
    <div className="flex flex-wrap items-center gap-2 px-4">
      {(
        [
          ["Reply", ReplyIcon],
          ["Reply all", ReplyAllIcon],
          ["Forward", ForwardIcon],
        ] as const
      ).map(([label, Icon]) => (
        <Button key={label} variant="secondary">
          <Icon aria-hidden className="size-3.5" />
          {label}
        </Button>
      ))}
    </div>
  );
}

function ScheduledFollowUp({ written }: { written: boolean }) {
  return (
    <section aria-label="Follow-up" data-mock-focus="" className="flex items-start gap-3 rounded-2xl border border-dashed border-white/15 px-4 py-3">
      <span aria-hidden className="text-primary-foreground mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--primary)_24%,transparent)]">
        <FollowUpIcon className="size-3.5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="text-foreground text-[14px] leading-5">Follow-up goes to Jane on Mon 9 Nov at 09:00 if she hasn&apos;t replied</p>
        {written ? (
          <p className="text-soft line-clamp-2 text-[14px] leading-6">{WRITTEN_FOLLOW_UP.replace(/\s*\n+\s*/g, " ")}</p>
        ) : (
          <p className="caption-style text-subtle">Orbit will write it then, in your voice.</p>
        )}
        <div className="mt-1.5 flex flex-wrap gap-2">
          <Button variant="secondary" size="sm">
            {written ? "Edit" : "Write it now"}
          </Button>
          <Button variant="ghost" size="sm">
            Send now
          </Button>
          <Button variant="ghost" size="sm">
            Cancel
          </Button>
        </div>
      </div>
    </section>
  );
}

function FollowUpCancelled() {
  return (
    <p role="status" data-mock-focus="" className="caption-style text-subtle flex items-center gap-2 px-4 py-1">
      <FollowUpIcon aria-hidden className="size-3 shrink-0" />
      Jane replied, so the follow-up was cancelled.
    </p>
  );
}

function NotNowNotice() {
  return (
    <div role="status" data-mock-focus="" className="flex flex-wrap items-center gap-x-1 gap-y-1 rounded-xl bg-white/[0.035] py-1 pr-1 pl-3">
      <span className="text-soft mr-auto flex min-w-0 items-center gap-2 py-1.5 text-[13px] leading-5">
        <ClockIcon aria-hidden className="text-primary-foreground size-3.5 shrink-0" />
        Orbit will follow up on Mon 11 Jan
      </span>
      <span className="flex items-center gap-1 max-sm:-ml-2">
        <Button variant="ghost" size="sm">
          Change date
        </Button>
        <Button variant="ghost" size="sm">
          Don&apos;t follow up
        </Button>
      </span>
    </div>
  );
}

export type ThreadMode = "scheduled" | "unwritten" | "done" | "not-now";

export default function ThreadMock({ mode }: { mode: ThreadMode }) {
  const janeFirst = (
    <MockMessage
      sender="Jane Doe"
      address="jane.doe@acme.com"
      when="Mon, 2 Nov 2026, 16:05"
      to="me"
      snippet="Could you send the pilot proposal over before the end of the week?"
    />
  );
  const mine = (expanded: boolean) => (
    <MockMessage
      sender="Mark Ridgeon"
      address={ACCOUNT}
      when="Wed, 4 Nov 2026, 08:12"
      to="Jane Doe"
      snippet="Here's the pilot we talked about on Tuesday: six weeks, both sales teams, and a fixed fee"
      body={PROPOSAL}
      expanded={expanded}
    />
  );
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-3 py-2 sm:px-5">
        <Button variant="ghost" size="icon" aria-label="Back to the list" title="Back (Esc)" className="md:hidden">
          <ChevronLeftIcon aria-hidden className="size-3.5" />
        </Button>
        <ToolButton label="Archive">
          <ArchiveIcon aria-hidden className="size-3.5" />
        </ToolButton>
        <ToolButton label="Remind me">
          <ClockIcon aria-hidden className="size-3.5" />
        </ToolButton>
        <ToolButton label="Move to Trash">
          <TrashIcon aria-hidden className="size-3.5" />
        </ToolButton>
        <ToolButton label="Mark unread">
          <MailOpenIcon aria-hidden className="size-3.5" />
        </ToolButton>
        <ToolButton label="Flag">
          <FlagIcon aria-hidden className="size-3.5" />
        </ToolButton>
        <ToolButton label="Send an invite from this email">
          <CalendarIcon aria-hidden className="size-3.5" />
        </ToolButton>
        <span className="ml-auto flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="sm" aria-label="Split: Important. Change where this sender goes">
            Important
            <ChevronDownIcon aria-hidden className="size-3" />
          </Button>
          <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: tagBase(ACCOUNT) }} />
          <span className="caption-style text-subtle truncate max-sm:sr-only">{ACCOUNT}</span>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div data-mock-thread="" className="mx-auto flex w-full max-w-[52em] flex-col gap-4 px-3 pt-3 pb-32 sm:px-6">
          <h2 className="px-4 text-pretty">Acme pilot: proposal and next steps</h2>
          <div className="flex flex-col gap-1.5">
            {janeFirst}
            {mode === "scheduled" || mode === "unwritten" ? (
              mine(true)
            ) : mode === "done" ? (
              <>
                {mine(false)}
                <FollowUpCancelled />
                <MockMessage
                  sender="Jane Doe"
                  address="jane.doe@acme.com"
                  when="Wed, 4 Nov 2026, 14:20"
                  to="me"
                  snippet=""
                  body={"Hi Mark,\n\nThanks, this looks good. I'll share it with Tom and come back to you by Friday.\n\nJane"}
                  expanded
                  unread
                />
              </>
            ) : (
              <>
                {mine(false)}
                <MockMessage
                  sender="Jane Doe"
                  address="jane.doe@acme.com"
                  when="Wed, 4 Nov 2026, 14:20"
                  to="me"
                  snippet=""
                  body={"Hi Mark,\n\nThanks for sending this over. Can we pick this up in January? Next year's budget is signed off just before Christmas.\n\nJane"}
                  expanded
                  unread
                >
                  <NotNowNotice />
                </MockMessage>
              </>
            )}
          </div>
          {(mode === "scheduled" || mode === "unwritten") && <ScheduledFollowUp written={mode === "scheduled"} />}
          <ReplyRow />
        </div>
      </div>
    </div>
  );
}
