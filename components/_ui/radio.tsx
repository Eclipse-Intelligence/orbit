import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

function Radio({ className, ...props }: Omit<ComponentProps<"input">, "type">) {
  return (
    <input
      type="radio"
      data-slot="radio"
      className={cn(
        "bg-transparent shadow-[inset_0_0_0_1.5px_rgb(255_255_255/0.22)] hover:shadow-[inset_0_0_0_1.5px_rgb(255_255_255/0.35)] checked:bg-primary checked:shadow-none focus-visible:ring-ring/60 relative size-4 shrink-0 cursor-pointer appearance-none rounded-full outline-none transition-[background-color,box-shadow] duration-150 ease-power3-out before:absolute before:inset-[4px] before:rounded-full before:bg-white before:opacity-0 checked:before:opacity-100 focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Radio };
