"use client";

import { useEffect, useState } from "react";
import { Kbd } from "@/components/_ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/_ui/dialog";
import Switch from "@/components/_ui/switch";
import { useShortcuts } from "@/components/shortcuts/shortcuts-provider";
import { SHORTCUTS, comboLabel, type ShortcutDef, type ShortcutGroup } from "@/lib/shortcuts";

const EVERYWHERE: ShortcutGroup[] = ["General", "Create", "Go to"];
const SCREENS: ShortcutGroup[] = ["Lists", "Selection", "Tasks", "Opportunities", "Records", "Calendar", "Inbox"];

function keyable(def: ShortcutDef) {
  return !def.hidden && Boolean(def.sequence || def.combos?.length);
}

function KeyList({ def, mac }: { def: ShortcutDef; mac: boolean }) {
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

function Section({ title, defs, mac }: { title: string; defs: ShortcutDef[]; mac: boolean }) {
  if (defs.length === 0) return null;
  return (
    <section className="flex flex-col gap-1">
      <h3 className="caption-style text-subtle py-1">{title}</h3>
      <ul className="flex flex-col">
        {defs.map((def) => (
          <li key={def.id} className="flex min-h-8 items-center justify-between gap-4 text-[14px] leading-5">
            <span className="text-soft min-w-0">{def.label}</span>
            <KeyList def={def} mac={mac} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function ShortcutsHelp() {
  const { helpOpen, setHelpOpen, available, mac, singleKeys, setSingleKeys } = useShortcuts();
  const [pageIds, setPageIds] = useState<string[]>([]);

  useEffect(() => {
    if (!helpOpen) return;
    const timer = window.setTimeout(() => {
      setPageIds(
        SHORTCUTS.filter((def) => SCREENS.includes(def.group) && keyable(def) && available(def.id)).map(
          (def) => def.id,
        ),
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [helpOpen, available]);

  const onPage = SHORTCUTS.filter((def) => pageIds.includes(def.id));
  const everywhere = EVERYWHERE.map((group) => ({
    group,
    defs: SHORTCUTS.filter((def) => def.group === group && keyable(def)),
  }));
  const elsewhere = SCREENS.map((group) => ({
    group,
    defs: SHORTCUTS.filter((def) => def.group === group && keyable(def) && !pageIds.includes(def.id)),
  }));

  return (
    <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
      <DialogContent className="flex max-h-[min(44em,calc(100dvh-4rem))] max-w-[640px] flex-col gap-0 p-0">
        <DialogHeader className="border-line-strong border-b px-5 py-4">
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Letters work when you&apos;re not typing in a field. Press Esc to leave a field first.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
          <Section title="On this page" defs={onPage} mac={mac} />
          {everywhere.map(({ group, defs }) => (
            <Section key={group} title={group} defs={defs} mac={mac} />
          ))}
          {elsewhere.map(({ group, defs }) => (
            <Section key={group} title={`${group} (other pages)`} defs={defs} mac={mac} />
          ))}
        </div>
        <div className="border-line-strong flex items-center justify-between gap-4 border-t px-5 py-3">
          <span className="flex min-w-0 flex-col">
            <span className="text-[14px] leading-5">Single-key shortcuts</span>
            <span className="caption-style text-subtle">
              Turn off to keep only shortcuts that use {mac ? "⌘" : "Ctrl"}.
            </span>
          </span>
          <Switch checked={singleKeys} onChange={setSingleKeys} label="Single-key shortcuts" />
        </div>
      </DialogContent>
    </Dialog>
  );
}
