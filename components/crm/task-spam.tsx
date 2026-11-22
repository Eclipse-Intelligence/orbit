"use client";

import { useState } from "react";
import Button from "@/components/_ui/button";
import HoldButton from "@/components/_ui/hold-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import { canMarkSpam } from "@/lib/crm/suggested-task";
import type { Task } from "@/lib/crm/types";
import MoreIcon from "@/public/assets/images/_common/more.svg";

export default function TaskSpamMenu({ task, onSpam }: { task: Task; onSpam?: (task: Task) => void }) {
  const [open, setOpen] = useState(false);
  if (!onSpam || !canMarkSpam(task)) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Task actions" title="Task actions" className="hit size-[34px]">
          <MoreIcon aria-hidden className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-1">
        <HoldButton
          size="sm"
          className="w-full"
          holding="Keep holding to mark as spam"
          onConfirm={() => {
            setOpen(false);
            onSpam(task);
          }}
        >
          Hold to mark as spam
        </HoldButton>
      </PopoverContent>
    </Popover>
  );
}
