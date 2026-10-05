"use client";

import { useState } from "react";
import Button from "@/components/_ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import BellIcon from "@/public/assets/images/companies/header/bell.svg";

export default function Notifications() {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="secondary" size="icon" aria-label="Notifications" className="data-[state=open]:bg-muted">
          <BellIcon aria-hidden className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(360px,calc(100vw-2rem))]">
        <div className="flex flex-col gap-2 px-4 py-5">
          <h2>Notifications</h2>
          <p className="caption-style text-subtle">
            Not available yet. Mentions and follow-ups will show up here once activities
            and next actions are recorded.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
