"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Monogram } from "@/components/beautifui/record-marks";
import Button, { buttonVariants } from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import Tag from "@/components/_ui/tag";
import ChannelIcon from "@/components/campaigns/channel-icon";
import { QuietTabs } from "@/components/crm/contact-activities";
import SectionHeader from "@/components/crm/section-header";
import type { Viewer } from "@/components/crm/viewer";
import { importCampaignProspectsAction } from "@/app/(crm)/campaigns/actions";
import { campaignRates, number, prospectLine, prospectTag, STATUS_LABELS } from "@/lib/campaigns/format";
import {
  PROVIDER_NAMES,
  type CampaignChannel,
  type CampaignDetail,
  type DayStats,
  type ProspectFilter,
  type ProspectPage,
  type SenderCapacity,
  type SequenceStep,
  type StepStats,
} from "@/lib/campaigns/types";
import { contactHref } from "@/lib/crm/hrefs";
import { cn, GENERIC_ERROR } from "@/lib/utils";
import ChevronLeftIcon from "@/public/assets/images/_common/chevron-left.svg";
import ExternalIcon from "@/public/assets/images/campaigns/external.svg";

const FILTER_TABS: { id: ProspectFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "replied", label: "Replied" },
  { id: "skipped", label: "Skipped" },
];

