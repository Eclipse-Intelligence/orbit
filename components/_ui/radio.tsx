import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

function Radio({ className, ...props }: Omit<ComponentProps<"input">, "type">) {
  return (
    <input
      type="radio"
      data-slot="radio"
      className={cn(
        "border-line-strong bg-secondary checked:border-primary checked:bg-primary focus-visible:ring-ring/60 relative size-4 shrink-0 cursor-pointer appearance-none rounded-full border outline-none transition-[background-color,border-color] duration-150 ease-power3-out before:absolute before:inset-[4px] before:rounded-full before:bg-white before:opacity-0 checked:before:opacity-100 focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Radio };
