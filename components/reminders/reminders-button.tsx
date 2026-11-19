"use client";

import Button from "@/components/_ui/button";
import { NewDot } from "@/components/_common/sidebar/sidebar-toggle";
import { useCompaniesStore } from "@/stores/companies-store";
import RemindersIcon from "@/public/assets/images/reminders/list.svg";

export function useRemindersToggle() {
  const open = useCompaniesStore((state) => state.remindersOpen);
  const due = useCompaniesStore((state) => state.remindersDue) ?? 0;
  const openReminders = useCompaniesStore((state) => state.openReminders);
  const setOpen = useCompaniesStore((state) => state.setRemindersOpen);
  const toggle = (focus: boolean) => (open ? setOpen(false) : openReminders(focus));
  return { open, due, toggle };
}

export default function RemindersButton() {
  const { open, due, toggle } = useRemindersToggle();
  return (
    <Button
      variant="secondary"
      size="icon"
      className="relative hidden sidebar-collapsed:lg:inline-flex"
      aria-label={due > 0 ? `Reminders, ${due} due` : "Reminders"}
      aria-expanded={open}
      title="Reminders"
      onClick={() => toggle(true)}
    >
      <RemindersIcon aria-hidden className="size-3.5" />
      {due > 0 && <NewDot />}
    </Button>
  );
}
