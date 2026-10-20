"use client";

import { useState, useTransition, type FormEvent } from "react";
import Button from "@/components/_ui/button";
import { SettingsCard } from "@/components/crm/settings-ui";
import { createPersonalTokenAction, revokePersonalTokenAction } from "@/app/(crm)/settings/api/actions";
import type { PersonalToken } from "@/lib/auth/personal";

const field =
  "bg-white/[0.06] text-foreground placeholder:text-subtle h-9 w-full rounded-lg px-3 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60";

function when(iso: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
}

export default function PersonalTokenSettings({ origin, initial }: { origin: string; initial: PersonalToken[] }) {
  const [tokens, setTokens] = useState(initial);
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const url = `${origin}/api/mcp`;

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get("name") ?? "");
    setError(null);
    startTransition(async () => {
      const result = await createPersonalTokenAction(name);
      if (result.error || !result.token || !result.details) {
        setError(result.error ?? "The token wasn't created. Try again.");
        return;
      }
      setFresh(result.token);
      setCopied(false);
      setTokens((current) => [result.details!, ...current]);
      form.reset();
    });
  }

  function revoke(id: string) {
    setError(null);
    startTransition(async () => {
      const result = await revokePersonalTokenAction(id);
      if (result.error) setError(result.error);
      else setTokens((current) => current.filter((token) => token.id !== id));
    });
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text).catch(() => undefined);
    setCopied(true);
  }

  const command = fresh ? `claude mcp add --transport http orbit ${url} --header "Authorization: Bearer ${fresh}"` : "";

  return (
    <SettingsCard
      id="personal-tokens"
      title="Your mail in Claude"
      description="A personal token lets Claude, or any app that speaks MCP, use Orbit as you: the CRM, plus your own email to search, read, ask about and save drafts for you to send. It can never send email. Anyone with the token can read your mail, so keep it private and revoke it if it leaks."
    >
      <div className="flex flex-col gap-4">
        <form onSubmit={create} className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-[12em] flex-1 flex-col gap-1.5">
            <span className="caption-style text-subtle">Token name</span>
            <input name="name" required maxLength={80} placeholder="Claude on my Mac" className={field} />
          </label>
          <Button type="submit" variant="primary" disabled={pending}>
            Create token
          </Button>
        </form>
        {fresh && (
          <div role="status" className="flex flex-col gap-2 rounded-xl bg-white/[0.035] px-3 py-3">
            <p className="text-[14px] leading-5">Copy it now. Orbit won&apos;t show it again.</p>
            <code className="bg-secondary rounded-md px-2 py-1.5 font-mono text-[12px] leading-5 break-all">{fresh}</code>
            <p className="caption-style text-subtle">To add it to Claude Code, run:</p>
            <code className="bg-secondary rounded-md px-2 py-1.5 font-mono text-[12px] leading-5 break-all">{command}</code>
            <p className="caption-style text-subtle">
              In Claude Desktop or Cowork, add a custom connector with the URL {url} and the header Authorization: Bearer and the token.
            </p>
            <span className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => void copy(fresh)}>
                Copy token
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void copy(command)}>
                Copy Claude Code command
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setFresh(null)}>
                Done
              </Button>
              {copied && <span className="caption-style text-subtle self-center">Copied</span>}
            </span>
          </div>
        )}
        {tokens.length > 0 && (
          <ul aria-label="Your tokens" className="flex flex-col">
            {tokens.map((token) => (
              <li key={token.id} className="border-border flex flex-wrap items-center justify-between gap-2 border-t py-2.5 first:border-t-0">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[14px]">{token.name}</span>
                  <span className="caption-style text-subtle">
                    {token.prefix}… · made {when(token.createdAt)} · {token.lastUsedAt ? `last used ${when(token.lastUsedAt)}` : "not used yet"}
                  </span>
                </span>
                <Button variant="ghost" size="sm" disabled={pending} onClick={() => revoke(token.id)} aria-label={`Revoke ${token.name}`}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p role="alert" className="caption-style text-danger">
            {error}
          </p>
        )}
      </div>
    </SettingsCard>
  );
}