function Section({ title, action, children, className }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("border-border flex flex-col gap-3.5 border-b px-4 py-5 last:border-b-0 sm:px-5", className)}>
      {(title || action) && (
        <div className="flex min-h-[30px] flex-wrap items-center justify-between gap-2">
          {title && <h2 className="eyebrow-style">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

function Stat({ value, label, className }: { value: string | null; label: string; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <span className="text-[18px] leading-6 font-medium tabular-nums">{value ?? "·"}</span>
      <span className="caption-style text-subtle">{label}</span>
    </div>
  );
}

const CHART_WORDS = {
  email: { bar: "Sent", overlay: "Replied", barWord: "sent", overlayWord: "replied" },
  linkedin: { bar: "Invites", overlay: "Accepted", barWord: "invites", overlayWord: "accepted" },
} as const;

function Chart({ days, channel }: { days: DayStats[]; channel: CampaignChannel }) {
  const words = CHART_WORDS[channel];
  const overlayOf = (day: DayStats) => (channel === "linkedin" ? (day.accepted ?? 0) : day.replied);
  const top = Math.max(1, ...days.map((day) => Math.max(day.sent, overlayOf(day))));
  const sent = days.reduce((sum, day) => sum + day.sent, 0);
  const overlay = days.reduce((sum, day) => sum + overlayOf(day), 0);
  return (
    <div
      role="img"
      aria-label={`Last 30 days: ${sent.toLocaleString("en-GB")} ${words.barWord}, ${overlay.toLocaleString("en-GB")} ${words.overlayWord}`}
      className="flex h-16 items-end gap-[3px] sm:h-20"
    >
      {days.map((day) => (
        <span key={day.day} className="relative flex h-full flex-1 items-end" title={`${day.day}: ${day.sent} ${words.barWord}, ${overlayOf(day)} ${words.overlayWord}`}>
          <span className="bg-foreground/25 w-full rounded-[2px]" style={{ height: `${(day.sent / top) * 100}%` }} />
          {overlayOf(day) > 0 && (
            <span className="bg-primary absolute inset-x-0 bottom-0 rounded-[2px]" style={{ height: `${Math.max((overlayOf(day) / top) * 100, 6)}%` }} />
          )}
        </span>
      ))}
    </div>
  );
}

const VARIABLE_SPLIT = { email: /(\{\{\s*[A-Za-z0-9_]+\s*\}\})/g, linkedin: /((?<!\{)\{\s*[A-Za-z0-9_]+\s*\}(?!\}))/g } as const;
const VARIABLE_NAME = { email: /^\{\{\s*([A-Za-z0-9_]+)\s*\}\}$/, linkedin: /^\{\s*([A-Za-z0-9_]+)\s*\}$/ } as const;

function Highlighted({ text, standard, channel }: { text: string; standard: Set<string>; channel: CampaignChannel }) {
  const parts = text.split(VARIABLE_SPLIT[channel]);
  return (
    <>
      {parts.map((part, index) => {
        const name = part.match(VARIABLE_NAME[channel])?.[1];
        if (!name) return <span key={index}>{part}</span>;
        return (
          <span key={index} className={cn("font-mono text-[12px]", standard.has(name) ? "text-subtle" : "text-(--tag-purple-text)")}>
            {part}
          </span>
        );
      })}
    </>
  );
}

function stepLabel(step: SequenceStep, steps: SequenceStep[]) {
  const variants = steps.filter((item) => item.step === step.step).length;
  return variants > 1 && step.variant ? `${step.step}${step.variant}` : String(step.step);
}

function statsFor(step: SequenceStep, steps: SequenceStep[], stats: StepStats[]) {
  const exact = stats.find((item) => item.step === step.step && (item.variant ?? null) === (step.variant ?? null));
  if (exact) return exact;
  const single = steps.filter((item) => item.step === step.step).length === 1;
  return single ? (stats.find((item) => item.step === step.step) ?? null) : null;
}

function rate(part: number, whole: number) {
  if (!whole) return null;
  const value = (part / whole) * 100;
  return value === 0 ? "0%" : `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}

function StepText({ step, campaign, standard }: { step: SequenceStep; campaign: CampaignDetail; standard: Set<string> }) {
  if (campaign.channel === "linkedin") {
    return (
      <span className="min-w-0 wrap-anywhere">
        {step.subject}
        {step.body ? (
          <>
            {": "}
            <Highlighted text={step.body} standard={standard} channel="linkedin" />
          </>
        ) : null}
      </span>
    );
  }
  return (
    <span className="min-w-0 wrap-anywhere">
      {step.subject ? <Highlighted text={step.subject} standard={standard} channel="email" /> : <span className="text-subtle">Same thread</span>}
    </span>
  );
}

function secondRate(stats: StepStats, linkedin: boolean) {
  if (!linkedin) return rate(stats.opened, stats.sent);
  return stats.accepted === undefined ? null : rate(stats.accepted, stats.sent);
}

function Steps({ campaign }: { campaign: CampaignDetail }) {
  const linkedin = campaign.channel === "linkedin";
  const standard = new Set(campaign.standardVariables);
  const rows = campaign.sequence.map((step) => ({ step, stats: statsFor(step, campaign.sequence, campaign.stepStats) }));
  const scored = rows.filter((row) => row.stats && row.stats.sent > 0);
  const best = !linkedin && scored.length > 1 ? scored.reduce((top, row) => (row.stats!.replied / row.stats!.sent > top.stats!.replied / top.stats!.sent ? row : top)) : null;
  if (rows.length === 0) return <p className="ui-style text-subtle">No steps</p>;
  return (
    <ul className="flex flex-col">
      <li aria-hidden className="caption-style text-subtle hidden grid-cols-[2rem_minmax(0,1fr)_4.5rem_4.5rem_4.5rem] gap-3 pb-1.5 md:grid">
        <span />
        <span />
        <span className="text-right">Sent</span>
        <span className="text-right">{linkedin ? "Accepted" : "Opened"}</span>
        <span className="text-right">Replied</span>
      </li>
      {rows.map(({ step, stats }) => (
        <li
          key={`${step.step}:${step.variant ?? ""}`}
          className="border-border ui-style grid grid-cols-[2rem_minmax(0,1fr)_auto] items-baseline gap-3 border-t py-2 md:grid-cols-[2rem_minmax(0,1fr)_4.5rem_4.5rem_4.5rem]"
        >
          <span className="text-faint tabular-nums">{stepLabel(step, campaign.sequence)}</span>
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <StepText step={step} campaign={campaign} standard={standard} />
            {step.delayDays ? (
              <span className="caption-style text-subtle">{linkedin ? `${step.delayDays === 1 ? "1 day" : `${step.delayDays} days`} later` : `day ${step.delayDays}`}</span>
            ) : null}
            {best && best.step === step && (
              <Tag tone="green" size="sm" className="caption-style">
                Best
              </Tag>
            )}
          </span>
          <span className={cn("text-right tabular-nums", !linkedin && "hidden md:block")}>{stats ? number(stats.sent) : "·"}</span>
          <span className="hidden text-right tabular-nums md:block">{stats ? (secondRate(stats, linkedin) ?? "·") : "·"}</span>
          <span className={cn("text-right tabular-nums", linkedin && "hidden md:block")}>{stats && !linkedin ? (rate(stats.replied, stats.sent) ?? "·") : "·"}</span>
        </li>
      ))}
    </ul>
  );
}

function ProspectsList({ prospects, linkedin }: { prospects: ProspectPage; linkedin: boolean }) {
  if (prospects.rows.length === 0) return <p className="ui-style text-subtle">No prospects</p>;
  return (
    <ul className="-mx-4 flex flex-col sm:-mx-5">
      {linkedin && (
        <li aria-hidden className="caption-style text-subtle hidden grid-cols-[minmax(0,1.3fr)_8rem_minmax(0,0.8fr)_minmax(0,1fr)] gap-3 px-5 pb-1.5 md:grid">
          <span>Person</span>
          <span />
          <span>Sender</span>
          <span />
        </li>
      )}
      {prospects.rows.map((row) => {
        const tag = prospectTag(row);
        const line = linkedin && row.sender ? `${row.sender} · ${lowerFirst(prospectLine(row))}` : prospectLine(row);
        return (
          <li
            key={row.id}
            className={cn(
              "border-border relative grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t px-4 py-2 transition-colors duration-150 hover:bg-white/3 sm:px-5",
              linkedin ? "md:grid-cols-[minmax(0,1.3fr)_8rem_minmax(0,0.8fr)_minmax(0,1fr)]" : "md:grid-cols-[minmax(0,1.3fr)_8rem_minmax(0,1fr)]",
            )}
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <Monogram name={row.name} />
              <span className="flex min-w-0 flex-col gap-0.5">
                {row.contactId ? (
                  <Link href={contactHref(row.contactId)} className="truncate text-[14px] leading-5 after:absolute after:inset-0">
                    {row.name}
                  </Link>
                ) : (
                  <span className="truncate text-[14px] leading-5">{row.name}</span>
                )}
                <span className="caption-style text-subtle truncate md:hidden">{line}</span>
                {row.companyName && <span className="caption-style text-subtle hidden truncate md:block">{row.companyName}</span>}
              </span>
            </span>
            <span className="flex justify-end md:justify-start">
              {tag ? (
                <Tag tone={tag.tone} size="sm" className="caption-style">
                  {tag.label}
                </Tag>
              ) : (
                <span className="caption-style text-subtle hidden md:inline">
                  <span aria-hidden>·</span>
                  <span className="sr-only">None</span>
                </span>
              )}
            </span>
            {linkedin && <span className="ui-style hidden truncate md:block">{row.sender ?? ""}</span>}
            <span className="caption-style text-subtle hidden truncate md:block">{prospectLine(row)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function lowerFirst(text: string) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function capacityLine(capacity: SenderCapacity) {
  const senders = capacity.senders === 1 ? "1 sender" : `${capacity.senders.toLocaleString("en-GB")} senders`;
  if (capacity.invites === null) return `${senders}.`;
  return `${senders} ${capacity.senders === 1 ? "sends" : "send"} ${capacity.invites.toLocaleString("en-GB")} invites a day.`;
}

function ImportLine({ campaignId, unlinked }: { campaignId: string; unlinked: number }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  async function run() {
    setPending(true);
    setMessage(null);
    const outcome = await importCampaignProspectsAction(campaignId).catch(() => ({ error: GENERIC_ERROR, result: undefined }));
    setPending(false);
    if (outcome.error || !outcome.result) {
      setMessage({ text: outcome.error ?? GENERIC_ERROR, error: true });
      return;
    }
    const { linked, failed, left } = outcome.result;
    const parts = [`Added ${linked.toLocaleString("en-GB")} to Orbit.`];
    if (failed > 0) parts.push(`${failed.toLocaleString("en-GB")} couldn't be added.`);
    if (left > failed) parts.push(`${(left - failed).toLocaleString("en-GB")} left.`);
    setMessage({ text: parts.join(" "), error: false });
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="ui-style text-soft">{unlinked === 1 ? "1 prospect isn't in Orbit." : `${unlinked.toLocaleString("en-GB")} prospects aren't in Orbit.`}</span>
      <Button variant="secondary" size="sm" disabled={pending} onClick={() => void run()}>
        {pending ? "Importing…" : "Import"}
      </Button>
      {message && (
        <span role={message.error ? "alert" : "status"} className={cn("caption-style", message.error ? "text-danger" : "text-subtle")}>
          {message.text}
        </span>
      )}
    </div>
  );
}

export default function CampaignScreen({
  viewer,
  campaign,
  prospects,
  filter,
  search,
  canImport,
  mailboxes,
}: {
  viewer: Viewer;
  campaign: CampaignDetail;
  prospects: ProspectPage;
  filter: ProspectFilter;
  search: string;
  canImport: boolean;
  mailboxes: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [draft, setDraft] = useState(search);
  const rates = campaignRates(campaign);
  const linkedin = campaign.channel === "linkedin";
  const custom = campaign.variables.filter((name) => !campaign.standardVariables.includes(name));
  const pages = Math.ceil(prospects.total / prospects.pageSize);

  function go(changes: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    const next = params.toString();
    router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    go({ q: draft.trim() || null, page: null });
  }

  const extras = [
    rates.opened ? `${rates.opened} opened` : null,
    campaign.stats.unsubscribed ? `${number(campaign.stats.unsubscribed)} unsubscribed` : null,
  ].filter(Boolean);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader
        title={campaign.name}
        viewer={viewer}
        heading={
          <span className="flex min-w-0 items-center gap-2">
            <Link
              href="/campaigns"
              aria-label="Back to Campaigns"
              title="Back to Campaigns"
              className="text-subtle hover:text-foreground hit flex size-[30px] shrink-0 items-center justify-center rounded-full transition-colors duration-150 hover:bg-white/6"
            >
              <ChevronLeftIcon aria-hidden className="size-3" />
            </Link>
            <ChannelIcon channel={campaign.channel} className="text-subtle size-3.5 shrink-0" />
            <h1 className="truncate">{campaign.name || "Untitled campaign"}</h1>
            {campaign.status !== "active" && (
              <Tag tone="neutral" size="sm" className="caption-style">
                {STATUS_LABELS[campaign.status]}
              </Tag>
            )}
          </span>
        }
        action={
          campaign.url ? (
            <a
              href={campaign.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open in ${PROVIDER_NAMES[campaign.provider]}`}
              title={`Open in ${PROVIDER_NAMES[campaign.provider]}`}
              className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "hit")}
            >
              <ExternalIcon aria-hidden className="size-3.5" />
            </a>
          ) : undefined
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-[60em] flex-col pb-20">
          <Section>
            {linkedin ? (
              <div className="flex flex-wrap gap-x-8 gap-y-3">
                <Stat value={number(campaign.prospects)} label="Prospects" className="max-sm:hidden" />
                <Stat value={number(campaign.stats.invites)} label="Invites" />
                <Stat value={rates.accepted} label="Accepted" />
                <Stat value={rates.replied} label="Replied" />
                <Stat value={rates.positive} label="Positive" className="max-sm:hidden" />
              </div>
            ) : (
              <div className="flex flex-wrap gap-x-8 gap-y-3">
                <Stat value={number(campaign.prospects)} label="Prospects" />
                <Stat value={number(campaign.stats.sent)} label="Sent" className="max-sm:hidden" />
                <Stat value={rates.replied} label="Replied" />
                <Stat value={rates.positive} label="Positive" />
                <Stat value={rates.bounced} label="Bounced" />
              </div>
            )}
            <Chart days={campaign.days} channel={campaign.channel} />
            <div className="caption-style text-subtle flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="bg-foreground/25 size-2 rounded-[2px]" />
                {CHART_WORDS[campaign.channel].bar}
              </span>
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="bg-primary size-2 rounded-[2px]" />
                {CHART_WORDS[campaign.channel].overlay}
              </span>
              {extras.length > 0 && <span>{extras.join(" · ")}</span>}
            </div>
            {!campaign.backfilled && <p className="caption-style text-subtle">Reading from {PROVIDER_NAMES[campaign.provider]}…</p>}
          </Section>

          <Section title="Steps">
            <Steps campaign={campaign} />
            {linkedin && campaign.capacity && <p className="ui-style text-soft">{capacityLine(campaign.capacity)}</p>}
          </Section>

          {custom.length > 0 && (
            <Section title="Variables">
              <ul className="flex flex-wrap gap-1.5">
                {custom.map((name) => (
                  <li key={name}>
                    <Tag tone="purple" size="sm" className="caption-style font-mono">
                      {name}
                    </Tag>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {mailboxes && <Section title="Sending">{mailboxes}</Section>}

          <Section
            title="Prospects"
            action={
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <QuietTabs label="Show prospects" items={FILTER_TABS} value={filter} onChange={(value) => go({ show: value === "all" ? null : value, page: null })} />
                <form role="search" onSubmit={submitSearch} className="w-full sm:w-48">
                  <Input type="search" aria-label="Search prospects" placeholder="Search" value={draft} onChange={(event) => setDraft(event.target.value)} className="h-8" />
                </form>
              </div>
            }
          >
            {canImport && campaign.unlinked > 0 && <ImportLine campaignId={campaign.id} unlinked={campaign.unlinked} />}
            <ProspectsList prospects={prospects} linkedin={linkedin} />
            {pages > 1 && (
              <div className="flex items-center justify-between gap-2">
                <span className="caption-style text-subtle">
                  Page {prospects.page} of {pages}
                </span>
                <span className="flex gap-2">
                  <Button variant="secondary" size="sm" disabled={prospects.page <= 1} onClick={() => go({ page: prospects.page > 2 ? String(prospects.page - 1) : null })}>
                    Previous
                  </Button>
                  <Button variant="secondary" size="sm" disabled={prospects.page >= pages} onClick={() => go({ page: String(prospects.page + 1) })}>
                    Next
                  </Button>
                </span>
              </div>
            )}
          </Section>
        </div>
      </div>
    </section>
  );
}
