"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import { SettingsCard } from "@/components/crm/settings-ui";
import { saveMeetingLinkAction } from "@/app/(crm)/settings/actions";
import { checkMeetingLink, MEETING_LINK_MAX } from "@/lib/invite-rules";

export default function MeetingLinkSettings({ meetingLink }: { meetingLink: string | null }) {
  const router = useRouter();
  const [value, setValue] = useState(meetingLink ?? "");
  const [source, setSource] = useState(meetingLink);
  if (source !== meetingLink) {
    setSource(meetingLink);
    setValue(meetingLink ?? "");
  }
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const dirty = value.trim() !== (meetingLink ?? "");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    const checked = checkMeetingLink(value);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setError(null);
    setPending(true);
    const result = await saveMeetingLinkAction(checked.link ?? "");
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setValue(result.meetingLink ?? "");
    setMessage(result.meetingLink ? "Saved." : "Removed.");
    router.refresh();
  }

  return (
    <SettingsCard
      id="meeting-link"
      title="Meeting link"
      description="Your Whereby room, or any other https link. Orbit adds it to the invites you send as the location and a Join link."
    >
      <form className="flex flex-col gap-2" noValidate onSubmit={save}>
        <label className="sr-only" htmlFor="meeting-link-input">
          Meeting link
        </label>
        <div className="flex gap-2">
          <Input
            id="meeting-link-input"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            maxLength={MEETING_LINK_MAX}
            value={value}
            placeholder="https://whereby.com/your-room"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "meeting-link-error" : undefined}
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
              setMessage(null);
            }}
          />
          <Button variant="secondary" size="sm" type="submit" disabled={pending || !dirty}>
            {pending ? "Saving…" : "Save link"}
          </Button>
        </div>
        {error && (
          <p id="meeting-link-error" role="alert" className="caption-style text-danger">
            {error}
          </p>
        )}
        <p role="status" className="caption-style text-subtle">
          {message}
        </p>
      </form>
    </SettingsCard>
  );
}
