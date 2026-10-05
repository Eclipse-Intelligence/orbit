import type { MouseEvent } from "react";
import {
  CONNECTION_STRENGTH,
  connectionStrength,
  type ConnectionStrength,
} from "@/lib/companies";
import type { Lifecycle } from "@/lib/crm/types";
import { cn } from "@/lib/utils";

const TAG_PALETTE = [
  "oklch(0.76 0.13 70)",
  "oklch(0.77 0.16 122)",
  "oklch(0.80 0.15 101)",
  "oklch(0.62 0.18 293)",
  "oklch(0.71 0.16 48)",
  "oklch(0.72 0.10 221)",
  "oklch(0.64 0.19 27)",
  "oklch(0.66 0.21 323)",
  "oklch(0.70 0.13 162)",
  "oklch(0.67 0.19 3)",
];

const LIFECYCLE_BASE: Record<Lifecycle, string> = {
  lead: TAG_PALETTE[0],
  prospect: TAG_PALETTE[5],
  customer: TAG_PALETTE[8],
  churned: "oklch(0.62 0.01 260)",
};

export function tagBase(label: string) {
  let hash = 0;
  for (const char of label) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return TAG_PALETTE[hash % TAG_PALETTE.length];
}

export function Monogram({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  const letter = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      aria-hidden
      className={cn(
        "bg-secondary text-subtle inline-flex size-5 shrink-0 items-center justify-center rounded-md text-[10px] leading-none font-medium",
        className,
      )}
    >
      {letter}
    </span>
  );
}

export function RecordTag({
  label,
  base,
}: {
  label: string;
  base?: string;
}) {
  const color = base ?? tagBase(label);
  return (
    <span
      className="inline-flex h-[23px] max-w-[115px] shrink-0 items-center truncate rounded-lg border px-1.5 text-[13px] leading-none font-medium"
      style={{
        borderColor: `color-mix(in srgb, ${color} 32%, var(--card))`,
        color: `color-mix(in srgb, ${color} 92%, var(--foreground))`,
        background: `color-mix(in srgb, ${color} 18%, var(--card))`,
      }}
    >
      {label}
    </span>
  );
}

export function lifecycleTagBase(lifecycle: Lifecycle) {
  return LIFECYCLE_BASE[lifecycle];
}

export function ConnectionMark({
  at,
  className,
}: {
  at: string | null | undefined;
  className?: string;
}) {
  const key: ConnectionStrength = connectionStrength(at);
  const item = CONNECTION_STRENGTH[key];
  return (
    <span className={cn("text-subtle inline-flex items-center gap-2 text-[13px]", className)}>
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ background: item.color }}
      />
      {item.label}
    </span>
  );
}

export function EntityChip({
  name,
  href,
  onClick,
}: {
  name: string;
  href?: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const body = (
    <>
      <Monogram name={name} className="size-4 rounded-full text-[9px]" />
      <span className="max-w-[12em] truncate">{name}</span>
    </>
  );
  const className =
    "bg-secondary text-foreground inline-flex shrink-0 items-center gap-1 rounded-full py-px pr-2 pl-0.5 align-middle text-[12px] leading-5";
  if (!href) return <span className={className}>{body}</span>;
  return (
    <a href={href} onClick={onClick} className={className}>
      {body}
    </a>
  );
}
