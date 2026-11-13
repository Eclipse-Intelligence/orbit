"use client";

import { useState, useTransition } from "react";
import Switch from "@/components/_ui/switch";
import { setTaskPrepareAction } from "@/app/(crm)/task-act";
import { SettingsCard } from "@/components/crm/settings-ui";
import type { TaskPrepareSettings as Settings } from "@/lib/crm/task-prepare";

export default function TaskPrepareSettings({ initial }: { initial: Settings }) {
  const [settings, setSettings] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function save(value: boolean) {
    const previous = settings;
    setSettings({ prepareEachMorning: value });
    setError(null);
    startTransition(async () => {
      const result = await setTaskPrepareAction({ prepareEachMorning: value }).catch(() => ({ error: "Couldn't save. Try again." }));
      if ("error" in result && result.error) {
        setSettings(previous);
        setError(result.error);
      }
    });
  }

  return (
    <SettingsCard id="prepare" title="Prepare" description="Only you see what's prepared. Nothing is sent until you press Send.">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <span className="flex flex-col">
            <span className="text-[14px] leading-5">Prepare each morning</span>
            <span className="caption-style text-subtle">A call brief or email draft for your tasks due that day.</span>
          </span>
          <Switch checked={settings.prepareEachMorning} onChange={save} label="Prepare each morning" />
        </div>
        {error && (
          <p role="alert" className="caption-style text-danger">
            {error}
          </p>
        )}
      </div>
    </SettingsCard>
  );
}
