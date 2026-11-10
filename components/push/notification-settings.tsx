"use client";

import { useEffect, useState } from "react";
import Button from "@/components/_ui/button";
import Switch from "@/components/_ui/switch";
import { SettingsCard } from "@/components/crm/settings-ui";
import { disablePush, enablePush, isAppleMobile, pushState, sendPushTest, type PushState } from "@/components/push/push-client";
import type { NotifyMail } from "@/lib/mail/notify";
import { Radio } from "@/components/_ui/radio";

const LEVELS: { id: NotifyMail; label: string; detail?: string }[] = [
  { id: "important", label: "Important only", detail: "People you know and conversations you're in, plus calendar replies." },
  { id: "all", label: "All new mail" },
  { id: "none", label: "Off" },
];

const STATE_TEXT: Record<PushState, string> = {
  unsupported: "This browser can't show Orbit notifications.",
  install: "On iPhone, add Orbit to your Home Screen (Share, then Add to Home Screen) and open it from there.",
  blocked: "Blocked on this device. Allow notifications in your device settings.",
  off: "Off on this device",
  on: "On for this device",
};

const CALENDAR_CHOICES: { value: string; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "0", label: "When it starts" },
  { value: "5", label: "5 minutes before" },
  { value: "10", label: "10 minutes before" },
  { value: "15", label: "15 minutes before" },
  { value: "30", label: "30 minutes before" },
];

export default function NotificationSettings({
  initialMail,
  initialCalendarMinutes,
  initialReads,
}: {
  initialMail: NotifyMail;
  initialCalendarMinutes: number | null;
  initialReads: boolean;
}) {
  const [calendar, setCalendar] = useState(initialCalendarMinutes === null ? "off" : String(initialCalendarMinutes));
  const [reads, setReads] = useState(initialReads);
  const [state, setState] = useState<PushState | null>(null);
  const [mail, setMail] = useState(initialMail);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "status" | "alert" } | null>(null);

  useEffect(() => {
    let live = true;
    void pushState().then((value) => live && setState(value));
    return () => {
      live = false;
    };
  }, []);

  async function run(work: () => Promise<string | void>, done: string) {
    setBusy(true);
    setMessage(null);
    try {
      const text = await work();
      setState(await pushState());
      setMessage({ text: text || done, tone: "status" });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "That didn't work. Try again.", tone: "alert" });
    } finally {
      setBusy(false);
    }
  }

  async function save(change: Record<string, unknown>, undo: () => void) {
    const response = await fetch("/api/push/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(change),
    }).catch(() => null);
    if (!response?.ok) {
      undo();
      setMessage({ text: "That didn't save. Try again.", tone: "alert" });
    }
  }

  function chooseMail(next: NotifyMail) {
    const previous = mail;
    setMail(next);
    void save({ mail: next }, () => setMail(previous));
  }

  function chooseCalendar(next: string) {
    const previous = calendar;
    setCalendar(next);
    void save({ calendarMinutes: next === "off" ? null : Number(next) }, () => setCalendar(previous));
  }

  function chooseReads(next: boolean) {
    setReads(next);
    void save({ reads: next }, () => setReads(!next));
  }

  return (
    <SettingsCard id="notifications" title="Notifications">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[14px] leading-5">{state ? STATE_TEXT[state] : "Checking this device…"}</p>
          <div className="flex gap-2">
            {state === "off" && (
              <Button variant="primary" disabled={busy} onClick={() => void run(enablePush, "Notifications are on")}>
                Turn on
              </Button>
            )}
            {state === "on" && (
              <>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await sendPushTest();
                      const failure = result.failures[0];
                      if (failure?.status === 404 || failure?.status === 410) {
                        throw new Error("This device's setup had expired. Turn notifications off and on again.");
                      }
                      if (!result.sent) {
                        const code = failure ? [failure.status, failure.reason].filter(Boolean).join(" ") : "";
                        throw new Error(
                          failure
                            ? `The push service refused the test${code ? ` (${code})` : ""}. Turn notifications off and on again on this device.`
                            : "Orbit couldn't find this device. Turn notifications off and on again.",
                        );
                      }
                      return isAppleMobile() ? "Test sent" : "Test sent. If nothing appears on a Mac, check System Settings › Notifications and Focus.";
                    }, "Test sent")
                  }
                >
                  Send test
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => void run(disablePush, "Off on this device")}>
                  Turn off
                </Button>
              </>
            )}
          </div>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="caption-style text-subtle pb-1">New mail</legend>
          {LEVELS.map((level) => (
            <label key={level.id} className="flex cursor-pointer items-start gap-3 rounded-lg px-1 py-1">
              <Radio
                name="notify-mail"
                value={level.id}
                checked={mail === level.id}
                onChange={() => void chooseMail(level.id)}
                className="mt-0.5"
              />
              <span className="flex flex-col">
                <span className="text-[14px]">{level.label}</span>
                {level.detail && <span className="caption-style text-subtle">{level.detail}</span>}
              </span>
            </label>
          ))}
        </fieldset>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label htmlFor="notify-calendar" className="text-[14px]">
            Meetings
          </label>
          <select
            id="notify-calendar"
            value={calendar}
            onChange={(event) => chooseCalendar(event.target.value)}
            className="bg-secondary text-foreground select-chevron h-8 cursor-pointer rounded-full pl-3 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            {CALENDAR_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[14px]">When someone reads my email</span>
          <Switch checked={reads} onChange={chooseReads} label="Notify me when someone reads my email" />
        </div>
        {message && (
          <p role={message.tone} className={message.tone === "alert" ? "caption-style text-danger" : "caption-style text-subtle"}>
            {message.text}
          </p>
        )}
      </div>
    </SettingsCard>
  );
}
