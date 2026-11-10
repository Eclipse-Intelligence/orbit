"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import ConfirmDialog from "@/components/_ui/confirm-dialog";
import { disconnectCalendarAccountAction } from "@/app/(crm)/calendar/actions";
import { removalText, type RemovalImpact } from "@/lib/mail/mailboxes";
import { GENERIC_ERROR } from "@/lib/utils";

export default function RemoveAccountButton({
  accountId,
  email,
  removes,
  disabled = false,
  onDone,
}: {
  accountId: string;
  email: string;
  removes: RemovalImpact | null;
  disabled?: boolean;
  onDone?: (result: { error?: string; message?: string }) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setPending(true);
    setError(null);
    const result = await disconnectCalendarAccountAction(accountId, email).catch(() => ({ error: GENERIC_ERROR }));
    setPending(false);
    if (result.error) {
      if (onDone) onDone({ error: result.error });
      else setError(result.error);
      return;
    }
    onDone?.({ message: `Removed ${email}.` });
    router.refresh();
  }

  return (
    <>
      <Button variant="ghost" size="sm" disabled={disabled || pending} aria-label={`Remove ${email}`} onClick={() => setOpen(true)}>
        {pending ? "Removing…" : "Remove"}
      </Button>
      {error && (
        <span role="alert" className="caption-style text-danger basis-full">
          {error}
        </span>
      )}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Remove ${email}?`}
        description={removalText(removes)}
        confirmLabel="Remove"
        onConfirm={() => void remove()}
      />
    </>
  );
}
