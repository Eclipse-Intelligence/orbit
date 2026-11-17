"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/_ui/dialog";
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
    if (outcome.error) {
      setBusy(false);
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
          <Button variant="ghost" size="sm" disabled={busy} aria-busy={busy} onClick={() => void lift()} className="hit">
            {busy ? "Lifting…" : "Lift"}
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  target: DoNotContactTarget;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    const outcome = await setDoNotContactAction(target).catch(() => ({ error: "Couldn't save. Try again." }));
    setBusy(false);
    if (outcome.error) {
      setError(outcome.error);
      return;
    }
    onOpenChange(false);
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader className="pr-12">
          <DialogTitle>Do not contact {name}?</DialogTitle>
          <DialogDescription>{DO_NOT_CONTACT_DETAIL}</DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="caption-style text-danger px-6">
            {error}
          </p>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="md" disabled={busy}>
              Cancel
            </Button>
          </DialogClose>
          <Button variant="primary" size="md" disabled={busy} aria-busy={busy} onClick={() => void confirm()}>
            {busy ? "Saving…" : "Do not contact"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
