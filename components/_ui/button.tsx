import Link from "next/link";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-medium leading-none outline-none select-none transition-[background-color,color,box-shadow,scale] duration-150 ease-power3-out focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary:
          "bg-primary text-primary-foreground shadow-[0px_4px_4px_0px_rgba(42,42,42,0.32),0px_0px_0px_1px_#0e0e0e,inset_0px_4px_6px_0px_rgba(255,255,255,0.2),inset_0px_0px_0px_1px_rgba(255,255,255,0.15),inset_0px_-8px_14px_0px_rgba(0,0,0,0.15)] hover:bg-primary-hover active:scale-[0.97]",
        secondary:
          "bg-secondary text-secondary-foreground shadow-[0px_0px_0px_1px_rgba(0,0,0,0.4),inset_0px_1px_0px_0px_rgba(255,255,255,0.1),inset_0px_0px_0px_1px_rgba(255,255,255,0.06)] hover:bg-muted active:scale-[0.97]",
        muted:
          "bg-muted text-foreground shadow-[0px_0px_0px_1px_rgba(0,0,0,0.4),inset_0px_1px_0px_0px_rgba(255,255,255,0.1),inset_0px_0px_0px_1px_rgba(255,255,255,0.06)] hover:bg-[#333333] active:scale-[0.97]",
        subtle:
          "bg-[#232323] text-foreground shadow-[0px_0px_0px_1px_#333333] hover:bg-muted active:scale-[0.97]",
        ghost: "text-subtle hover:bg-white/6 hover:text-foreground active:scale-[0.97]",
        nav: "w-full justify-start rounded-lg text-sidebar-foreground hover:text-foreground data-[active=true]:bg-sidebar-primary data-[active=true]:text-foreground data-[active=true]:shadow-[0px_0px_0px_1px_rgba(0,0,0,0.4),inset_0px_1px_0px_0px_rgba(255,255,255,0.1),inset_0px_0px_0px_1px_rgba(255,255,255,0.06)]",
        item: "w-full items-start justify-start gap-3 rounded-lg text-left font-normal whitespace-normal text-foreground hover:bg-white/4",
        link: "rounded-none text-foreground underline decoration-from-font underline-offset-2 hover:text-soft",
      },
      size: {
        sm: "p-[9px] text-[12px] leading-none",
        md: "p-2 text-[14px] leading-none",
        icon: "size-[30px] p-0",
        "icon-sm": "size-6 p-0",
        none: "p-0",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "sm",
    },
  },
);

type ButtonProps = VariantProps<typeof buttonVariants> &
  ComponentProps<"button"> & {
    href?: ComponentProps<typeof Link>["href"];
    shortcut?: string[];
  };

function ShortcutHint({ keys }: { keys: string[] }) {
  return (
    <span aria-hidden className="ml-0.5 hidden items-center gap-0.5 opacity-70 lg:inline-flex [@media(pointer:coarse)]:hidden">
      {keys.map((key, index) => (
        <kbd key={index} className="inline-flex h-4 min-w-4 items-center justify-center rounded-[4px] bg-white/12 px-1 font-sans text-[10.5px] leading-none font-medium">
          {key}
        </kbd>
      ))}
    </span>
  );
}

export default function Button({
  variant,
  size,
  className,
  href,
  children: label,
  shortcut,
  type = "button",
  ...props
}: ButtonProps) {
  const classes = cn(buttonVariants({ variant, size }), className);
  const children = shortcut?.length ? (
    <>
      {label}
      <ShortcutHint keys={shortcut} />
    </>
  ) : (
    label
  );

  if (typeof href === "string" && (href.startsWith("/api/") || href.startsWith("#"))) {
    return (
      <a href={href} className={classes} {...(props as ComponentProps<"a">)}>
        {children}
      </a>
    );
  }

  if (href) {
    return (
      <Link
        href={href}
        className={classes}
        {...(props as Omit<ComponentProps<typeof Link>, "href" | "className">)}
      >
        {children}
      </Link>
    );
  }

  return (
    <button type={type} className={classes} {...props}>
      {children}
    </button>
  );
}
