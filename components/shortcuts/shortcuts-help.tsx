"use client";

import { Kbd } from "@/components/_ui/command";
import { Dialog as DialogPrimitive } from "radix-ui";
import Button from "@/components/_ui/button";
import { DialogOverlay } from "@/components/_ui/dialog";
import { useShortcuts } from "@/components/shortcuts/shortcuts-provider";
import { SHORTCUTS, comboLabel, type ShortcutDef, type ShortcutGroup } from "@/lib/shortcuts";
import XIcon from "@/public/assets/images/companies/detail/x.svg";

const GROUPS: ShortcutGroup[] = [
  "General",
  "Go to",
  "Create",
  "Lists",
  "Selection",
  "Records",
  "Tasks",
  "Opportunities",
  "Calendar",
  "Mail",
  "Capture",
];

function keyable(def: ShortcutDef) {
  return !def.hidden && Boolean(def.sequence || def.combos?.length);
}

function Keys({ def, mac }: { def: ShortcutDef; mac: boolean }) {
  if (def.sequence) {
    return (
      <span className="flex shrink-0 items-center gap-1">
        <Kbd>{def.sequence[0].toUpperCase()}</Kbd>
        <span className="caption-style text-faint">then</span>
        <Kbd>{def.sequence[1].toUpperCase()}</Kbd>
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {(def.combos ?? []).map((combo, index) => (
        <span key={index} className="flex items-center gap-1">
          {index > 0 && <span className="caption-style text-faint">or</span>}
          {comboLabel(combo, mac).map((part, partIndex) => (
            <Kbd key={partIndex}>{part}</Kbd>
          ))}
        </span>
      ))}
    </span>
  );
}

function Rows({ defs, mac }: { defs: ShortcutDef[]; mac: boolean }) {
  return (
    <ul className="flex flex-col">
      {defs.map((def) => (
        <li key={def.id} className="flex min-h-8 items-center justify-between gap-4">
          <span className="text-soft min-w-0 text-[13px] leading-5">{def.label}</span>
          <Keys def={def} mac={mac} />
        </li>
      ))}
    </ul>
  );
}

export function ShortcutsReference() {
  const { mac } = useShortcuts();
  const groups = GROUPS.map((group) => ({
    group,
    defs: SHORTCUTS.filter((def) => def.group === group && keyable(def)),
  })).filter((entry) => entry.defs.length > 0);

  return (
    <div
      tabIndex={0}
      autoFocus
      aria-label="Keyboard shortcuts"
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5 outline-none"
    >
      <div className="columns-1 gap-10 md:columns-2">
        {groups.map(({ group, defs }) => (
          <section key={group} className="mb-6 break-inside-avoid last:mb-0">
            <h3 className="eyebrow-style text-faint pb-1.5 font-medium">{group}</h3>
            <Rows defs={defs} mac={mac} />
          </section>
        ))}
      </div>
    </div>
  );
}

export default function ShortcutsHelp() {
  const { helpOpen, setHelpOpen } = useShortcuts();
  return (
    <DialogPrimitive.Root open={helpOpen} onOpenChange={setHelpOpen}>
      <DialogPrimitive.Portal>
        <DialogOverlay />
        <DialogPrimitive.Content
          className="border-line-strong bg-popover text-popover-foreground shadow-overlay data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:ease-power3-out data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:ease-power3-in fixed top-1/2 left-1/2 z-50 flex max-h-[min(44rem,calc(100dvh-2rem))] w-[calc(100%-2rem)] max-w-[760px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border pt-10 outline-none duration-250 data-[state=closed]:duration-200"
        >
          <DialogPrimitive.Title className="sr-only">Keyboard shortcuts</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">Every keyboard shortcut in Orbit</DialogPrimitive.Description>
          <ShortcutsReference />
          <DialogPrimitive.Close asChild>
            <Button variant="ghost" size="icon-sm" className="absolute top-3 right-3" aria-label="Close">
              <XIcon aria-hidden className="size-4" />
            </Button>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
