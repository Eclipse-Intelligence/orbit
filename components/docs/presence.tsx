import type { Participant } from "@/lib/docs/client-types";
import { cn } from "@/lib/utils";
import BracesIcon from "@/public/assets/images/_common/braces.svg";
import SparkleIcon from "@/public/assets/images/assistant/sparkle.svg";

const SIZES = {
  xs: "size-4 text-[8px]",
  sm: "size-5 text-[9px]",
  md: "size-6 text-[10px]",
  lg: "size-7 text-[11px]",
} as const;

const CHIP_SIZES = {
  xs: "h-4 min-w-4 text-[8px]",
  sm: "h-5 min-w-5 text-[9px]",
  md: "h-6 min-w-6 text-[10px]",
  lg: "h-7 min-w-7 text-[11px]",
} as const;

const ICON_SIZES = { xs: "size-2.5", sm: "size-3", md: "size-3.5", lg: "size-4" } as const;

export type AvatarSize = keyof typeof SIZES;

export function ParticipantAvatar({ participant, size = "md", ring, className }: { participant: Participant; size?: AvatarSize; ring?: boolean; className?: string }) {
  if (participant.kind === "assistant") {
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
  if (participant.kind === "mcp") {
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
        background: `color-mix(in srgb, ${participant.color} 26%, #1c1c1c)`,
        color: `color-mix(in srgb, ${participant.color} 70%, #f9fbff)`,
      }}
    >
      {participant.initials}
    </span>
  );
}

export function PresenceStack({ participants, size = "md", label, max }: { participants: Participant[]; size?: AvatarSize; label?: string; max?: number }) {
  if (!participants.length) return null;
  const limit = max !== undefined && participants.length > max ? max : participants.length;
  const shown = participants.slice(0, limit);
  const rest = participants.slice(limit);
  const restNames = rest.map((participant) => participant.name).join(", ");
  return (
    <div role="group" aria-label={label ?? `In this note: ${participants.map((participant) => participant.name).join(", ")}`} className="flex items-center -space-x-1">
      {shown.map((participant) => (
        <span key={participant.id} title={participant.name} className="relative flex">
          <ParticipantAvatar participant={participant} size={size} ring />
          {participant.kind === "assistant" && <span aria-hidden className="ring-background absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-[#8b7bff] ring-2" />}
        </span>
      ))}
      {rest.length > 0 && (
        <span
          role="img"
          aria-label={`${rest.length} more: ${restNames}`}
          title={restNames}
          className={cn("bg-muted text-soft ring-background relative inline-flex shrink-0 items-center justify-center rounded-full px-1 leading-none font-medium tabular-nums ring-2", CHIP_SIZES[size])}
        >
          +{rest.length}
        </span>
      )}
    </div>
  );
}
