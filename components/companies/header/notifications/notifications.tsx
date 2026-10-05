"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import { useAttention } from "@/components/crm/attention";
import { relativeWhen } from "@/lib/companies";
import BellIcon from "@/public/assets/images/companies/header/bell.svg";

export default function Notifications() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const items = useAttention();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="secondary" size="icon" aria-label="Notifications" className="data-[state=open]:bg-muted relative">
          <BellIcon aria-hidden className="size-3.5" />
          {items.length > 0 && (
            <span className="bg-danger absolute top-1 right-1 size-1.5 rounded-full" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(360px,calc(100vw-2rem))]">
        <div className="flex flex-col gap-3 px-4 py-5">
          <h2>Notifications</h2>
          {items.length === 0 ? (
            <p className="caption-style text-subtle">No follow-ups are due.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {items.map((item) => (
                <li key={item.id}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto w-full items-start justify-start rounded-lg px-2 py-2 text-left whitespace-normal"
                    onClick={() => {
                      setOpen(false);
                      if (item.companyId) router.push(`/?record=${item.companyId}`);
                      else router.push("/actions?view=today");
                    }}
                  >
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="truncate text-[14px] leading-5">{item.title}</span>
                      <span className="caption-style text-subtle">
                        {[item.overdue ? "Overdue" : "Due", item.companyName, item.dueAt ? relativeWhen(item.dueAt) : "No due date"]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <Button variant="subtle" size="sm" href="/actions?view=today" className="self-start">
            Open next actions
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
