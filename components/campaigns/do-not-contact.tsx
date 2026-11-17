"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import ConfirmDialog from "@/components/_ui/confirm-dialog";
import Tag from "@/components/_ui/tag";
import { liftDoNotContactAction, setDoNotContactAction } from "@/app/(crm)/campaigns/actions";
import type { DoNotContact, DoNotContactTarget } from "@/lib/campaigns/suppression";

export const DO_NOT_CONTACT_DETAIL = "Stops them in every campaign and blocks campaigns, bulk email and workflow emails to them. One-to-one emails show a warning.";

export function DoNotContactStatus({ status, target, canLift }: { status: DoNotContact; target: DoNotContactTarget; canLift: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function lift() {
    setBusy(true);
    setError(null);
    const outcome = await liftDoNotContactAction(target).catch(() => ({ error: "Couldn't lift. Try again." }));
    setBusy(false);
    if (outcome.error) {
      setError(outcome.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Tag tone="red" size="sm" className="caption-style">
          Do not contact
        </Tag>
        {canLift && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void lift()} className="hit">
            Lift
          </Button>
        )}
      </div>
      <span className="caption-style text-subtle">{status.line}</span>
      {error && (
        <span role="alert" className="caption-style text-danger">
          {error}
        </span>
      )}
    </div>
  );
}

export function DoNotContactDialog({
  open,
  onOpenChange,
  name,
  target,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  target: DoNotContactTarget;
  onError: (error: string | null) => void;
}) {
  const router = useRouter();

  async function confirm() {
    onError(null);
    const outcome = await setDoNotContactAction(target).catch(() => ({ error: "Couldn't save. Try again." }));
    if (outcome.error) {
      onError(outcome.error);
      return;
    }
    router.refresh();
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Do not contact ${name}?`}
      description={DO_NOT_CONTACT_DETAIL}
      confirmLabel="Do not contact"
      tone="neutral"
      onConfirm={() => void confirm()}
    />
  );
}
