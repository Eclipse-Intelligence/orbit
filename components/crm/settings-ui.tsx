"use client";

import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";

export function SettingsPage({
  title,
  description,
  action,
  children,
  wide,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full flex-col gap-6",
        wide ? "max-w-[72em]" : "max-w-[47.5em]",
      )}
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-2">
          <h2 className="text-[18px] leading-6 font-semibold">{title}</h2>
          <p className="text-subtle text-[14px] leading-5">{description}</p>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

export function SettingsCard({
  id,
  title,
  description,
  action,
  children,
  className,
}: {
  id?: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const headingId = useId();
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cn(
        "border-sidebar-border bg-sidebar-accent scroll-mt-4 rounded-xl border",
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-4 sm:px-5">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <h3 id={headingId} className="leading-5 font-medium">
            {title}
          </h3>
          {description && (
            <div className="caption-style text-subtle leading-[1.4]">
              {description}
            </div>
          )}
        </div>
        {action && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {action}
          </div>
        )}
      </div>
      {children && (
        <div className="border-border flex flex-col gap-3 border-t px-4 py-4 sm:px-5">
          {children}
        </div>
      )}
    </section>
  );
}

export function SettingsDisclosure({
  title,
  summary,
  children,
  defaultOpen = false,
  className,
}: {
  title: string;
  summary?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  return (
    <div
      className={cn("border-border flex flex-col rounded-lg border", className)}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="focus-visible:ring-ring/60 flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors duration-150 outline-none hover:bg-white/4 focus-visible:ring-2"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[14px] leading-5">{title}</span>
          {summary && (
            <span className="caption-style text-subtle leading-[1.4]">
              {summary}
            </span>
          )}
        </span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "text-subtle ease-power3-out size-3 shrink-0 transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </button>
      <div
        id={panelId}
        hidden={!open}
        className="border-border flex flex-col gap-3 border-t px-3 py-3"
      >
        {children}
      </div>
    </div>
  );
}
