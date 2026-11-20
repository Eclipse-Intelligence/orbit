"use client";

import { useState } from "react";
import Button from "@/components/_ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/_ui/dropdown-menu";
import LaterPicker from "@/components/mail/later-picker";
import { sendLaterChoices, type SendLaterChoice } from "@/lib/chat/scheduled";
import { zoneLabel } from "@/lib/time";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import ClockIcon from "@/public/assets/images/chat/clock.svg";

export default function SendLaterMenu({ disabled, phone, onPick }: { disabled: boolean; phone?: boolean; onPick: (sendAt: string) => void }) {
  const [choices, setChoices] = useState<SendLaterChoice[]>([]);
  const [custom, setCustom] = useState<number | null>(null);

  return (
    <>
      <DropdownMenu onOpenChange={(open) => open && setChoices(sendLaterChoices(Date.now()))}>
        <DropdownMenuTrigger asChild>
          {phone ? (
            <Button variant="secondary" size="none" aria-label="Send later" title="Send later" disabled={disabled} onMouseDown={(event) => event.preventDefault()} className="hit size-[38px] rounded-full">
              <ClockIcon aria-hidden className="size-3.5" />
            </Button>
          ) : (
            <Button
              variant="primary"
              size="none"
              aria-label="Send later"
              title="Send later"
              disabled={disabled}
              onMouseDown={(event) => event.preventDefault()}
              className={cn("border-primary-foreground/25 h-[30px] w-[22px] rounded-l-none border-l", "pointer-coarse:ml-2 pointer-coarse:size-11 pointer-coarse:rounded-lg pointer-coarse:border-l-0")}
            >
              <ChevronDownIcon aria-hidden className="size-3" />
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="min-w-[200px]">
          <DropdownMenuLabel>Send later</DropdownMenuLabel>
          {choices.map((choice) => (
            <DropdownMenuItem key={choice.id} onSelect={() => onPick(choice.at)} className="pointer-coarse:min-h-11">
              {choice.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem onSelect={() => setCustom(Date.now())} className="pointer-coarse:min-h-11">
            Custom time…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <LaterPicker
        request={custom === null ? null : { title: "Send later", description: `Times are ${zoneLabel()} time.`, options: [], now: custom, onPick: (at) => onPick(at) }}
        onClose={() => setCustom(null)}
      />
    </>
  );
}
