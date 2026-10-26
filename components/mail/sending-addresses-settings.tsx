"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { SettingsCard } from "@/components/crm/settings-ui";
import type { SendIdentity } from "@/lib/mail/identities";
import { cn } from "@/lib/utils";
import { Radio } from "@/components/_ui/radio";

type Source = { id: string; email: string };

const field =
  "bg-white/[0.06] text-foreground placeholder:text-subtle h-9 w-full rounded-lg px-3 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60";

export default function SendingAddressesSettings({ identities, sources, suggestedSource }: { identities: SendIdentity[]; sources: Source[]; suggestedSource: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<"neo" | "other">("neo");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    const response = await fetch("/api/mail/identities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...Object.fromEntries(form.entries()), provider }),
    }).catch(() => null);
    const body = (await response?.json().catch(() => ({}))) as { error?: string; email?: string } | undefined;
    setBusy(false);
    if (!response?.ok) {
      setError(body?.error ?? "That didn't save. Try again.");
      return;
    }
    setOpen(false);
    setNotice(`${body?.email} is ready. Choose it in From, and replies to mail sent to it will use it automatically.`);
    router.refresh();
  }

  async function remove(id: string) {
    setBusy(true);
    await fetch(`/api/mail/identities?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
    setBusy(false);
    router.refresh();
  }

  return (
    <SettingsCard
      id="sending-addresses"
      title="Send from other addresses"
      description="Send from an address that isn't a Microsoft account, such as Neo, using its own mail server. Its mail should already arrive in one of your connected mailboxes (for example by forwarding)."
      action={
        !open && (
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
            Add an address
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3">
        {identities.length > 0 && (
          <ul className="flex flex-col gap-2">
            {identities.map((identity) => (
              <li key={identity.id} className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.03] px-3 py-2">
                <span className="flex min-w-0 flex-col">
                  <span className="text-foreground truncate text-[14px]">{identity.email}</span>
                  <span className={identity.lastError ? "caption-style text-danger" : "caption-style text-subtle"}>
                    {identity.lastError
                      ? `Last send failed: ${identity.lastError}`
                      : `Sends through ${identity.smtpHost}; mail arrives in ${sources.find((source) => source.id === identity.sourceId)?.email ?? "a connected mailbox"}`}
                  </span>
                </span>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void remove(identity.id)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        {open && (
          <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg bg-white/[0.03] p-3.5">
            <fieldset className="flex gap-2">
              <legend className="caption-style text-subtle pb-1.5">Provider</legend>
              {(["neo", "other"] as const).map((item) => (
                <label key={item} className="flex cursor-pointer items-center gap-2 text-[14px]">
                  <Radio name="provider-choice" checked={provider === item} onChange={() => setProvider(item)} />
                  {item === "neo" ? "Neo" : "Other (SMTP)"}
                </label>
              ))}
            </fieldset>
            <label className="flex flex-col gap-1">
              <span className="caption-style text-subtle">Email address</span>
              <input name="email" type="email" required autoComplete="off" placeholder="you@yourdomain.com" className={field} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="caption-style text-subtle">Name people see</span>
              <input name="displayName" placeholder="Mark Ridgeon" className={field} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="caption-style text-subtle">Password (or app password)</span>
              <input name="password" type="password" required autoComplete="new-password" className={field} />
            </label>
            {provider === "other" && (
              <div className="grid grid-cols-[1fr_6rem] gap-2">
                <label className="flex flex-col gap-1">
                  <span className="caption-style text-subtle">Outgoing (SMTP) server</span>
                  <input name="smtpHost" required placeholder="smtp.example.com" className={field} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="caption-style text-subtle">Port</span>
                  <input name="smtpPort" inputMode="numeric" defaultValue="465" className={field} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="caption-style text-subtle">Incoming (IMAP) server, to keep a copy in Sent</span>
                  <input name="imapHost" placeholder="imap.example.com (optional)" className={field} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="caption-style text-subtle">Port</span>
                  <input name="imapPort" inputMode="numeric" defaultValue="993" className={field} />
                </label>
                <label className="col-span-2 flex flex-col gap-1">
                  <span className="caption-style text-subtle">Username, if it isn&apos;t the email address</span>
                  <input name="username" autoComplete="off" className={field} />
                </label>
              </div>
            )}
            <label className="flex flex-col gap-1">
              <span className="caption-style text-subtle">Its mail arrives in</span>
              <select name="sourceId" defaultValue={suggestedSource ?? sources[0]?.id} className={cn(field, "select-chevron cursor-pointer")}>
                {sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.email}
                  </option>
                ))}
              </select>
            </label>
            {error && (
              <p role="alert" className="caption-style text-danger">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <Button variant="primary" type="submit" disabled={busy}>
                {busy ? "Checking…" : "Check and save"}
              </Button>
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </form>
        )}
        {notice && (
          <p role="status" className="caption-style text-subtle">
            {notice}
          </p>
        )}
      </div>
    </SettingsCard>
  );
}
