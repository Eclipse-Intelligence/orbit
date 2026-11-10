"use client";

import { useState, useTransition } from "react";
import { NativeSelect } from "@/components/_ui/native-select";
import Switch from "@/components/_ui/switch";
import { setMailHelpAction } from "@/app/(crm)/mail/actions";
import { SettingsCard } from "@/components/crm/settings-ui";
import ReadStatusRow from "@/components/mail/read-status-settings";
import type { MailHelpSettings as Settings } from "@/lib/mail/prepare";

const REMIND_CHOICES = [
  { value: "off", label: "Off" },
  { value: "1", label: "After 1 working day" },
  { value: "2", label: "After 2 working days" },
  { value: "3", label: "After 3 working days" },
  { value: "5", label: "After 5 working days" },
  { value: "10", label: "After 2 weeks" },
];

const PITCH_CHOICES: { value: Settings["coldPitches"]; label: string }[] = [
  { value: "off", label: "Leave in the inbox" },
  { value: "other", label: "Move to Other" },
  { value: "archive", label: "Archive" },
];

export default function MailHelpSettings({ initial, readStatuses }: { initial: Settings; readStatuses: boolean }) {
  const [settings, setSettings] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function save(next: Settings, input: { prepareReplies?: boolean; autoRemindDays?: number | null; coldPitches?: Settings["coldPitches"] }) {
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
      description="Nothing is sent until you press Send."
    >
      <div className="flex flex-col gap-5">
        <div className="flex items-center justify-between gap-4">
          <span className="text-[14px] leading-5">Prepare replies</span>
          <Switch
            checked={settings.prepareReplies}
            onChange={(value) => save({ ...settings, prepareReplies: value }, { prepareReplies: value })}
            label="Prepare replies"
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label htmlFor="auto-remind" className="text-[14px] leading-5">
            Remind me when nobody replies
          </label>
          <select
            id="auto-remind"
            value={remind}
            onChange={(event) => {
              const days = event.target.value === "off" ? null : Number(event.target.value);
              save({ ...settings, autoRemindDays: days }, { autoRemindDays: days });
            }}
            className="bg-secondary text-foreground select-chevron h-8 cursor-pointer rounded-full pl-3 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            {choices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label htmlFor="cold-pitches" className="flex flex-col">
            <span className="text-[14px] leading-5">Cold pitches</span>
            <span className="caption-style text-subtle">Sales email from strangers.</span>
          </label>
          <NativeSelect
            id="cold-pitches"
            value={settings.coldPitches}
            onChange={(event) => {
              const mode = PITCH_CHOICES.find((choice) => choice.value === event.target.value)?.value ?? "off";
              save({ ...settings, coldPitches: mode }, { coldPitches: mode });
            }}
            className="w-auto"
          >
            {PITCH_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <ReadStatusRow initial={readStatuses} />
      </div>
      {error && (
        <p role="alert" className="caption-style text-danger mt-2">
          {error}
        </p>
      )}
    </SettingsCard>
  );
}
