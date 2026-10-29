"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { EditorView } from "@codemirror/view";
import Button from "@/components/_ui/button";
import { insertAtCursor, toggleChecklist, toggleHeading } from "@/lib/docs/editor/setup";
import CheckSquareIcon from "@/public/assets/images/docs/check-square.svg";
import HeadingIcon from "@/public/assets/images/docs/heading.svg";

function useKeyboardInset() {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setInset(Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop)));
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}

export default function PhoneToolbar({ view, children, entry = false }: { view: EditorView; children?: ReactNode; entry?: boolean }) {
  const inset = useKeyboardInset();
  const keep = (event: { preventDefault: () => void }) => event.preventDefault();
  const items = [
    { label: "Link a note", text: "[[" },
    { label: "Tag", text: "#" },
    { label: "Mention a record", text: "@" },
  ];
  return (
    <div
      className="bg-popover border-line-strong fixed inset-x-0 z-50 rounded-t-2xl border-t pb-[env(safe-area-inset-bottom)] shadow-[0_-16px_40px_rgba(0,0,0,0.5)] md:hidden"
      style={{ bottom: inset }}
      onPointerDown={keep}
    >
      {children}
      <div role="toolbar" aria-label="Formatting" className="border-line-strong flex items-center gap-1 px-2 py-1.5 [&:not(:first-child)]:border-t">
        {items.map((item) => (
          <Button key={item.label} variant="ghost" size="icon" aria-label={item.label} className="size-10 text-[15px] font-medium" onPointerDown={keep} onClick={() => insertAtCursor(view, item.text)}>
            {item.text}
          </Button>
        ))}
        <Button variant="ghost" size="icon" aria-label="Checkbox" className="size-10" onPointerDown={keep} onClick={() => toggleChecklist(view)}>
          <CheckSquareIcon aria-hidden className="size-4" />
        </Button>
        {!entry && (
          <Button variant="ghost" size="icon" aria-label="Heading" className="size-10" onPointerDown={keep} onClick={() => toggleHeading(view)}>
            <HeadingIcon aria-hidden className="size-4" />
          </Button>
        )}
        <span className="flex-1" />
        <Button variant="secondary" size="sm" className="h-8 px-3" onClick={() => view.contentDOM.blur()}>
          Done
        </Button>
      </div>
    </div>
  );
}
