"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import Switch from "@/components/_ui/switch";
import { SettingsCard } from "@/components/crm/settings-ui";
import { saveEnrichmentSettingsAction } from "@/app/(crm)/enrichment";
import { enrichCompaniesRequest } from "@/components/companies/company-enrich";
import type { ContactField, ProviderId } from "@/lib/enrichment/providers";
import type { EnrichmentSettings, ProviderStatus } from "@/lib/enrichment/settings";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";

function Status({ on, children }: { on: boolean; children: string }) {
  return (
    <span className="caption-style text-subtle flex items-center gap-1.5">
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", on ? "bg-success" : "bg-faint")} />
      {children}
    </span>
  );
}

function OrderList({
  title,
  order,
  providers,
  editable,
  busy,
  onMove,
}: {
  title: string;
  order: ProviderId[];
  providers: ProviderStatus[];
  editable: boolean;
  busy: boolean;
  onMove: (from: number, to: number) => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <span className="caption-style text-subtle">{title}</span>
      <ol className="flex flex-col gap-1">
        {order.map((id, index) => {
          const provider = providers.find((item) => item.id === id)!;
          return (
            <li key={id} className="flex items-center gap-2 rounded-lg bg-white/[0.03] py-1.5 pr-1.5 pl-3">
              <span className="caption-style text-subtle w-3 tabular-nums">{index + 1}</span>
              <span className={cn("min-w-0 flex-1 truncate text-[13px] leading-5", provider.configured ? "text-foreground" : "text-subtle")}>
                {provider.name}
                {!provider.configured && <span className="caption-style"> · skipped, no key</span>}
              </span>
              {editable && (
                <span className="flex items-center">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={busy || index === 0}
                    aria-label={`Move ${provider.name} up`}
                    onClick={() => onMove(index, index - 1)}
                  >
                    <ChevronDownIcon aria-hidden className="size-3 rotate-180" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={busy || index === order.length - 1}
                    aria-label={`Move ${provider.name} down`}
                    onClick={() => onMove(index, index + 1)}
                  >
                    <ChevronDownIcon aria-hidden className="size-3" />
                  </Button>
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Backfill({ initial }: { initial: number }) {
  const router = useRouter();
  const [remaining, setRemaining] = useState(initial);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  async function run() {
    setRunning(true);
    setMessage(null);
    let total = 0;
    let updated = 0;
    try {
      for (let round = 0; round < 200; round += 1) {
        const payload = await enrichCompaniesRequest({ backfill: true });
        const results = payload.results ?? [];
        total += results.length;
        updated += results.filter((result) => result.status === "updated").length;
        setDone(total);
        setRemaining(payload.remaining ?? 0);
        if (results.length === 0 || !payload.remaining) break;
      }
      setMessage({ text: `Checked ${total} ${total === 1 ? "company" : "companies"} and updated ${updated}.`, error: false });
      router.refresh();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "That stopped early. Try again.", error: true });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-foreground text-[13.5px] leading-5">Fill in existing companies</span>
        <span className="caption-style text-subtle">
          {running
            ? `Looking up companies… ${done} done, ${remaining} to go`
            : remaining > 0
              ? `${remaining} ${remaining === 1 ? "company has" : "companies have"} a website but no details yet. About 10 context.dev credits each.`
              : "Every company with a website has been checked."}
        </span>
        {message && <span className={cn("caption-style", message.error ? "text-danger" : "text-subtle")}>{message.text}</span>}
      </span>
      <Button variant="secondary" size="sm" disabled={running || remaining === 0} onClick={run}>
        {running ? "Filling in…" : "Fill in now"}
      </Button>
    </div>
  );
}

export default function EnrichmentSettingsCard({
  settings,
  providers,
  canAdmin,
  unenriched,
  logoLinkReady,
}: {
  settings: EnrichmentSettings;
  providers: ProviderStatus[];
  canAdmin: boolean;
  unenriched: number;
  logoLinkReady: boolean;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: EnrichmentSettings) {
    const previous = current;
    setCurrent(next);
    setBusy(true);
    setError(null);
    const result = await saveEnrichmentSettingsAction({ emailOrder: next.emailOrder, linkedinOrder: next.linkedinOrder, autoCompanies: next.autoCompanies });
    setBusy(false);
    if ("error" in result) {
      setCurrent(previous);
      setError(result.error);
      return;
    }
    setCurrent(result);
    router.refresh();
  }

  function move(field: ContactField, from: number, to: number) {
    const key = field === "email" ? "emailOrder" : "linkedinOrder";
    const order = [...current[key]];
    const [item] = order.splice(from, 1);
    order.splice(to, 0, item);
    void save({ ...current, [key]: order });
  }

  return (
    <SettingsCard
      id="enrichment"
      title="Contact enrichment"
      description="Finds missing work emails, LinkedIn profiles and phone numbers, trying each provider in order until one finds it. You only pay the provider that finds it. Company details, logos and social profiles come from context.dev."
    >
      <div className="flex flex-col gap-5">
        <ul className="flex flex-col gap-2">
          {providers.map((provider) => (
            <li key={provider.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-foreground text-[13.5px] leading-5">{provider.name}</span>
                <span className="caption-style text-subtle">
                  {provider.id === "context"
                    ? "Emails, LinkedIn and company details"
                    : provider.fields.includes("phone")
                      ? "Emails and phone numbers"
                      : provider.fields.includes("linkedin")
                        ? "Emails and LinkedIn"
                        : "Emails"}
                </span>
              </span>
              <Status on={provider.configured}>{provider.configured ? "Connected" : `Add ${provider.envKey} in Vercel`}</Status>
            </li>
          ))}
        </ul>
        <div className="flex flex-col gap-4 sm:flex-row">
          <OrderList
            title="Email order"
            order={current.emailOrder}
            providers={providers}
            editable={canAdmin}
            busy={busy}
            onMove={(from, to) => move("email", from, to)}
          />
          <OrderList
            title="LinkedIn order"
            order={current.linkedinOrder}
            providers={providers}
            editable={canAdmin}
            busy={busy}
            onMove={(from, to) => move("linkedin", from, to)}
          />
        </div>
        <p className="caption-style text-subtle leading-[1.4]">
          An email from context.dev is only saved if it&apos;s on the company&apos;s own domain, the match is confident and an email checker
          (Enrow, Icypeas or Hunter) confirms it can receive mail. Otherwise the next provider is tried.
        </p>
        <label className="flex items-center justify-between gap-3">
          <span className="flex flex-col gap-0.5">
            <span className="text-foreground text-[13.5px] leading-5">Fill in new companies automatically</span>
            <span className="caption-style text-subtle">Uses context.dev when a company with a website is added. Only empty fields are filled.</span>
          </span>
          {canAdmin ? (
            <Switch
              checked={current.autoCompanies}
              label="Fill in new companies automatically"
              onChange={(value) => void save({ ...current, autoCompanies: value })}
            />
          ) : (
            <Status on={current.autoCompanies}>{current.autoCompanies ? "On" : "Off"}</Status>
          )}
        </label>
        {canAdmin && providers.some((provider) => provider.id === "context" && provider.configured) && <Backfill initial={unenriched} />}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-foreground text-[13.5px] leading-5">Logos in lists</span>
            <span className="caption-style text-subtle leading-[1.4]">
              Shows every company&apos;s logo in the companies list using context.dev Logo Link, which has its own free allowance. Copy the Public
              Client ID from context.dev › Logo Link, restrict it to orbit.geteclipse.co, and add it in Vercel as NEXT_PUBLIC_CONTEXT_LOGO_CLIENT_ID.
            </span>
          </span>
          <Status on={logoLinkReady}>{logoLinkReady ? "On" : "Not set up"}</Status>
        </div>
        {error && <p className="caption-style text-danger leading-[1.4]">{error}</p>}
      </div>
    </SettingsCard>
  );
}
