"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/_ui/select";
import { REMINDER_OPTIONS } from "@/lib/crm/reminder-options";
import { requestReminderPermission } from "@/lib/reminder-alerts";

export default function ReminderSelect({
  id,
  name,
  value,
  onChange,
  disabled,
}: {
  id: string;
  name?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <Select
        value={disabled ? "none" : value}
        disabled={disabled}
        onValueChange={(next) => {
          onChange(next);
          if (next !== "none") requestReminderPermission();
        }}
      >
        <SelectTrigger id={id} aria-label="Reminder">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="max-h-64">
          <SelectItem value="none">No reminder</SelectItem>
          {REMINDER_OPTIONS.map((option) => (
            <SelectItem key={option.minutes} value={String(option.minutes)}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {name && <input type="hidden" name={name} value={disabled ? "none" : value} />}
    </>
  );
}
