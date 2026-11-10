"use client";

import Button from "@/components/_ui/button";
import Switch from "@/components/_ui/switch";
import { SettingsCard } from "@/components/crm/settings-ui";
import { useShortcuts } from "@/components/shortcuts/shortcuts-provider";

export default function ShortcutSettings() {
  const { singleKeys, setSingleKeys, run } = useShortcuts();
  return (
    <SettingsCard
      id="shortcuts"
      title="Keyboard shortcuts"
      description="Saved for this browser."
      action={
        <Button variant="secondary" size="sm" onClick={() => run("help")}>
          Show shortcuts
        </Button>
      }
    >
      <div className="flex items-center justify-between gap-4">
        <span className="flex min-w-0 flex-col">
          <span className="text-[14px] leading-5">Single-key shortcuts</span>
          <span className="caption-style text-subtle">
            Such as E to edit, J and K to move.
          </span>
        </span>
        <Switch checked={singleKeys} onChange={setSingleKeys} label="Single-key shortcuts" />
      </div>
    </SettingsCard>
  );
}
