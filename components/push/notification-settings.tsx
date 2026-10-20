"use client";

import { useEffect, useState } from "react";
import Button from "@/components/_ui/button";
import { SettingsCard } from "@/components/crm/settings-ui";
import { disablePush, enablePush, pushState, type PushState } from "@/components/push/push-client";
import type { NotifyMail } from "@/lib/mail/notify";

const LEVELS: { id: NotifyMail; label: string; detail: string }[] = [
  { id: "important", label: "Important only", detail: "People you know and conversations you're in, plus calendar replies." },
  { id: "all", label: "All new mail", detail: "Everything that lands in your inbox." },
  { id: "none", label: "Off", detail: "No mail notifications on any device." },
];

const STATE_TEXT: Record<PushState, string> = {
  unsupported: "This browser can't show Orbit notifications.",
  install: "On iPhone, add Orbit to your Home Screen first: tap Share, then Add to Home Screen, and open Orbit from there.",
  blocked: "Notifications are blocked for Orbit on this device. Allow them in Settings › Notifications.",
  off: "Notifications are off on this device.",
  on: "Notifications are on for this device.",
};

export default function NotificationSettings({ initialMail, devices }: { initialMail: NotifyMail; devices: number }) {
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

  async function run(work: () => Promise<void>, done: string) {
    setBusy(true);
    setMessage(null);
    try {
      await work();
      setState(await pushState());
      setMessage({ text: done, tone: "status" });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "That didn't work. Try again.", tone: "alert" });
    } finally {
      setBusy(false);
    }
  }

  async function chooseMail(next: NotifyMail) {
    const previous = mail;
    setMail(next);
    const response = await fetch("/api/push/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mail: next }),
    }).catch(() => null);
    if (!response?.ok) {
      setMail(previous);
      setMessage({ text: "That didn't save. Try again.", tone: "alert" });
    }
  }

  return (
    <SettingsCard
      id="notifications"
      title="Notifications"
      description={`Orbit can notify you about new mail on your phone and computer, even when it isn't open. ${devices === 1 ? "1 device is" : `${devices} devices are`} set up.`}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[14px] leading-5">{state ? STATE_TEXT[state] : "Checking this device…"}</p>
          <div className="flex gap-2">
            {state === "off" && (
              <Button variant="primary" disabled={busy} onClick={() => void run(enablePush, "Notifications are on. Try Send a test.")}>
                Turn on for this device
              </Button>
            )}
            {state === "on" && (
              <>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const response = await fetch("/api/push/test", { method: "POST" });
                      const body = (await response.json()) as { sent?: number };
                      if (!response.ok || !body.sent) throw new Error("No device took the test. Turn notifications off and on again.");
                    }, "Test sent. It should arrive in a few seconds.")
                  }
                >
                  Send a test
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => void run(disablePush, "Notifications are off on this device.")}>
                  Turn off
                </Button>
              </>
            )}
          </div>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="caption-style text-subtle pb-1">Notify me about</legend>
          {LEVELS.map((level) => (
            <label key={level.id} className="flex cursor-pointer items-start gap-3 rounded-lg px-1 py-1">
              <input
                type="radio"
                name="notify-mail"
                value={level.id}
                checked={mail === level.id}
                onChange={() => void chooseMail(level.id)}
                className="accent-primary mt-1"
              />
              <span className="flex flex-col">
                <span className="text-[14px]">{level.label}</span>
                <span className="caption-style text-subtle">{level.detail}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {message && (
          <p role={message.tone} className={message.tone === "alert" ? "caption-style text-danger" : "caption-style text-subtle"}>
            {message.text}
          </p>
        )}
      </div>
    </SettingsCard>
  );
}
