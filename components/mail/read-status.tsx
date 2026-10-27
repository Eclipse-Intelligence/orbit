"use client";

import { useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import { afterSending, mailFullWhen, personName } from "@/lib/mail/format";
import type { MailAddress } from "@/lib/mail/types";
import { cn } from "@/lib/utils";
import EyeIcon from "@/public/assets/images/mail/eye.svg";

function readLabel(opens: { at: string }[], recipients: MailAddress[]) {
  if (opens.length === 0) return "Unread";
  return recipients.length === 1 ? `Read by ${personName(recipients[0])}` : "Read";
}

export default function ReadStatus({
  opens,
  recipients,
  sentAt = null,
}: {
  opens: { at: string; agent: string | null }[];
  recipients: MailAddress[];
  sentAt?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const closing = useRef<number | null>(null);
  const read = opens.length > 0;

  function show() {
    if (closing.current) window.clearTimeout(closing.current);
    setOpen(true);
  }

  function hide() {
    closing.current = window.setTimeout(() => setOpen(false), 150);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onMouseEnter={show}
          onMouseLeave={hide}
          className={cn(
            "ease-power3-out inline-flex cursor-pointer items-center gap-1.5 rounded-sm text-[13px] transition-colors duration-150 outline-none hover:underline hover:underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring/60",
            read ? "text-status" : "text-subtle",
          )}
        >
          <EyeIcon aria-hidden className="size-3.5" />
          {readLabel(opens, recipients)}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[18rem] p-1" onMouseEnter={show} onMouseLeave={hide}>
        {read ? (
          <p className="caption-style text-subtle px-2.5 pt-1.5 pb-1">
            Opened {opens.length === 1 ? "once" : `${opens.length} times`}
          </p>
        ) : null}
        {read ? (
          <ol aria-label="Times this email was opened" className="flex max-h-64 flex-col overflow-y-auto">
            {opens.map((item, index) => (
              <li key={`${item.at}-${index}`} className="flex flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-[13px]">
                <span className="flex items-center justify-between gap-3">
                  <span className="text-foreground tabular-nums">{mailFullWhen(item.at)}</span>
                  <span className="text-subtle truncate">{item.agent ?? "Unknown device"}</span>
                </span>
                {afterSending(item.at, sentAt) && <span className="caption-style text-subtle tabular-nums">{afterSending(item.at, sentAt)}</span>}
              </li>
            ))}
          </ol>
        ) : (
          <p className="caption-style text-subtle px-2.5 py-2">Orbit shows each time this email is opened. Some apps block images, so a read can be missed.</p>
        )}
      </PopoverContent>
    </Popover>
  );
}
