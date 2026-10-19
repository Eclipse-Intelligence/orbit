"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import { useAttention, useNotifications } from "@/components/crm/attention";
import { markNotificationsReadAction } from "@/app/(crm)/workflows/actions";
import { relativeWhen } from "@/lib/companies";
import { companyHref } from "@/lib/crm/hrefs";
import { tasksHref } from "@/lib/crm/task-views";
import { cn } from "@/lib/utils";
import BellIcon from "@/public/assets/images/companies/header/bell.svg";

export default function Notifications() {
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState<string[]>([]);
  const router = useRouter();
  const items = useAttention();
  const updates = useNotifications();
  const unread = updates.filter((item) => !item.readAt && !read.includes(item.id));

  function toggle(next: boolean) {
    setOpen(next);
    if (next && unread.length > 0) {
      const ids = unread.map((item) => item.id);
      void markNotificationsReadAction(ids).then(() => setRead((current) => [...current, ...ids]));
    }
  }

  return (
    <Popover open={open} onOpenChange={toggle}>
      <PopoverTrigger asChild>
        <Button variant="secondary" size="icon" aria-label="Notifications" data-shortcut="notifications" title="Notifications (⇧N)" className="data-[state=open]:bg-muted relative">
          <BellIcon aria-hidden className="size-3.5" />
          {(items.length > 0 || unread.length > 0) && (
            <span className="bg-danger absolute top-1 right-1 size-1.5 rounded-full" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(360px,calc(100vw-2rem))]">
        <div className="flex max-h-[min(560px,calc(100dvh-6rem))] flex-col gap-3 overflow-auto px-4 py-5">
          <h2>Notifications</h2>
          {updates.length > 0 && (
            <ul className="flex flex-col gap-1">
              {updates.map((item) => {
                const fresh = unread.some((entry) => entry.id === item.id);
                return (
                  <li key={item.id}>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-auto w-full items-start justify-start rounded-lg px-2 py-2 text-left whitespace-normal"
                      onClick={() => {
                        setOpen(false);
                        if (item.href) router.push(item.href);
                      }}
                    >
                      <span aria-hidden className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", fresh ? "bg-primary" : "bg-transparent")} />
                      <span className="flex min-w-0 flex-col gap-1">
                        <span className="text-[14px] leading-5">{item.title}</span>
                        {item.body && <span className="caption-style text-subtle line-clamp-2 whitespace-pre-line">{item.body}</span>}
                        <span className="caption-style text-subtle">{relativeWhen(item.createdAt)}</span>
                      </span>
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          {items.length === 0 ? (
            updates.length === 0 && <p className="caption-style text-subtle">No tasks are due.</p>
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
                      if (item.companyId) router.push(companyHref(item.companyId));
                      else router.push(tasksHref("today"));
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
          <Button variant="subtle" size="sm" href={tasksHref("today")} className="self-start">
            Open tasks
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
