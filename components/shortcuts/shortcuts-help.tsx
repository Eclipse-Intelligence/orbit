"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Kbd } from "@/components/_ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/_ui/dialog";
import Switch from "@/components/_ui/switch";
import { useShortcuts } from "@/components/shortcuts/shortcuts-provider";
import { SHORTCUTS, comboLabel, paletteMatches, type ShortcutDef, type ShortcutGroup } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import KeyboardIcon from "@/public/assets/images/companies/sidebar/keyboard.svg";
import SearchIcon from "@/public/assets/images/_common/search.svg";

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

const PAGE_GROUPS = new Set<ShortcutGroup>(["Lists", "Selection", "Tasks", "Opportunities", "Records", "Calendar", "Inbox"]);

function keyable(def: ShortcutDef) {
  return !def.hidden && Boolean(def.sequence || def.combos?.length);
}

function keyText(def: ShortcutDef, mac: boolean) {
  if (def.sequence) return def.sequence.join(" ");
  return (def.combos ?? []).map((combo) => comboLabel(combo, mac).join(" ")).join(" ");
}

function matches(def: ShortcutDef, query: string, mac: boolean) {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return true;
  return paletteMatches(def, wanted) || keyText(def, mac).toLowerCase() === wanted;
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

export function ShortcutsReference({ heading, description }: { heading: ReactNode; description: ReactNode }) {
  const { available, mac, singleKeys, setSingleKeys } = useShortcuts();
  const [query, setQuery] = useState("");
  const [pageIds, setPageIds] = useState<string[]>([]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPageIds(
        SHORTCUTS.filter((def) => PAGE_GROUPS.has(def.group) && keyable(def) && available(def.id)).map(
          (def) => def.id,
        ),
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [available]);

  const searching = query.trim() !== "";
  const onPage = searching ? [] : SHORTCUTS.filter((def) => pageIds.includes(def.id));
  const groups = GROUPS.map((group) => ({
    group,
    defs: SHORTCUTS.filter((def) => def.group === group && keyable(def) && matches(def, query, mac)),
  })).filter((entry) => entry.defs.length > 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-line-strong flex flex-col gap-4 border-b px-5 pt-5 pb-4">
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="bg-muted text-icon flex size-9 shrink-0 items-center justify-center rounded-lg shadow-[inset_0px_1px_0px_0px_rgba(255,255,255,0.08),0px_0px_0px_1px_rgba(0,0,0,0.4)]"
          >
            <KeyboardIcon className="size-4" />
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            {heading}
            <div className="caption-style text-subtle">{description}</div>
          </div>
        </div>
        <label className="border-line-strong bg-secondary focus-within:border-ring ease-power3-out flex h-9 items-center gap-2 rounded-lg border px-3 transition-[border-color] duration-150">
          <SearchIcon aria-hidden className="text-subtle size-3.5 shrink-0" />
          <span className="sr-only">Find a shortcut</span>
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a shortcut, e.g. edit, calendar or G"
            className="placeholder:text-subtle min-w-0 flex-1 bg-transparent text-[14px] leading-none outline-none"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
        {onPage.length > 0 && (
          <section className="mb-5 rounded-xl bg-white/[0.03] px-3 py-2.5 shadow-[inset_0px_0px_0px_1px_var(--line-strong)]">
            <h3 className="eyebrow-style text-status pb-1 font-medium">On this page</h3>
            <div className="grid gap-x-8 md:grid-cols-2">
              <Rows defs={onPage.slice(0, Math.ceil(onPage.length / 2))} mac={mac} />
              <Rows defs={onPage.slice(Math.ceil(onPage.length / 2))} mac={mac} />
            </div>
          </section>
        )}
        {groups.length === 0 ? (
          <p className="caption-style text-subtle py-6 text-center">No shortcut matches “{query.trim()}”</p>
        ) : (
          <div className="columns-1 gap-8 md:columns-2">
            {groups.map(({ group, defs }) => (
              <section key={group} className="mb-5 break-inside-avoid">
                <h3 className="eyebrow-style text-faint pb-1 font-medium">{group}</h3>
                <Rows defs={defs} mac={mac} />
              </section>
            ))}
          </div>
        )}
      </div>
      <div className="border-line-strong flex items-center justify-between gap-4 border-t px-5 py-3">
        <span className="flex min-w-0 flex-col">
          <span className="text-[13px] leading-5">Single-key shortcuts</span>
          <span className="caption-style text-subtle">
            {singleKeys ? "On. Letters work when you aren't typing." : `Off. Only ${mac ? "⌘" : "Ctrl"} shortcuts and Esc work.`}
          </span>
        </span>
        <Switch checked={singleKeys} onChange={setSingleKeys} label="Single-key shortcuts" />
      </div>
    </div>
  );
}

export function ShortcutsDescription() {
  const { mac } = useShortcuts();
  return (
    <span className={cn("flex flex-wrap items-center gap-1")}>
      Press <Kbd>?</Kbd> any time, or <Kbd>{mac ? "⌘" : "Ctrl"}</Kbd>
      <Kbd>K</Kbd> to search and run anything.
    </span>
  );
}

export default function ShortcutsHelp() {
  const { helpOpen, setHelpOpen } = useShortcuts();
  return (
    <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
      <DialogContent className="flex max-h-[min(44em,calc(100dvh-4rem))] max-w-[760px] flex-col gap-0 p-0">
        <DialogDescription className="sr-only">Every keyboard shortcut in Orbit</DialogDescription>
        <ShortcutsReference
          heading={<DialogTitle className="text-[16px] leading-6">Keyboard shortcuts</DialogTitle>}
          description={<ShortcutsDescription />}
        />
      </DialogContent>
    </Dialog>
  );
}
