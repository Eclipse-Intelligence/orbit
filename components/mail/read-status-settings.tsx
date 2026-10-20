"use client";

import { useState, useTransition } from "react";
import Switch from "@/components/_ui/switch";
import { setReadStatusesAction } from "@/app/(crm)/mail/actions";
import { SettingsCard } from "@/components/crm/settings-ui";

export default function ReadStatusSettings({ initial }: { initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function change(value: boolean) {
    setOn(value);
    setError(null);
    startTransition(async () => {
      const result = await setReadStatusesAction(value);
      if (result.error) {
        setOn(!value);
        setError(result.error);
      }
    });
  }

  return (
    <SettingsCard
      id="read-statuses"
      title="Read statuses"
      description="See when people open the emails you send from Orbit. Orbit adds a tiny invisible image to each email and notes each time it loads. Apps that block images, and Apple Mail's privacy protection, can make a read go missing or show early."
    >
      <div className="flex items-center justify-between gap-4">
        <span className="text-[14px] leading-5">Show when my emails are read</span>
        <Switch checked={on} onChange={change} label="Show when my emails are read" />
      </div>
      {error && (
        <p role="alert" className="caption-style text-danger mt-2">
          {error}
        </p>
      )}
    </SettingsCard>
  );
}
