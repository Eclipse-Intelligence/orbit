"use client";

import { cn } from "@/lib/utils";

export default function Switch({
  checked,
  onChange,
  label,
  id,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  id?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "focus-visible:ring-ring/60 relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ease-power3-out outline-none focus-visible:ring-2",
        checked ? "bg-primary" : "bg-muted shadow-[inset_0px_0px_0px_1px_rgba(255,255,255,0.08)]",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-4 rounded-full bg-white shadow-[0px_1px_2px_0px_rgba(0,0,0,0.4)] transition-transform duration-200 ease-power3-out",
          checked ? "translate-x-[18px]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
