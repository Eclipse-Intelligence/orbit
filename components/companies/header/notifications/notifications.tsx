"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import { useNotifications } from "@/components/crm/attention";
import { markNotificationsReadAction } from "@/app/(crm)/workflows/actions";
import { relativeWhen } from "@/lib/companies";
import { captureSummary } from "@/lib/crm/capture-format";
import { linkInWorkspace } from "@/lib/open-link";
import { cn } from "@/lib/utils";
import { captureLeft, useCompaniesStore } from "@/stores/companies-store";
import BellIcon from "@/public/assets/images/companies/header/bell.svg";
import ChevronRightIcon from "@/public/assets/images/_common/chevron-right.svg";
import CaptureIcon from "@/public/assets/images/companies/sidebar/mail.svg";

export default function Notifications({ workspaceId }: { workspaceId?: string }) {
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState<string[]>([]);
  const router = useRouter();
  const updates = useNotifications();
  const capture = useCompaniesStore((state) => state.capture);
  const cleared = useCompaniesStore((state) => state.captureCleared);
  const waiting = captureLeft(capture, cleared);
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
        <Button
          variant="secondary"
          size="icon"
          aria-label={unread.length > 0 ? "Notifications, unread" : "Notifications"}
          data-shortcut="notifications"
          title="Notifications (⇧N)"
          className="data-[state=open]:bg-muted relative"
        >
          <BellIcon aria-hidden className="size-3.5" />
          {unread.length > 0 && <span className="bg-danger absolute top-1 right-1 size-1.5 rounded-full" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(360px,calc(100vw-2rem))]">
        <div className="flex max-h-[min(560px,calc(100dvh-6rem))] flex-col gap-3 overflow-auto px-4 py-5">
          <h2>Notifications</h2>
          {waiting.total > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-auto w-full items-center justify-start gap-2.5 rounded-lg bg-white/[0.04] px-2.5 py-2.5 text-left whitespace-normal"
              onClick={() => {
                setOpen(false);
                router.push("/capture");
              }}
            >
              <span aria-hidden className="bg-primary text-primary-foreground flex size-6 shrink-0 items-center justify-center rounded-full">
                <CaptureIcon className="size-3" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-foreground text-[14px] leading-5">{waiting.total} waiting in Capture</span>
                <span className="caption-style text-subtle">{captureSummary(waiting.sections)}</span>
              </span>
              <ChevronRightIcon aria-hidden className="text-subtle size-3 shrink-0" />
            </Button>
          )}
          {updates.length > 0 ? (
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
                        if (!item.href) return;
                        const target = linkInWorkspace(item.href, workspaceId);
                        if (target.reload) window.location.assign(target.path);
                        else router.push(target.path);
                      }}
                    >
                      <span aria-hidden className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", fresh ? "bg-primary" : "bg-transparent")} />
                      <span className="flex min-w-0 flex-col gap-1">
                        <span className="text-foreground text-[14px] leading-5">{item.title}</span>
                        {item.body && <span className="caption-style text-subtle line-clamp-2 whitespace-pre-line">{item.body}</span>}
                        <span className="caption-style text-subtle">{relativeWhen(item.createdAt)}</span>
                      </span>
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : (
            waiting.total === 0 && <p className="caption-style text-subtle">No notifications</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
