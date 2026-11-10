"use client";

import { useEffect, useRef, useState } from "react";
import Button from "@/components/_ui/button";
import LinkedText from "@/components/_ui/linked-text";
import { cn } from "@/lib/utils";

export default function EventNotes({ id, text }: { id: string; text: string }) {
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const notesRef = useRef<HTMLParagraphElement>(null);
  const notesId = `event-notes-${id}`;

  useEffect(() => {
    const element = notesRef.current;
    if (!element || open) return;
    const observer = new ResizeObserver(() => setLong(element.scrollHeight > element.clientHeight + 1));
    observer.observe(element);
    return () => observer.disconnect();
  }, [open, text]);

  return (
    <div className="flex flex-col items-start gap-1.5">
      <span className="caption-style text-subtle">Description</span>
      <p
        ref={notesRef}
        id={notesId}
        className={cn("caption-style text-soft w-full leading-[1.5] whitespace-pre-line [overflow-wrap:anywhere]", !open && "line-clamp-[8]")}
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
