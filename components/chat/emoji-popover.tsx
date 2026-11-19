"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/_ui/popover";

const EmojiPicker = dynamic(() => import("@/components/chat/emoji-picker"), {
  ssr: false,
  loading: () => (
    <p role="status" className="caption-style text-subtle grid h-[372px] w-[340px] max-w-[calc(100vw-32px)] place-items-center">
      Loading emoji…
    </p>
  ),
});

export default function EmojiPopover({
  open,
  onOpenChange,
  userId,
  onPick,
  side = "top",
  align = "end",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  onPick: (emoji: string) => void;
  side?: "top" | "bottom";
  align?: "start" | "end";
  children: ReactNode;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      {open && (
        <PopoverContent side={side} align={align} aria-label="Emoji" className="p-0" onCloseAutoFocus={(event) => event.preventDefault()}>
          <EmojiPicker
            userId={userId}
            onPick={(emoji) => {
              onOpenChange(false);
              onPick(emoji);
            }}
          />
        </PopoverContent>
      )}
    </Popover>
  );
}
