"use client";

import Button from "@/components/_ui/button";
import { useChat } from "@/components/chat/chat-context";
import { scheduledHere, scheduledWhen } from "@/lib/chat/scheduled";
import { cn } from "@/lib/utils";
import ClockIcon from "@/public/assets/images/chat/clock.svg";
import { useChatScheduled } from "@/stores/chat-scheduled-store";

export default function ScheduledNote({ conversationId, parentId, className }: { conversationId: string; parentId: string | null; className?: string }) {
  const { go, now } = useChat();
  const items = useChatScheduled((store) => store.items);
  const here = scheduledHere(items, conversationId, parentId);
  if (here.length === 0) return null;
  const waiting = here.filter((item) => item.status !== "failed");
  const failed = here.length - waiting.length;
  const next = waiting[0];
  const label = [
    waiting.length === 0 ? null : waiting.length === 1 ? "1 scheduled message" : `${waiting.length} scheduled messages`,
    waiting.length === 0 ? null : scheduledWhen(next.sendAt, now),
    failed === 0 ? null : waiting.length === 0 ? (failed === 1 ? "1 scheduled message wasn't sent" : `${failed} scheduled messages weren't sent`) : failed === 1 ? "1 wasn't sent" : `${failed} weren't sent`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className={cn("flex items-center gap-2 px-1 pb-1.5", className)}>
      <ClockIcon aria-hidden className={cn("size-3.5 shrink-0", waiting.length === 0 ? "text-danger" : "text-subtle")} />
      <p className={cn("caption-style min-w-0 flex-1", waiting.length === 0 ? "text-danger" : "text-subtle")}>{label}</p>
      <Button variant="ghost" size="sm" onClick={() => go({ view: { kind: "scheduled" }, thread: null, message: null })} className="hit shrink-0 max-md:h-11">
        View
      </Button>
    </div>
  );
}
