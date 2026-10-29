import type { ReactNode } from "react";
import type { Person } from "@/components/docs-mockup/data";
import { cn } from "@/lib/utils";
import BracesIcon from "@/public/assets/images/_common/braces.svg";
import SparkleIcon from "@/public/assets/images/assistant/sparkle.svg";

const SIZES = {
  xs: "size-4 text-[8px]",
  sm: "size-5 text-[9px]",
  md: "size-6 text-[10px]",
  lg: "size-7 text-[11px]",
} as const;

const ICON_SIZES = { xs: "size-2.5", sm: "size-3", md: "size-3.5", lg: "size-4" } as const;

export function PersonAvatar({ person, size = "md", ring, className }: { person: Person; size?: keyof typeof SIZES; ring?: boolean; className?: string }) {
  if (person.agent === "assistant") {
    return (
      <span
        aria-hidden
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-[30%] bg-[linear-gradient(140deg,#6d5cff,#4124fb_60%,#2f17c9)] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25)]",
          SIZES[size],
          ring && "ring-background ring-2",
          className,
        )}
      >
        <SparkleIcon className={ICON_SIZES[size]} />
      </span>
    );
  }
  if (person.agent === "mcp") {
    return (
      <span
        aria-hidden
        className={cn(
          "bg-muted text-soft inline-flex shrink-0 items-center justify-center rounded-[30%] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]",
          SIZES[size],
          ring && "ring-background ring-2",
          className,
        )}
      >
        <BracesIcon className={ICON_SIZES[size]} />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full leading-none font-medium", SIZES[size], ring && "ring-background ring-2", className)}
      style={{
        background: `color-mix(in srgb, ${person.color} 26%, #1c1c1c)`,
        color: `color-mix(in srgb, ${person.color} 70%, #f9fbff)`,
      }}
    >
      {person.initials}
    </span>
  );
}

export function PresenceStack({ people, label, size = "md" }: { people: Person[]; label?: string; size?: keyof typeof SIZES }) {
  return (
    <div role="group" aria-label={label ?? `Here now: ${people.map((person) => person.name).join(", ")}`} className="flex items-center -space-x-1">
      {people.map((person) => (
        <span key={person.id} title={person.name} className="relative flex">
          <PersonAvatar person={person} size={size} ring />
          {person.agent === "assistant" && (
            <span aria-hidden className="ring-background absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-[#8b7bff] ring-2" />
          )}
        </span>
      ))}
    </div>
  );
}

export function HumanCursor({ person }: { person: Person }) {
  return (
    <span className="relative inline-block h-[1em] w-0 align-baseline">
      <span aria-hidden className="absolute -top-[4px] -bottom-[5px] left-[1px] inline-block w-[2px] rounded-full" style={{ background: person.color }} />
      <span
        aria-hidden
        className="absolute -top-[3px] left-[6px] rounded-[4px] rounded-tl-none px-1.5 py-[2px] text-[10.5px] leading-[13px] font-medium whitespace-nowrap text-[#161616]"
        style={{ background: person.color }}
      >
        {person.short}
      </span>
      <span className="sr-only">{person.name} is editing here</span>
    </span>
  );
}

export function AgentCursor({ person }: { person: Person }) {
  return (
    <span className="relative inline-block h-[1em] w-0 align-baseline">
      <span aria-hidden className="absolute -top-[4px] -bottom-[5px] left-[1px] inline-block w-[2px] rounded-full bg-[#8b7bff] shadow-[0_0_10px_2px_rgba(139,123,255,0.55)]" />
      <span
        aria-hidden
        className="absolute top-[calc(100%+9px)] left-[-1px] flex items-center gap-1 rounded-full bg-[linear-gradient(140deg,#6d5cff,#4124fb)] py-[3px] pr-2 pl-1.5 text-[10.5px] leading-[13px] font-medium whitespace-nowrap text-white shadow-[0_6px_16px_rgba(65,36,251,0.35)]"
      >
        <SparkleIcon className="size-2.5" />
        {person.short}
        <span className="flex items-center gap-[2px] pl-0.5">
          <span className="size-[3px] rounded-full bg-white/90" />
          <span className="size-[3px] rounded-full bg-white/60" />
          <span className="size-[3px] rounded-full bg-white/30" />
        </span>
      </span>
      <span className="sr-only">{person.name} is writing here</span>
    </span>
  );
}

export function AgentInsertion({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-[3px] bg-[linear-gradient(90deg,rgba(139,123,255,0.10),rgba(139,123,255,0.24))] box-decoration-clone px-[1px] text-[#e4e0ff] shadow-[inset_0_-1px_0_rgba(139,123,255,0.55)]">
      {children}
    </span>
  );
}
