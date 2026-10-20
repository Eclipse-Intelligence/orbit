"use client";

import { useState, useTransition } from "react";
import Switch from "@/components/_ui/switch";
import { setMailHelpAction } from "@/app/(crm)/mail/actions";
import { SettingsCard } from "@/components/crm/settings-ui";
import type { MailHelpSettings as Settings } from "@/lib/mail/prepare";

const REMIND_CHOICES = [
  { value: "off", label: "Off" },
  { value: "1", label: "After 1 working day" },
  { value: "2", label: "After 2 working days" },
  { value: "3", label: "After 3 working days" },
  { value: "5", label: "After 5 working days" },
  { value: "10", label: "After 2 weeks" },
];

export default function MailHelpSettings({ initial }: { initial: Settings }) {
  const [settings, setSettings] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function save(next: Settings, input: { prepareReplies?: boolean; autoRemindDays?: number | null }) {
    const previous = settings;
    setSettings(next);
    setError(null);
    startTransition(async () => {
      const result = await setMailHelpAction(input);
      if (result.error) {
        setSettings(previous);
        setError(result.error);
      }
    });
  }

  const remind = settings.autoRemindDays ? String(settings.autoRemindDays) : "off";
  const choices = REMIND_CHOICES.some((choice) => choice.value === remind)
    ? REMIND_CHOICES
    : [...REMIND_CHOICES, { value: remind, label: `After ${remind} working days` }];

  return (
    <SettingsCard
      id="mail-help"
      title="Prepared replies and reminders"
      description="Orbit reads new email in Important and gets a reply ready when someone is waiting on you, in your voice and using what the CRM knows. Nothing is sent until you press Send."
    >
      <div className="flex flex-col gap-5">
        <div className="flex items-center justify-between gap-4">
          <span className="flex flex-col">
            <span className="text-[14px] leading-5">Prepare replies</span>
            <span className="caption-style text-subtle">Drafts learn from the changes you make before sending.</span>
          </span>
          <Switch
            checked={settings.prepareReplies}
            onChange={(value) => save({ ...settings, prepareReplies: value }, { prepareReplies: value })}
            label="Prepare replies"
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label htmlFor="auto-remind" className="flex flex-col">
            <span className="text-[14px] leading-5">Remind me when nobody replies</span>
            <span className="caption-style text-subtle">For emails you send that ask something. Weekends don&apos;t count.</span>
          </label>
          <select
            id="auto-remind"
            value={remind}
            onChange={(event) => {
              const days = event.target.value === "off" ? null : Number(event.target.value);
              save({ ...settings, autoRemindDays: days }, { autoRemindDays: days });
            }}
            className="bg-secondary text-foreground h-8 rounded-full px-3 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            {choices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error && (
        <p role="alert" className="caption-style text-danger mt-2">
          {error}
        </p>
      )}
    </SettingsCard>
  );
}
