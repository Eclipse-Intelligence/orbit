"use client";

import { useRef, useState } from "react";
import Switch from "@/components/_ui/switch";
import { setTaskPrepareAction } from "@/app/(crm)/task-act";
import { SettingsCard } from "@/components/crm/settings-ui";
import type { TaskPrepareSettings as Settings } from "@/lib/crm/task-prepare";

export default function TaskPrepareSettings({ initial }: { initial: Settings }) {
  const [settings, setSettings] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const saved = useRef(initial);
  const latest = useRef(0);

  async function save(value: boolean) {
    const request = latest.current + 1;
    latest.current = request;
    setSettings({ prepareEachMorning: value });
    setError(null);
    const result = await setTaskPrepareAction({ prepareEachMorning: value }).catch(() => ({ error: "Couldn't save. Try again." }) as { settings?: Settings; error?: string });
    if (result.settings) saved.current = result.settings;
    if (request !== latest.current) return;
    if (result.settings) {
      setSettings(result.settings);
      return;
    }
    setSettings(saved.current);
    setError(result.error ?? "Couldn't save. Try again.");
  }

  return (
    <SettingsCard id="prepare" title="Prepare" description="Only you see what's prepared. Nothing is sent until you press Send.">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <span className="flex flex-col">
            <span className="text-[14px] leading-5">Prepare each morning</span>
            <span className="caption-style text-subtle">A brief or email draft for your call, meeting and email tasks due that day.</span>
          </span>
          <Switch checked={settings.prepareEachMorning} onChange={(value) => void save(value)} label="Prepare each morning" />
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
