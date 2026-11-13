"use client";

import { useState, useTransition } from "react";
import HoldButton from "@/components/_ui/hold-button";
import { SettingsCard } from "@/components/crm/settings-ui";
import { resetLearnedTimesAction } from "@/app/(crm)/calendar/actions";
import { STRIP_FROM, STRIP_TO, type LearnedKind, type LearnedKindView } from "@/lib/learned-times";
import PhoneIcon from "@/public/assets/images/_common/phone.svg";
import MailIcon from "@/public/assets/images/companies/sidebar/mail.svg";
import CircleIcon from "@/public/assets/images/tasks/circle.svg";

const RESET_FAILED = "Couldn't reset your learned times. Try again.";
const NAMES: Record<LearnedKind, string> = { call: "Calls", email: "Emails", other: "Other" };
const ICONS: Record<LearnedKind, typeof PhoneIcon> = { call: PhoneIcon, email: MailIcon, other: CircleIcon };
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const HALVES = Array.from({ length: STRIP_TO - STRIP_FROM }, (_, index) => STRIP_FROM + index);

function clock(half: number) {
  return `${String(Math.floor(half / 2)).padStart(2, "0")}:${half % 2 ? "30" : "00"}`;
}

function Strip({ view }: { view: LearnedKindView }) {
  return (
    <div
      role="img"
      aria-label={`${NAMES[view.kind]}: ${view.label.toLowerCase()}, Monday to Friday, ${clock(STRIP_FROM)} to ${clock(STRIP_TO)}`}
      className="grid grid-cols-[2.25em_repeat(20,minmax(0,1fr))] items-center gap-0.5"
    >
      {view.week.map((row, day) => (
        <div key={DAYS[day]} className="contents">
          <span aria-hidden className="text-subtle text-[11px] leading-none">
            {DAYS[day]}
          </span>
          {row.map((weight, index) => (
            <span
              key={HALVES[index]}
              aria-hidden
              title={`${DAYS[day]} ${clock(HALVES[index])}`}
              className="h-3.5 rounded-[3px]"
              style={{ background: `color-mix(in srgb, var(--violet) ${Math.round(weight * 100)}%, var(--muted))` }}
            />
          ))}
        </div>
      ))}
      <span aria-hidden />
      {HALVES.map((half, index) => (
        <span key={half} aria-hidden className="text-faint text-[10.5px] leading-none tabular-nums">
          {index % 4 === 0 ? String(half / 2).padStart(2, "0") : ""}
        </span>
      ))}
    </div>
  );
}

export default function LearnedTimesSettings({ kinds }: { kinds: LearnedKindView[] }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setError(null);
    startTransition(async () => {
      const result = await resetLearnedTimesAction().catch(() => ({ error: RESET_FAILED }));
      if (result.error) setError(result.error);
    });
  }

  return (
    <SettingsCard
      id="learned-times"
      title="Learned times"
      description="From what you’ve done in the last 90 days. Plan tries these times first, inside your working hours."
      action={
        <HoldButton tone="neutral" disabled={pending} onConfirm={reset} className="shrink-0 pointer-coarse:h-11 pointer-coarse:px-4">
          Reset
        </HoldButton>
      }
    >
      <ul className="divide-border flex flex-col divide-y" aria-label="Learned times">
        {kinds.map((view) => {
          const Icon = ICONS[view.kind];
          return (
            <li key={view.kind} className="grid gap-x-4 gap-y-2 py-3.5 first:pt-0.5 sm:grid-cols-[7.5em_minmax(0,1fr)]">
              <span className="flex flex-col gap-1">
                <span className="ui-style flex items-center gap-2 font-medium">
                  <Icon aria-hidden className="text-subtle size-3.5 shrink-0" />
                  {NAMES[view.kind]}
                </span>
                <span className="caption-style text-subtle">{view.label}</span>
              </span>
              <span className="flex min-w-0 flex-col gap-2">
                <Strip view={view} />
                <span className="caption-style text-subtle">{view.caption}</span>
              </span>
            </li>
          );
        })}
      </ul>
      <p role="alert" className="caption-style text-danger empty:hidden">
        {error}
      </p>
    </SettingsCard>
  );
}
