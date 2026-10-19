"use client";

import { useEffect, useState } from "react";
import { recordSelectClass } from "@/components/crm/record-form";
import { listSendersAction } from "@/app/(crm)/capture/actions";
import type { Sender } from "@/lib/crm/inbox";
import { cn } from "@/lib/utils";

export function useSenders(enabled: boolean) {
  const [senders, setSenders] = useState<Sender[]>([]);
  const [from, setFrom] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    listSendersAction().then(
      (list) => {
        if (!cancelled) setSenders(list);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const chosen = senders.find((sender) => sender.id === from) ?? senders.find((sender) => sender.primary) ?? senders[0] ?? null;
  return { senders, from: chosen?.id ?? null, chosen, setFrom };
}

export function SenderSelect({
  id,
  senders,
  value,
  onChange,
  disabled,
  className,
}: {
  id: string;
  senders: Sender[];
  value: string | null;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  if (senders.length < 2) return null;
  return (
    <label className={cn("flex items-center gap-2", className)} htmlFor={id}>
      <span className="caption-style text-subtle shrink-0">From</span>
      <select
        id={id}
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={cn(recordSelectClass, "h-8 w-auto max-w-full min-w-0 text-[13px]")}
      >
        {senders.map((sender) => (
          <option key={sender.id} value={sender.id}>
            {sender.label}
          </option>
        ))}
      </select>
    </label>
  );
}
