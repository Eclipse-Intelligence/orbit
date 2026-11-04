"use client";

import { useId, useRef, useState } from "react";
import Button from "@/components/_ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/_ui/dropdown-menu";
import { Textarea } from "@/components/_ui/textarea";
import { cn } from "@/lib/utils";
import BellIcon from "@/public/assets/images/mail/bell.svg";
import FollowUpIcon from "@/public/assets/images/mail/follow-up.svg";

export type NoReplyThen = "remind" | "send";

export type NoReplyChoice = { remindHours: number | null; followUpDays: number | null };

type Wait = { days: number; hours: number; label: string };

const WAITS: Wait[] = [
  { days: 1, hours: 24, label: "1 day" },
  { days: 2, hours: 48, label: "2 days" },
  { days: 3, hours: 72, label: "3 days" },
  { days: 5, hours: 168, label: "1 week" },
];

const TINTED = "text-primary-foreground bg-[color-mix(in_srgb,var(--primary)_28%,transparent)] hover:text-white";

function currentWait(choice: NoReplyChoice): Wait | null {
  if (choice.followUpDays) {
    return WAITS.find((item) => item.days === choice.followUpDays) ?? { days: choice.followUpDays, hours: choice.followUpDays * 24, label: `${choice.followUpDays} days` };
  }
  if (choice.remindHours) {
    const days = Math.max(1, Math.round(choice.remindHours / 24));
    return WAITS.find((item) => item.hours === choice.remindHours) ?? { days, hours: choice.remindHours, label: days === 1 ? "1 day" : `${days} days` };
  }
  return null;
}

export function workingDaysText(days: number) {
  return days === 1 ? "1 working day" : `${days} working days`;
}

export function NoReplyMenu({
  choice,
  then,
  onChange,
}: {
  choice: NoReplyChoice;
  then: NoReplyThen;
  onChange: (choice: NoReplyChoice, then: NoReplyThen) => void;
}) {
  const wait = currentWait(choice);
  const sending = Boolean(choice.followUpDays);
  const label = wait
    ? sending
      ? `Follow-up in ${workingDaysText(wait.days)} if nobody replies`
      : `Remind me if no reply in ${wait.label}`
    : "If nobody replies";

  function pick(value: string) {
    const next = WAITS.find((item) => String(item.days) === value) ?? null;
    if (!next) onChange({ remindHours: null, followUpDays: null }, then);
    else onChange(then === "send" ? { remindHours: null, followUpDays: next.days } : { remindHours: next.hours, followUpDays: null }, then);
  }

  function pickThen(value: string) {
    const next: NoReplyThen = value === "send" ? "send" : "remind";
    if (!wait) onChange(choice, next);
    else onChange(next === "send" ? { remindHours: null, followUpDays: wait.days } : { remindHours: wait.hours, followUpDays: null }, next);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size={wait ? "sm" : "icon"}
          aria-label={label}
          title={label}
          className={cn(wait && TINTED, sending && "shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--primary)_75%,transparent)]")}
        >
          {sending ? <FollowUpIcon aria-hidden className="size-3.5" /> : <BellIcon aria-hidden className="size-3.5" />}
          {wait?.label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[12.5rem]">
        <DropdownMenuLabel>If nobody replies in</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={wait ? String(wait.days) : ""} onValueChange={pick}>
          <DropdownMenuRadioItem value="">Off</DropdownMenuRadioItem>
          {WAITS.map((item) => (
            <DropdownMenuRadioItem key={item.days} value={String(item.days)}>
              {item.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Then</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={sending ? "send" : then} onValueChange={pickThen}>
          <DropdownMenuRadioItem value="remind" onSelect={(event) => !wait && event.preventDefault()}>
            Remind me
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="send" onSelect={(event) => !wait && event.preventDefault()}>
            Send a follow-up
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function FollowUpBlock({ days, body, onBody, onRemove }: { days: number; body: string; onBody: (body: string) => void; onRemove: () => void }) {
  const id = useId();
  const [open, setOpen] = useState(Boolean(body.trim()));
  const field = useRef<HTMLTextAreaElement>(null);
  const when = workingDaysText(days);

  function expand() {
    setOpen(true);
    window.setTimeout(() => field.current?.focus(), 0);
  }

  if (!open && !body.trim()) {
    return (
      <section aria-label="Follow-up" className="animate-rise-in flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-white/[0.035] py-1 pr-1 pl-3">
        <span className="flex min-w-[13rem] flex-1 cursor-text items-center gap-2 py-1.5 text-[13px] leading-5" onClick={expand} title={`Sent in the same thread in ${when} if nobody replies`}>
          <FollowUpIcon aria-hidden className="text-primary-foreground size-3.5 shrink-0" />
          <span className="text-foreground">Follow-up</span>
          <span className="text-soft min-w-0">Orbit writes it when it&apos;s due</span>
        </span>
        <span className="flex items-center gap-1 max-sm:-ml-2">
          <Button variant="ghost" size="sm" onClick={expand}>
            Write it now
          </Button>
          <Button variant="ghost" size="sm" onClick={onRemove}>
            Remove
          </Button>
        </span>
      </section>
    );
  }

  return (
    <section aria-labelledby={`${id}-heading`} className="animate-rise-in mt-1 mb-1 flex flex-col gap-2.5 rounded-xl bg-white/[0.035] px-3 pt-3 pb-3">
      <div className="flex items-start gap-2">
        <FollowUpIcon aria-hidden className="text-primary-foreground mt-px size-3.5 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <h3 id={`${id}-heading`}>Follow-up</h3>
          <p className="caption-style text-subtle">Sent in the same thread in {when} if nobody replies.</p>
        </div>
        <Button variant="ghost" size="sm" className="-mt-1.5 -mr-1.5" onClick={onRemove}>
          Remove
        </Button>
      </div>
      <label htmlFor={`${id}-text`} className="sr-only">
        Follow-up message
      </label>
      <Textarea
        ref={field}
        id={`${id}-text`}
        value={body}
        onChange={(event) => onBody(event.target.value)}
        placeholder="Leave empty and Orbit writes it in your voice when it's due"
        rows={3}
        maxLength={20_000}
        className="field-sizing-content max-h-40 min-h-[4.75rem] resize-none"
      />
    </section>
  );
}
