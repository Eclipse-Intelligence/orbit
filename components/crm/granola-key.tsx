"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import HoldButton from "@/components/_ui/hold-button";
import { Input } from "@/components/_ui/input";
import { removeGranolaKeyAction, saveGranolaKeyAction } from "@/app/(crm)/settings/actions";

export default function GranolaKey({ connected, hint }: { connected: boolean; hint: string | null }) {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<{ error?: string }>) {
    setPending(true);
    setError(null);
    const result = await action();
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setKey("");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      {connected ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[14px] leading-5">Connected{hint ? ` · key ending ${hint}` : ""}</span>
          <HoldButton tone="neutral" disabled={pending} onConfirm={() => void run(removeGranolaKeyAction)}>
            Hold to disconnect
          </HoldButton>
        </div>
      ) : (
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => saveGranolaKeyAction(key));
          }}
        >
          <Input
            type="password"
            autoComplete="off"
            aria-label="Granola API key"
            placeholder="Granola API key"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            className="sm:flex-1"
          />
          <Button variant="secondary" size="sm" type="submit" className="h-9" disabled={pending || !key.trim()}>
            {pending ? "Checking…" : "Connect"}
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      {!connected && (
        <p className="caption-style text-subtle leading-[1.4]">Create a key in Granola under Settings, API. Only you can see it.</p>
      )}
    </div>
  );
}
