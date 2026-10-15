"use client";

import { useState } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { Kbd } from "@/components/_ui/command";
import { ShortcutsDescription, ShortcutsReference } from "@/components/shortcuts/shortcuts-help";
import { useShortcuts } from "@/components/shortcuts/shortcuts-provider";
import { useCompaniesStore } from "@/stores/companies-store";
import { cn } from "@/lib/utils";
import KeyboardIcon from "@/public/assets/images/companies/sidebar/keyboard.svg";

const WIDE = "(min-width: 64rem)";

export default function SidebarShortcuts() {
  const [open, setOpen] = useState(false);
  const { setHelpOpen } = useShortcuts();
  const setSidebarOpen = useCompaniesStore((state) => state.setSidebarOpen);

  function toggle(next: boolean) {
    if (next && !window.matchMedia(WIDE).matches) {
      setSidebarOpen(false);
      setHelpOpen(true);
      return;
    }
    setOpen(next);
  }

  return (
    <li>
      <PopoverPrimitive.Root open={open} onOpenChange={toggle}>
        <PopoverPrimitive.Trigger
          data-shortcut="shortcuts-panel"
          aria-keyshortcuts="Shift+?"
          className={cn(
            "group text-sidebar-foreground hover:text-foreground focus-visible:ring-ring/60 ease-power3-out flex h-[30px] w-full cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[14px] leading-none font-medium outline-none transition-[background-color,color,box-shadow] duration-150 focus-visible:ring-2",
            "data-[state=open]:bg-sidebar-primary data-[state=open]:text-foreground data-[state=open]:shadow-[0px_0px_0px_1px_rgba(0,0,0,0.4),inset_0px_1px_0px_0px_rgba(255,255,255,0.1),inset_0px_0px_0px_1px_rgba(255,255,255,0.06)]",
          )}
        >
          <KeyboardIcon
            aria-hidden
            className="text-subtle group-hover:text-icon group-data-[state=open]:text-icon ease-power3-out size-3.5 shrink-0 transition-[color,transform] duration-300 group-data-[state=open]:-rotate-6 group-data-[state=open]:scale-110"
          />
          <span className="min-w-0 flex-1 truncate text-left">Shortcuts</span>
          <Kbd aria-hidden className="h-[18px] min-w-[18px] px-1">
            ?
          </Kbd>
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            side="right"
            align="end"
            sideOffset={14}
            collisionPadding={16}
            aria-label="Keyboard shortcuts"
            className={cn(
              "border-line-strong bg-popover text-popover-foreground shadow-overlay z-50 flex max-h-[min(42rem,calc(100dvh-2rem))] w-[min(46rem,calc(100vw-var(--sidebar-width)-3rem))] origin-(--radix-popover-content-transform-origin) flex-col overflow-hidden rounded-2xl border outline-none",
              "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.55] data-[state=open]:slide-in-from-left-6 data-[state=open]:ease-power3-out data-[state=open]:duration-300",
              "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.55] data-[state=closed]:slide-out-to-left-6 data-[state=closed]:ease-power3-in data-[state=closed]:duration-200",
            )}
          >
            <ShortcutsReference
              heading={<h2 className="text-[16px] leading-6 font-medium">Keyboard shortcuts</h2>}
              description={<ShortcutsDescription />}
            />
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
    </li>
  );
}
