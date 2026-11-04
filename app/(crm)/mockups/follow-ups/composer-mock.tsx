"use client";

import { useState, type ComponentProps } from "react";
import Button from "@/components/_ui/button";
import { Textarea } from "@/components/_ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/_ui/dropdown-menu";
import { AttachButton } from "@/components/crm/email-attachments";
import BodyEditor from "@/components/mail/body-editor";
import RecipientField from "@/components/mail/recipient-field";
import type { MailAddress } from "@/lib/mail/types";
import { cn } from "@/lib/utils";
import BellIcon from "@/public/assets/images/mail/bell.svg";
import BoldIcon from "@/public/assets/images/mail/bold.svg";
import ClockIcon from "@/public/assets/images/mail/clock.svg";
import FollowUpIcon from "@/public/assets/images/mail/follow-up.svg";
import ItalicIcon from "@/public/assets/images/mail/italic.svg";
import SparkleIcon from "@/public/assets/images/mail/sparkle.svg";
import TrashIcon from "@/public/assets/images/mail/trash.svg";

const WAITS = [
  { value: "", label: "Off" },
  { value: "1", label: "1 day" },
  { value: "2", label: "2 days" },
  { value: "3", label: "3 days" },
  { value: "5", label: "1 week" },
];

const JANE: MailAddress = { address: "jane.doe@acme.com", name: "Jane Doe" };

const BODY = `Hi Jane,

Here's the pilot we talked about on Tuesday: six weeks, both sales teams, and a fixed fee of £18,000.

Could we find 30 minutes next week to agree a start date?

Mark`;

export const WRITTEN_FOLLOW_UP = "Hi Jane, just checking this reached you. Happy to talk the pilot through on a quick call if that's easier.\nMark";

export type ComposerMode = "menu" | "empty" | "written";

const tinted = "text-primary-foreground bg-[color-mix(in_srgb,var(--primary)_28%,transparent)] hover:text-white";

export function WaitButton({ kind, open, ...props }: ComponentProps<typeof Button> & { kind: "none" | "reminder" | "follow-up"; open?: boolean }) {
  if (kind === "none") {
    return (
      <Button {...props} variant="ghost" size="icon" aria-label="If nobody replies" title="If nobody replies">
        <BellIcon aria-hidden className="size-3.5" />
      </Button>
    );
  }
  const followUp = kind === "follow-up";
  return (
    <Button
      {...props}
      variant="ghost"
      size="sm"
      aria-label={followUp ? "Follow-up in 3 working days if nobody replies" : "Remind me if no reply in 3 working days"}
      title={followUp ? "Follow-up in 3 working days if nobody replies" : "Remind me if no reply in 3 working days"}
      className={cn(tinted, followUp && "shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--primary)_75%,transparent)]", open && "text-white")}
    >
      {followUp ? <FollowUpIcon aria-hidden className="size-3.5" /> : <BellIcon aria-hidden className="size-3.5" />}
      3 days
    </Button>
  );
}

