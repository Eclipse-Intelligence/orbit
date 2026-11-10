"use client";

import { useEffect, useRef, useState } from "react";
import Button from "@/components/_ui/button";
import LinkedText from "@/components/_ui/linked-text";
import { cn } from "@/lib/utils";

function hideClippedLinks(element: HTMLElement, clamped: boolean) {
  const limit = element.clientHeight;
  for (const link of element.querySelectorAll("a")) {
    const hidden = clamped && link.offsetTop >= limit;
    link.tabIndex = hidden ? -1 : 0;
    if (hidden) link.setAttribute("aria-hidden", "true");
    else link.removeAttribute("aria-hidden");
  }
}

export default function EventNotes({ id, text }: { id: string; text: string }) {
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const notesRef = useRef<HTMLParagraphElement>(null);
  const notesId = `event-notes-${id}`;

  useEffect(() => {
    const element = notesRef.current;
    if (!element) return;
    if (open) {
      hideClippedLinks(element, false);
      return;
    }
    const observer = new ResizeObserver(() => {
      const clamped = element.scrollHeight > element.clientHeight + 1;
      setLong(clamped);
      hideClippedLinks(element, clamped);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [open, text]);

  return (
    <div className="flex flex-col items-start gap-1.5">
      <span className="caption-style text-subtle">Description</span>
      <p
        ref={notesRef}
        id={notesId}
        className={cn("caption-style text-soft relative w-full whitespace-pre-line [overflow-wrap:anywhere]", !open && "line-clamp-[8]")}
      >
        <LinkedText text={text} />
      </p>
      {(long || open) && (
        <Button
          variant="link"
          size="none"
          className="caption-style text-subtle"
          aria-expanded={open}
          aria-controls={notesId}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Show less" : "Show more"}
        </Button>
      )}
    </div>
  );
}
