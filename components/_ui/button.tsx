import Link from "next/link";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium leading-none outline-none select-none transition-[background-color,color,box-shadow,scale] duration-150 ease-power3-out focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:bg-primary-hover active:scale-[0.97]",
        secondary: "bg-surface-raised text-secondary-foreground hover:bg-surface-active active:scale-[0.97]",
        muted: "bg-surface-active text-foreground hover:bg-white/10 active:scale-[0.97]",
        subtle: "bg-surface-hover text-foreground hover:bg-surface-raised active:scale-[0.97]",
        ghost: "text-subtle hover:bg-white/6 hover:text-foreground active:scale-[0.97]",
        nav: "w-full justify-start rounded-lg text-sidebar-foreground hover:text-foreground data-[active=true]:bg-surface-raised data-[active=true]:text-foreground",
        item: "w-full items-start justify-start gap-3 rounded-lg text-left font-normal whitespace-normal text-foreground hover:bg-white/4",
        chip: "font-normal text-subtle hover:bg-surface-hover hover:text-foreground data-[active=true]:bg-surface-active data-[active=true]:text-foreground",
        link: "rounded-none text-foreground underline decoration-from-font underline-offset-2 hover:text-soft",
      },
      size: {
        sm: "py-[9px] text-[12px] leading-none",
        md: "py-2 text-[14px] leading-none",
        icon: "size-[30px] p-0",
        "icon-sm": "size-6 p-0",
        chip: "h-8 gap-1 px-2.5 text-[13px] leading-none",
        none: "p-0",
      },
    },
    compoundVariants: [
      { variant: ["primary", "secondary", "muted", "subtle", "ghost"], size: "sm", class: "px-3" },
      { variant: ["primary", "secondary", "muted", "subtle", "ghost"], size: "md", class: "px-3.5" },
      { variant: ["nav", "item", "chip", "link"], size: "sm", class: "px-[9px]" },
      { variant: ["nav", "item", "chip", "link"], size: "md", class: "px-2" },
    ],
    defaultVariants: {
      variant: "secondary",
      size: "sm",
    },
  },
);

type ButtonProps = VariantProps<typeof buttonVariants> &
  ComponentProps<"button"> & {
    href?: ComponentProps<typeof Link>["href"];
    target?: string;
    rel?: string;
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
  target,
  rel,
  children: label,
  shortcut,
  type = "button",
  ...props
}: ButtonProps) {
  const classes = cn(buttonVariants({ variant, size }), className);
  const linkRel = rel ?? (target === "_blank" ? "noopener noreferrer" : undefined);
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
      <a href={href} target={target} rel={linkRel} className={classes} {...(props as ComponentProps<"a">)}>
        {children}
      </a>
    );
  }

  if (href) {
    return (
      <Link
        href={href}
        target={target}
        rel={linkRel}
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
