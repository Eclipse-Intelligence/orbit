"use client";

import { Kbd } from "@/components/_ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/_ui/dialog";
import { useShortcuts } from "@/components/shortcuts/shortcuts-provider";
import { SHORTCUTS, comboLabel, type ShortcutDef, type ShortcutGroup } from "@/lib/shortcuts";

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
  "Inbox",
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
    <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
      <DialogContent className="flex max-h-[min(44em,calc(100dvh-4rem))] max-w-[760px] flex-col gap-0 p-0 pt-8">
        <DialogTitle className="sr-only">Keyboard shortcuts</DialogTitle>
        <DialogDescription className="sr-only">Every keyboard shortcut in Orbit</DialogDescription>
        <ShortcutsReference />
      </DialogContent>
    </Dialog>
  );
}
