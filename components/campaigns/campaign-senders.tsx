"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { NativeSelect } from "@/components/_ui/native-select";
import { linkCampaignSenderAction } from "@/app/(crm)/campaigns/actions";
import type { CampaignSender, SendersView } from "@/lib/campaigns/types";
import { GENERIC_ERROR } from "@/lib/utils";

function senderLabel(sender: CampaignSender) {
  return sender.linkedin || sender.name || sender.externalId;
}

function SenderRow({ sender, view }: { sender: CampaignSender; view: SendersView }) {
  const router = useRouter();
  const [value, setValue] = useState(sender.userId ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = senderLabel(sender);
  const linked = view.members.find((member) => member.userId === sender.userId);

  async function change(next: string) {
    const previous = value;
    setValue(next);
    setPending(true);
    setError(null);
    const result = await linkCampaignSenderAction(sender.id, next || null).catch(() => ({ error: GENERIC_ERROR }));
    setPending(false);
    if (result.error) {
      setValue(previous);
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <li className="flex flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <span className="ui-style min-w-0 wrap-anywhere" title={sender.name || undefined}>
          {label}
        </span>
        {view.canAdmin ? (
          <NativeSelect
            aria-label={`Member for ${label}`}
            value={value}
            disabled={pending}
            onChange={(event) => void change(event.target.value)}
            className="h-8 w-full sm:w-44"
          >
            <option value="">Not linked</option>
            {view.members.map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.name}
              </option>
            ))}
          </NativeSelect>
        ) : (
          <span className="ui-style text-subtle">{linked?.name ?? (sender.userId ? "Linked" : "Not linked")}</span>
        )}
      </div>
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
    </li>
  );
}

export default function CampaignSenders({ view }: { view: SendersView }) {
  if (view.senders.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h4 className="eyebrow-style">Senders</h4>
        <p className="caption-style text-subtle">Only the linked member can reply from an account.</p>
      </div>
      <ul className="flex flex-col gap-2">
        {view.senders.map((sender) => (
          <SenderRow key={`${sender.id}:${sender.userId ?? ""}`} sender={sender} view={view} />
        ))}
      </ul>
    </div>
  );
}
