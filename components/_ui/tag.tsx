import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const tagVariants = cva(
  "inline-flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap text-[14px] leading-none text-soft before:size-1.5 before:shrink-0 before:rounded-full",
  {
    variants: {
      tone: {
        blue: "before:bg-(--tag-blue-dot)",
        purple: "before:bg-(--tag-purple-dot)",
        green: "before:bg-(--tag-green-dot)",
        moss: "before:bg-(--tag-moss-dot)",
        red: "before:bg-(--tag-red-dot)",
        orange: "before:bg-(--tag-orange-dot)",
        amber: "before:bg-(--tag-amber-dot)",
        teal: "before:bg-(--tag-teal-dot)",
        yellow: "before:bg-(--tag-yellow-dot)",
        neutral: "before:bg-faint",
      },
      size: {
        md: "pr-1.5",
        sm: "pr-1",
      },
    },
    defaultVariants: {
      tone: "neutral",
      size: "md",
    },
  },
);

type TagProps = ComponentProps<"span"> & VariantProps<typeof tagVariants>;

export default function Tag({ tone, size, className, ...props }: TagProps) {
  return (
    <span className={cn(tagVariants({ tone, size }), className)} {...props} />
  );
}
