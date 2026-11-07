"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import HoldButton from "@/components/_ui/hold-button";
import { connectLinearAction, disconnectLinearAction } from "@/app/(crm)/settings/actions";
import { GENERIC_ERROR } from "@/lib/utils";

export default function LinearWorkspace({
  connected,
  canAdmin,
  workspaceName,
  children,
}: {
  connected: boolean;
  canAdmin: boolean;
  workspaceName: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<{ error?: string }>) {
    setPending(true);
    setError(null);
    const result = await action().catch(() => ({ error: GENERIC_ERROR }));
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1.5">{children}</div>
        {canAdmin &&
          (connected ? (
            <HoldButton tone="neutral" disabled={pending} onConfirm={() => void run(disconnectLinearAction)}>
              Hold to disconnect
            </HoldButton>
          ) : (
            <Button variant="secondary" size="sm" disabled={pending} onClick={() => void run(connectLinearAction)}>
              {pending ? "Connecting…" : `Use in ${workspaceName}`}
            </Button>
          ))}
      </div>
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
