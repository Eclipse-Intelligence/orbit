"use client";

import { useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import { firstName, mailFullWhen } from "@/lib/mail/format";
import type { MailAddress } from "@/lib/mail/types";
import { cn } from "@/lib/utils";
import EyeIcon from "@/public/assets/images/mail/eye.svg";

export function readLabel(opens: { at: string }[], recipients: MailAddress[]) {
  if (opens.length === 0) return "Not read yet";
  const who = recipients.length === 1 ? `Read by ${firstName(recipients[0])}` : "Read";
  return opens.length > 1 ? `${who} · ${opens.length} times` : who;
}

export default function ReadStatus({
  opens,
  recipients,
}: {
  opens: { at: string; agent: string | null }[];
  recipients: MailAddress[];
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
            "ease-power3-out inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-full px-2 text-[12px] transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
            read ? "text-status bg-[color-mix(in_srgb,var(--status)_10%,transparent)] hover:bg-[color-mix(in_srgb,var(--status)_16%,transparent)]" : "text-subtle hover:bg-white/[0.04]",
          )}
        >
          <EyeIcon aria-hidden className="size-3" />
          {readLabel(opens, recipients)}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[18rem] p-1" onMouseEnter={show} onMouseLeave={hide}>
        {read ? (
          <ol aria-label="Times this email was opened" className="flex max-h-64 flex-col overflow-y-auto">
            {opens.map((item, index) => (
              <li key={`${item.at}-${index}`} className="flex items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-[13px]">
                <span className="text-foreground tabular-nums">{mailFullWhen(item.at)}</span>
                <span className="text-subtle truncate">{item.agent ?? "Unknown device"}</span>
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
