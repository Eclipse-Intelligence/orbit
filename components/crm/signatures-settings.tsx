"use client";

import { useState } from "react";
import Button from "@/components/_ui/button";
import { SettingsCard } from "@/components/crm/settings-ui";
import { saveSignatureAction } from "@/app/(crm)/inbox/actions";
import type { Sender } from "@/lib/crm/inbox";

function SignatureEditor({ sender }: { sender: Sender }) {
  const [value, setValue] = useState(sender.signature ?? "");
  const [saved, setSaved] = useState(sender.signature ?? "");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const id = `signature-${sender.id}`;

  async function save() {
    setPending(true);
    setMessage(null);
    const result = await saveSignatureAction(sender.email, value);
    setPending(false);
    if (result.error) {
      setMessage({ text: result.error, error: true });
      return;
    }
    setSaved(result.signature ?? "");
    setValue(result.signature ?? "");
    setMessage({ text: result.signature ? "Saved." : "Signature removed.", error: false });
  }

  return (
    <div className="border-border flex flex-col gap-2 border-b pb-4 last:border-b-0 last:pb-0">
      <label htmlFor={id} className="text-[14px] leading-5">
        {sender.email}
        {sender.primary && <span className="caption-style text-subtle"> · default</span>}
      </label>
      <textarea
        id={id}
        value={value}
        rows={4}
        maxLength={2000}
        placeholder={"Mark Ridgeon\nFounder, Eclipse\ngeteclipse.co"}
        onChange={(event) => setValue(event.target.value)}
        className="border-line-strong bg-secondary focus-visible:border-ring placeholder:text-subtle w-full rounded-lg border px-3 py-2 text-[13.5px] leading-5 outline-none"
      />
      <span className="flex items-center gap-2">
        <Button variant="secondary" size="sm" disabled={pending || value.trim() === saved.trim()} onClick={() => void save()}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {message && (
          <span role={message.error ? "alert" : "status"} className={message.error ? "caption-style text-danger" : "caption-style text-subtle"}>
            {message.text}
          </span>
        )}
      </span>
    </div>
  );
}

export default function SignaturesSettings({ senders }: { senders: Sender[] }) {
  return (
    <SettingsCard
      id="signatures"
      title="Signatures"
      description="Added below every email you send from that address, from a contact, in bulk or by the assistant. You can remove it from a single email while writing it."
    >
      {senders.length === 0 ? (
        <p className="caption-style text-subtle">Connect Microsoft in Inbox to add a signature.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {senders.map((sender) => (
            <SignatureEditor key={sender.id} sender={sender} />
          ))}
        </div>
      )}
    </SettingsCard>
  );
}
