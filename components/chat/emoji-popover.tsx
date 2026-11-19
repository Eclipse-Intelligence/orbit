"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";

const EmojiPicker = dynamic(() => import("@/components/chat/emoji-picker"), {
  ssr: false,
  loading: () => (
    <p role="status" className="caption-style text-subtle grid h-[372px] w-[340px] max-w-[calc(100vw-32px)] place-items-center">
      Loading emoji…
    </p>
  ),
});

function coarsePointer() {
  return typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
}

export default function EmojiPopover({
  open,
  onOpenChange,
  onPick,
  trigger,
  side = "top",
  align = "end",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (emoji: string) => void;
  trigger?: boolean;
  side?: "top" | "bottom";
  align?: "start" | "end";
  children: ReactNode;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {trigger ? <PopoverTrigger asChild>{children}</PopoverTrigger> : <PopoverAnchor asChild>{children}</PopoverAnchor>}
      {open && (
        <PopoverContent
          side={side}
          align={align}
          aria-label="Emoji"
          className="p-0"
          onOpenAutoFocus={(event) => {
            if (coarsePointer()) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <EmojiPicker
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
