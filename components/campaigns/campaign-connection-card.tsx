"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import HoldButton from "@/components/_ui/hold-button";
import { Input } from "@/components/_ui/input";
import { SettingsCard } from "@/components/crm/settings-ui";
import { removeCampaignConnectionAction, saveCampaignConnectionAction } from "@/app/(crm)/campaigns/actions";
import { PROVIDER_NAMES, type ConnectionView } from "@/lib/campaigns/types";
import { GENERIC_ERROR } from "@/lib/utils";

export default function CampaignConnectionCard({ view, children }: { view: ConnectionView; children?: ReactNode }) {
  const router = useRouter();
  const name = PROVIDER_NAMES[view.provider];
  const [key, setKey] = useState("");
  const [pending, setPending] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(kind: "save" | "remove", action: () => Promise<{ error?: string }>) {
    setPending(kind);
    setError(null);
    const result = await action().catch(() => ({ error: GENERIC_ERROR }));
    setPending(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    setKey("");
    router.refresh();
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!key.trim() || pending) return;
    void run("save", () => saveCampaignConnectionAction(view.provider, key));
  }

  return (
    <SettingsCard
      id={view.provider}
      title={name}
      description={
        <span className="flex flex-col gap-1">
          <span>{view.connected ? view.line : "Not connected"}</span>
          {view.connected && view.lastError && (
            <span role="status" className="text-danger">
              {view.lastError}
            </span>
          )}
        </span>
      }
      action={
        view.connected && view.canAdmin ? (
          <HoldButton tone="neutral" disabled={pending !== null} onConfirm={() => void run("remove", () => removeCampaignConnectionAction(view.provider))}>
            Hold to disconnect
          </HoldButton>
        ) : undefined
      }
    >
      {view.canAdmin ? (
        <>
          <form className="flex flex-col gap-2 sm:flex-row" onSubmit={save}>
            <Input
              type="password"
              autoComplete="off"
              aria-label={`${name} API key`}
              placeholder={view.keyHint ? `••••••••${view.keyHint}` : `${name} API key`}
              value={key}
              onChange={(event) => setKey(event.target.value)}
              className="sm:flex-1"
            />
            <Button variant="secondary" size="sm" type="submit" className="h-9" disabled={pending !== null || !key.trim()}>
              {pending === "save" ? "Checking…" : "Save"}
            </Button>
          </form>
          {error && (
            <p role="alert" className="caption-style text-danger">
              {error}
            </p>
          )}
          {children}
        </>
      ) : (
        children
      )}
    </SettingsCard>
  );
}
