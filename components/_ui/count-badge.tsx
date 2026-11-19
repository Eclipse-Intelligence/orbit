import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export default function CountBadge({
  className,
  ...props
}: ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "caption-style inline-flex h-4 min-w-6 shrink-0 items-center justify-center rounded-md px-1 text-center text-faint tabular-nums",
        className,
      )}
      {...props}
    />
  );
}
