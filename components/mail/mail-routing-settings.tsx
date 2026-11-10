"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { NativeSelect } from "@/components/_ui/native-select";
import { tagBase } from "@/components/beautifui/record-marks";
import { SettingsCard } from "@/components/crm/settings-ui";
import { removeDomainRuleAction, setAddressHomeAction } from "@/app/(crm)/mail/actions";
import type { AddressHome, DomainRule } from "@/lib/mail/routing";
import type { WorkspaceChoiceRef } from "@/lib/mail/view";

function names(ids: string[], workspaces: WorkspaceChoiceRef[]) {
  const labels = workspaces.filter((item) => ids.includes(item.id)).map((item) => item.name);
  return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : (labels[0] ?? "");
}

export default function MailRoutingSettings({ homes, rules, workspaces }: { homes: AddressHome[]; rules: DomainRule[]; workspaces: WorkspaceChoiceRef[] }) {
  const router = useRouter();
  const [chosen, setChosen] = useState<Record<string, string>>(() => Object.fromEntries(homes.map((home) => [home.address, home.workspaceId])));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function choose(home: AddressHome, workspaceId: string) {
    const previous = chosen[home.address];
    setChosen((current) => ({ ...current, [home.address]: workspaceId }));
    setBusy(home.address);
    setError(null);
    setNotice(null);
    const result = await setAddressHomeAction(home.address, workspaceId);
    setBusy(null);
    if (result.error) {
      setChosen((current) => ({ ...current, [home.address]: previous }));
      setError(result.error);
      return;
    }
    setNotice(`${home.address} now belongs to ${names([workspaceId], workspaces)}.`);
  }

  async function remove(rule: DomainRule) {
    setBusy(rule.domain);
    setError(null);
    setNotice(null);
    const result = await removeDomainRuleAction(rule.domain);
    setBusy(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <SettingsCard
      id="addresses"
      title="Addresses"
      description="Each address sends from one workspace, and mail from unknown senders waits in that workspace's Capture."
    >
      <div className="flex flex-col gap-4">
        <ul className="flex flex-col gap-2">
          {homes.map((home) => {
            const fieldId = `home-${home.address}`;
            return (
              <li key={home.address} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg bg-white/[0.03] px-3 py-2">
                <span className="flex min-w-0 flex-1 basis-56 items-center gap-2">
                  <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: tagBase(home.address) }} />
                  <span className="flex min-w-0 flex-col">
                    <span className="text-foreground truncate text-[14px]">{home.address}</span>
                    <span className="caption-style text-subtle">{home.kind === "mailbox" ? "Microsoft 365" : "Sending address"}</span>
                  </span>
                </span>
                <span className="flex items-center gap-2 max-sm:w-full">
                  <label htmlFor={fieldId} className="caption-style text-subtle shrink-0">
                    Workspace
                  </label>
                  <NativeSelect
                    id={fieldId}
                    aria-label={`Workspace for ${home.address}`}
                    value={chosen[home.address]}
                    disabled={busy === home.address}
                    onChange={(event) => void choose(home, event.target.value)}
                    className="w-auto min-w-[11rem] max-sm:min-w-0 max-sm:flex-1"
                  >
                    {workspaces.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </NativeSelect>
                </span>
              </li>
            );
          })}
        </ul>
        {rules.length > 0 && (
          <div className="flex flex-col gap-2">
            <h4 className="ui-style text-soft">Domain rules</h4>
            <ul className="flex flex-col gap-2">
              {rules.map((rule) => (
                <li key={rule.domain} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white/[0.03] px-3 py-2">
                  <span className="flex min-w-0 flex-col">
                    <span className="text-foreground truncate text-[14px]">Everyone at @{rule.domain}</span>
                    <span className="caption-style text-subtle">Files in {names(rule.workspaceIds, workspaces)}</span>
                  </span>
                  <Button variant="ghost" size="sm" disabled={busy === rule.domain} onClick={() => void remove(rule)} aria-label={`Remove the rule for @${rule.domain}`}>
                    {busy === rule.domain ? "Removing…" : "Remove"}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && (
          <p role="alert" className="caption-style text-danger">
            {error}
          </p>
        )}
        <p role="status" className={notice ? "caption-style text-subtle" : "sr-only"}>
          {notice}
        </p>
      </div>
    </SettingsCard>
  );
}
