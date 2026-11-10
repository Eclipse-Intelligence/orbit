import type { ComponentProps, ReactNode } from "react";
import Button from "@/components/_ui/button";
import { cn } from "@/lib/utils";

type FilterChipProps = Omit<ComponentProps<typeof Button>, "variant" | "size" | "href"> & {
  active?: boolean;
  count?: number;
  countTone?: "primary" | "soft";
  icon?: ReactNode;
  trailing?: ReactNode;
};

export default function FilterChip({ active = false, count = 0, countTone = "soft", icon, trailing, className, children, ...props }: FilterChipProps) {
  return (
    <Button variant="chip" size="chip" data-active={active} className={cn("max-w-[14em]", className)} {...props}>
      {icon}
      <span className="truncate">{children}</span>
      {count > 0 && <span className={cn("tabular-nums", countTone === "primary" ? "text-primary-foreground" : "text-soft")}>{count}</span>}
      {trailing}
    </Button>
  );
}