function WaitMenu({ open }: { open: boolean }) {
  const [wait, setWait] = useState("3");
  const [then, setThen] = useState("follow-up");
  return (
    <DropdownMenu open={open} modal={false}>
      <DropdownMenuTrigger asChild>
        <WaitButton kind={then === "follow-up" ? "follow-up" : "reminder"} open={open} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[12.5rem]">
        <DropdownMenuLabel>If nobody replies in</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={wait} onValueChange={setWait}>
          {WAITS.map((item) => (
            <DropdownMenuRadioItem key={item.label} value={item.value}>
              {item.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Then</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={then} onValueChange={setThen}>
          <DropdownMenuRadioItem value="remind">Remind me</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="follow-up">Send a follow-up</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FollowUpBlock({ written }: { written: boolean }) {
  const [text, setText] = useState(written ? WRITTEN_FOLLOW_UP : "");
  return (
    <section aria-labelledby="follow-up-heading" className="mt-1 mb-1 flex flex-col gap-2.5 rounded-xl bg-white/[0.035] px-3 pt-3 pb-3">
      <div className="flex items-start gap-2">
        <FollowUpIcon aria-hidden className="text-primary-foreground mt-px size-3.5 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <h3 id="follow-up-heading">Follow-up</h3>
          <p className="caption-style text-subtle">Sent in the same thread in 3 working days if nobody replies.</p>
        </div>
        <Button variant="ghost" size="sm" className="-mt-1.5 -mr-1.5">
          Remove
        </Button>
      </div>
      <label htmlFor="follow-up-text" className="sr-only">
        Follow-up message
      </label>
      <Textarea
        id="follow-up-text"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Leave empty and Orbit writes it in your voice when it's due"
        rows={3}
        className="field-sizing-content max-h-40 min-h-[4.75rem] resize-none"
      />
    </section>
  );
}

function Toolbar({ wait }: { wait: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1 pt-2">
      <Button variant="primary" type="button">
        Send
      </Button>
      <Button variant="ghost" size="icon" aria-label="Send later" title="Send later">
        <ClockIcon aria-hidden className="size-3.5" />
      </Button>
      {wait}
      <AttachButton id="mock-attach" onFiles={() => undefined} compact />
      <Button variant="ghost" size="icon" aria-label="Write with AI" title="Write with AI">
        <SparkleIcon aria-hidden className="size-3.5" />
      </Button>
      <Button variant="ghost" size="icon" aria-label="Bold" aria-pressed={false} title="Bold">
        <BoldIcon aria-hidden className="size-3.5" />
      </Button>
      <Button variant="ghost" size="icon" aria-label="Italic" aria-pressed={false} title="Italic">
        <ItalicIcon aria-hidden className="size-3.5" />
      </Button>
      <span role="status" className="caption-style text-subtle ml-2 min-w-0 truncate max-sm:hidden">
        Saved in Outlook
      </span>
      <Button variant="ghost" size="icon" aria-label="Discard draft" title="Discard draft" className="ml-auto">
        <TrashIcon aria-hidden className="size-3.5" />
      </Button>
    </div>
  );
}

export function ComposerCard({ mode }: { mode: ComposerMode }) {
  const [to, setTo] = useState<MailAddress[]>([JANE]);
  const [subject, setSubject] = useState("Acme pilot: proposal and next steps");
  const [body, setBody] = useState(BODY);
  const title = subject;
  return (
    <div
      role="dialog"
      aria-label={title}
      data-mock-card=""
      className={cn(
        "border-line-strong bg-popover shadow-overlay pointer-events-auto fixed z-[41] flex flex-col overflow-hidden rounded-2xl border",
        "inset-x-2 bottom-2 h-[85dvh] md:inset-x-auto md:right-4 md:bottom-4 md:h-[min(34rem,calc(100dvh-2rem))] md:w-[34rem]",
      )}
    >
      <div className="flex shrink-0 items-center gap-2 py-2 pr-2 pl-4 select-none">
        <span className="text-foreground min-w-0 flex-1 truncate text-[13px] font-medium">{title}</span>
        <Button variant="ghost" size="icon-sm" aria-label={`Minimise ${title}`} title="Minimise">
          <svg aria-hidden width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
            <path d="M5 12h14" />
          </svg>
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label={`Close ${title}, keeping the draft`} title="Close (the draft stays in Outlook)">
          <svg aria-hidden width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
            <path d="M6 6 18 18M18 6 6 18" />
          </svg>
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <form aria-label="New email" onSubmit={(event) => event.preventDefault()} className="flex min-h-0 flex-1 flex-col gap-1 px-4 pt-1 pb-3">
          <RecipientField
            label="To"
            value={to}
            onChange={setTo}
            trailing={
              <button
                type="button"
                className="caption-style text-subtle hover:text-foreground shrink-0 cursor-pointer rounded-full px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                Cc Bcc
              </button>
            }
          />
          <div className="mt-1 flex items-center gap-2">
            <label htmlFor="mock-subject" className="sr-only">
              Subject
            </label>
            <input
              id="mock-subject"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              placeholder="Subject"
              className="text-foreground placeholder:text-subtle h-8 min-w-0 flex-1 bg-transparent text-[16px] font-medium outline-none"
            />
          </div>
          <BodyEditor
            value={body}
            onChange={setBody}
            onFiles={() => undefined}
            onFileLink={() => undefined}
            onFormats={() => undefined}
            label="Message"
            placeholder="Write your email"
            fill
          />
          {mode !== "menu" && <FollowUpBlock written={mode === "written"} />}
          <Toolbar wait={mode === "menu" ? <WaitMenu open /> : <WaitButton kind="follow-up" />} />
        </form>
      </div>
    </div>
  );
}

export function ToolbarComparison() {
  return (
    <div className="mx-auto flex w-full max-w-[34rem] flex-col gap-4 px-4 py-10">
      {(
        [
          ["No reminder", "none"],
          ["Remind me in 3 days", "reminder"],
          ["Follow-up in 3 days", "follow-up"],
        ] as const
      ).map(([label, kind]) => (
        <div key={kind} data-mock-compare="" className="border-line-strong bg-popover flex flex-col gap-1 rounded-2xl border px-4 pt-3 pb-3">
          <span className="caption-style text-subtle">{label}</span>
          <Toolbar wait={<WaitButton kind={kind} />} />
        </div>
      ))}
    </div>
  );
}
