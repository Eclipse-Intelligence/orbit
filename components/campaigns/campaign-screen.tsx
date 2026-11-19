"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Monogram } from "@/components/beautifui/record-marks";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import { NativeSelect } from "@/components/_ui/native-select";
import Tag from "@/components/_ui/tag";
import ChannelIcon from "@/components/campaigns/channel-icon";
import VariableBriefs from "@/components/campaigns/variable-briefs";
import { QuietTabs } from "@/components/crm/contact-activities";
import SectionHeader from "@/components/crm/section-header";
import type { Viewer } from "@/components/crm/viewer";
import { importCampaignProspectAction, importCampaignProspectsAction, setCampaignAutoAddAction, setCampaignPausedAction, startCampaignAction } from "@/app/(crm)/campaigns/actions";
import {
  AUTO_ADD_LABELS,
  autoAddChoices,
  campaignThreadPath,
  lastActionLine,
  linkedinCapacityLine,
  linkedinStatus,
  linkedinTag,
  number,
  percent,
  PROVIDER_STATS,
  providerFigure,
  prospectLine,
  prospectTag,
  STATUS_LABELS,
} from "@/lib/campaigns/format";
import { contactHref } from "@/lib/crm/hrefs";
import {
  PROVIDER_NAMES,
  type AutoAdd,
  type CampaignChannel,
  type CampaignDetail,
  type DayStats,
  type ProspectFilter,
  type ProspectPage,
  type ProspectRow,
  type SequenceStep,
  type StepStats,
} from "@/lib/campaigns/types";
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
    <section className={cn("flex flex-col gap-3.5 px-4 py-5 sm:px-5", className)}>
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
      <li
        aria-hidden
        className={cn(
          "caption-style text-subtle hidden gap-3 pb-1.5 md:grid",
          linkedin ? "grid-cols-[2rem_minmax(0,1fr)_4.5rem_4.5rem]" : "grid-cols-[2rem_minmax(0,1fr)_4.5rem_4.5rem_4.5rem]",
        )}
      >
        <span />
        <span />
        <span className="text-right">Sent</span>
        <span className="text-right">{linkedin ? "Accepted" : "Opened"}</span>
        {!linkedin && <span className="text-right">Replied</span>}
      </li>
      {rows.map(({ step, stats }) => (
        <li
          key={`${step.step}:${step.variant ?? ""}`}
          className={cn(
            "ui-style grid grid-cols-[2rem_minmax(0,1fr)_auto] items-baseline gap-3 py-2",
            linkedin ? "md:grid-cols-[2rem_minmax(0,1fr)_4.5rem_4.5rem]" : "md:grid-cols-[2rem_minmax(0,1fr)_4.5rem_4.5rem_4.5rem]",
          )}
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
          <span className={cn("text-right tabular-nums", !linkedin && "hidden md:block")}>
            <span className="sr-only">Sent </span>
            {stats ? number(stats.sent) : "·"}
          </span>
          <span className="hidden text-right tabular-nums md:block">
            <span className="sr-only">{linkedin ? "Accepted " : "Opened "}</span>
            {stats ? (secondRate(stats, linkedin) ?? "·") : "·"}
          </span>
          {!linkedin && (
            <span className="text-right tabular-nums">
              <span className="sr-only">Replied </span>
              {stats ? (rate(stats.replied, stats.sent) ?? "·") : "·"}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function Figure({ value, share }: { value: number; share: string | null }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-[18px] leading-6 font-medium tabular-nums">{number(value)}</span>
      {share && <span className="caption-style text-subtle tabular-nums">{share}</span>}
    </span>
  );
}

const HEYREACH_FUNNEL_KEYS = new Set<string>(["contacted", "accepted", "replied"]);

const FUNNEL_COLUMNS: Record<number, string> = { 1: "grid-cols-1", 3: "grid-cols-3", 4: "grid-cols-2 sm:grid-cols-4" };

function Funnel({ campaign }: { campaign: CampaignDetail }) {
  const unread = campaign.provider === "heyreach" && !campaign.leadFunnel;
  const items = PROVIDER_STATS[campaign.provider].funnel
    .map((item) => ({ ...item, value: providerFigure(campaign, item.key) }))
    .filter((item) => item.value !== undefined || (unread && HEYREACH_FUNNEL_KEYS.has(item.key)));
  if (items.length === 0) return null;
  return (
    <dl aria-label="Lead funnel" className={cn("grid gap-x-4 gap-y-4", FUNNEL_COLUMNS[items.length] ?? "grid-cols-2")}>
      {items.map((item) => (
        <div key={item.key} className="flex min-w-0 flex-col-reverse gap-1">
          <dt className="caption-style text-subtle truncate">{item.label}</dt>
          <dd className="min-w-0">
            {item.value === undefined ? (
              <span className="ui-style text-faint leading-6">Not synced yet</span>
            ) : (
              <Figure value={item.value} share={percent(item.value, providerFigure(campaign, item.of))} />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function LeadStatuses({ campaign }: { campaign: CampaignDetail }) {
  const items = PROVIDER_STATS[campaign.provider].statuses.filter((item) => campaign.stats[item.key] !== undefined);
  if (items.length === 0) return null;
  return (
    <dl aria-label="Lead statuses" className="ui-style flex flex-col">
      {items.map((item) => (
        <div key={item.key} className="flex items-baseline justify-between gap-4 py-1.5">
          <dt className="text-soft min-w-0 truncate">{item.label}</dt>
          <dd className="tabular-nums">{number(campaign.stats[item.key])}</dd>
        </div>
      ))}
    </dl>
  );
}

function ImportOne({ campaignId, prospectId, name }: { campaignId: string; prospectId: string; name: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setPending(true);
    setError(null);
    const outcome = await importCampaignProspectAction(campaignId, prospectId).catch(() => ({ error: "Couldn't import. Try again." }));
    setPending(false);
    if (outcome.error) {
      setError(outcome.error);
      return;
    }
    router.refresh();
  }

  return (
    <span className="relative z-10 flex min-w-0 flex-col items-end gap-0.5">
      <Button variant="secondary" size="sm" disabled={pending} onClick={() => void run()} aria-label={`Import ${name}`} className="hit">
        {pending ? "Importing…" : "Import"}
      </Button>
      {error && (
        <span role="alert" className="caption-style text-danger max-w-[16em] text-right">
          {error}
        </span>
      )}
    </span>
  );
}

function AutoAddSetting({ campaignId, channel, value }: { campaignId: string; channel: CampaignChannel; value: AutoAdd }) {
  const router = useRouter();
  const [current, setCurrent] = useState(value);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: AutoAdd) {
    const before = current;
    setCurrent(next);
    setPending(true);
    setError(null);
    const outcome = await setCampaignAutoAddAction(campaignId, next).catch(() => ({ error: "Couldn't save. Try again." }));
    setPending(false);
    if (outcome.error) {
      setCurrent(before);
      setError(outcome.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <label htmlFor="campaign-auto-add" className="ui-style text-soft">
          Add to Orbit
        </label>
        <NativeSelect id="campaign-auto-add" value={current} disabled={pending} onChange={(event) => void change(event.target.value as AutoAdd)} className="h-8 w-auto min-w-[11em]">
          {autoAddChoices(channel).map((item) => (
            <option key={item} value={item}>
              {AUTO_ADD_LABELS[item]}
            </option>
          ))}
        </NativeSelect>
      </div>
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function MessageCount({ row, channel }: { row: ProspectRow; channel: CampaignChannel }) {
  if (!row.messages) return null;
  return (
    <Link
      href={`/campaigns/conversations/${row.id}`}
      aria-label={`${row.messages === 1 ? "1 message" : `${row.messages.toLocaleString("en-GB")} messages`} with ${row.name}`}
      className="caption-style text-soft hover:text-foreground hit relative z-10 flex shrink-0 items-center gap-1 tabular-nums transition-colors duration-150"
    >
      <ChannelIcon channel={channel} className="size-3.5" />
      <span aria-hidden>{row.messages.toLocaleString("en-GB")}</span>
    </Link>
  );
}

function EmailProspects({ prospects }: { prospects: ProspectPage }) {
  return (
    <ul className="-mx-4 flex flex-col sm:-mx-5">
      {prospects.rows.map((row) => {
        const tag = prospectTag(row, "email");
        const line = prospectLine(row);
        return (
          <li
            key={row.id}
            className="relative grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-2 transition-colors duration-150 hover:bg-white/3 sm:px-5 md:grid-cols-[minmax(0,1.3fr)_8rem_minmax(0,1fr)]"
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <Monogram name={row.name} />
              <span className="flex min-w-0 flex-col gap-0.5">
                <Link href={campaignThreadPath(row.id)} className="truncate text-[14px] leading-5 after:absolute after:inset-0">
                  {row.name}
                </Link>
                <span className="caption-style text-subtle truncate md:hidden">{line}</span>
                {row.companyName && <span className="caption-style text-subtle hidden truncate md:block">{row.companyName}</span>}
              </span>
            </span>
            <span className="flex items-center justify-end gap-2 md:justify-start">
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
              <MessageCount row={row} channel="email" />
            </span>
            <span className="caption-style text-subtle hidden truncate md:block">{line}</span>
          </li>
        );
      })}
    </ul>
  );
}

const LINKEDIN_GRID = "md:grid-cols-[minmax(0,1.3fr)_8.5rem_minmax(0,0.8fr)_minmax(0,1.1fr)_5.5rem]";

function LinkedinProspects({ prospects, campaignId, canImport }: { prospects: ProspectPage; campaignId: string; canImport: boolean }) {
  return (
    <ul className="-mx-4 flex flex-col sm:-mx-5">
      <li aria-hidden className={cn("caption-style text-subtle hidden gap-3 px-5 pb-1.5 md:grid", LINKEDIN_GRID)}>
        <span>Lead</span>
        <span>Status</span>
        <span>Sender</span>
        <span>Last action</span>
        <span />
      </li>
      {prospects.rows.map((row) => {
        const tag = linkedinTag(row);
        const status = row.state === "pushed" ? linkedinStatus(row) : null;
        const action = lastActionLine(row);
        const phoneLine = [status, row.sender, action].filter(Boolean).join(" · ");
        return (
          <li
            key={row.id}
            className={cn(
              "relative grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-2 transition-colors duration-150 hover:bg-white/3 sm:px-5",
              LINKEDIN_GRID,
            )}
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <Monogram name={row.name} />
              <span className="flex min-w-0 flex-col gap-0.5">
                <Link href={campaignThreadPath(row.id)} className="truncate text-[14px] leading-5 after:absolute after:inset-0">
                  {row.name}
                </Link>
                {phoneLine && (
                  <span className="caption-style text-subtle line-clamp-2 md:hidden" suppressHydrationWarning>
                    {phoneLine}
                  </span>
                )}
                {row.companyName && <span className="caption-style text-subtle hidden truncate md:block">{row.companyName}</span>}
              </span>
            </span>
            <span className="hidden min-w-0 flex-wrap items-center gap-1.5 md:flex">
              {status && <span className="ui-style truncate">{status}</span>}
              {tag && (
                <Tag tone={tag.tone} size="sm" className="caption-style">
                  {tag.label}
                </Tag>
              )}
            </span>
            <span className="ui-style hidden truncate md:block">{row.sender ?? ""}</span>
            <span className="caption-style text-subtle hidden truncate md:block" suppressHydrationWarning>
              {action ?? ""}
            </span>
            <span className="flex items-center justify-end gap-2 pointer-coarse:gap-4">
              {tag && (
                <Tag tone={tag.tone} size="sm" className="caption-style md:hidden">
                  {tag.label}
                </Tag>
              )}
              <MessageCount row={row} channel="linkedin" />
              {canImport && row.importable === true ? (
                <ImportOne campaignId={campaignId} prospectId={row.id} name={row.name} />
              ) : row.contactId ? (
                <Button variant="ghost" size="sm" href={contactHref(row.contactId)} aria-label={`Open ${row.name} in Orbit`} className="hit relative z-10">
                  In Orbit
                </Button>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function ProspectsList({ prospects, linkedin, campaignId, canImport }: { prospects: ProspectPage; linkedin: boolean; campaignId: string; canImport: boolean }) {
  if (prospects.rows.length === 0) return <p className="ui-style text-subtle">No prospects</p>;
  return linkedin ? <LinkedinProspects prospects={prospects} campaignId={campaignId} canImport={canImport} /> : <EmailProspects prospects={prospects} />;
}

function strayLine(count: number) {
  return count === 1 ? "1 conversation not from this campaign's prospects" : `${count.toLocaleString("en-GB")} conversations not from this campaign's prospects`;
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
    const { linked, failed, left, reasons } = outcome.result;
    const parts = [`Added ${linked.toLocaleString("en-GB")} to Orbit.`];
    if (failed > 0) parts.push(`${failed.toLocaleString("en-GB")} couldn't be added: ${reasons.join(" ")}`);
    if (left > 0) parts.push(`${left.toLocaleString("en-GB")} left.`);
    setMessage({ text: parts.join(" "), error: false });
    router.refresh();
  }

  if (unlinked === 0 && !message) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      {unlinked > 0 && (
        <>
          <span className="ui-style text-soft">{unlinked === 1 ? "1 prospect isn't in Orbit." : `${unlinked.toLocaleString("en-GB")} prospects aren't in Orbit.`}</span>
          <Button variant="secondary" size="sm" disabled={pending} onClick={() => void run()}>
            {pending ? "Importing…" : "Import"}
          </Button>
        </>
      )}
      {message && (
        <span role={message.error ? "alert" : "status"} className={cn("caption-style", message.error ? "text-danger" : "text-subtle")}>
          {message.text}
        </span>
      )}
    </div>
  );
}

function PauseButton({ campaignId, paused, onError }: { campaignId: string; paused: boolean; onError: (error: string | null) => void }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function toggle() {
    const want = !paused;
    setPending(true);
    onError(null);
    const outcome = await setCampaignPausedAction(campaignId, want).catch(() => ({ error: want ? "Couldn't pause the campaign. Try again." : "Couldn't resume the campaign. Try again." }));
    setPending(false);
    if (outcome.error) {
      onError(outcome.error);
      return;
    }
    router.refresh();
  }

  return (
    <Button variant="secondary" size="sm" disabled={pending} onClick={() => void toggle()} className="hit">
      {pending ? (paused ? "Resuming…" : "Pausing…") : paused ? "Resume" : "Pause"}
    </Button>
  );
}

function StartButton({ campaignId, onError }: { campaignId: string; onError: (error: string | null) => void }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function start() {
    setPending(true);
    onError(null);
    const outcome = await startCampaignAction(campaignId).catch(() => ({ error: "Couldn't start the campaign. Try again." }));
    setPending(false);
    if (outcome.error) {
      onError(outcome.error);
      return;
    }
    router.refresh();
  }

  return (
    <Button variant="secondary" size="sm" disabled={pending} onClick={() => void start()} className="hit">
      {pending ? "Starting…" : "Start"}
    </Button>
  );
}

export default function CampaignScreen({
  viewer,
  campaign,
  prospects,
  filter,
  search,
  canImport,
  canAct,
  mailboxes,
  syncLine,
}: {
  viewer: Viewer;
  campaign: CampaignDetail;
  prospects: ProspectPage;
  filter: ProspectFilter;
  search: string;
  canImport: boolean;
  canAct: boolean;
  mailboxes: ReactNode;
  syncLine: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [draft, setDraft] = useState(search);
  const [pauseError, setPauseError] = useState<string | null>(null);
  const pausable = canAct && (campaign.status === "active" || campaign.status === "paused");
  const startable = canAct && campaign.status === "drafted";
  const linkedin = campaign.channel === "linkedin";
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

  const synced = Object.keys(campaign.stats).length > 0;
  const active = campaign.days.some((day) => day.sent > 0 || day.replied > 0 || (day.accepted ?? 0) > 0);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader
        title={campaign.name}
        viewer={viewer}
        heading={
          <span className="flex min-w-0 items-center gap-2">
            <Button variant="ghost" size="icon" href="/campaigns" data-shortcut="back" aria-label="Back to Campaigns" title="Back to Campaigns" className="text-subtle hit shrink-0">
              <ChevronLeftIcon aria-hidden className="size-3" />
            </Button>
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
          pausable || startable || campaign.url ? (
            <span className="flex items-center gap-2">
              {pausable && <PauseButton campaignId={campaign.id} paused={campaign.status === "paused"} onError={setPauseError} />}
              {startable && <StartButton campaignId={campaign.id} onError={setPauseError} />}
              {campaign.url && (
                <Button
                  variant="ghost"
                  size="icon"
                  href={campaign.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open in ${PROVIDER_NAMES[campaign.provider]}`}
                  title={`Open in ${PROVIDER_NAMES[campaign.provider]}`}
                  className="hit"
                >
                  <ExternalIcon aria-hidden className="size-3.5" />
                </Button>
              )}
            </span>
          ) : undefined
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-[60em] flex-col pb-20">
          <Section>
            {pauseError && (
              <p role="alert" className="caption-style text-danger">
                {pauseError}
              </p>
            )}
            {synced ? (
              <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_16rem] lg:gap-10">
                <div className="flex min-w-0 flex-col gap-5">
                  <Funnel campaign={campaign} />
                  {active && (
                    <div className="flex flex-col gap-2">
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
                      </div>
                    </div>
                  )}
                </div>
                <LeadStatuses campaign={campaign} />
              </div>
            ) : (
              <p className="ui-style text-subtle">Not synced yet</p>
            )}
            <p className="caption-style text-subtle">{syncLine}</p>
            {campaign.strayConversations > 0 && <p className="caption-style text-subtle">{strayLine(campaign.strayConversations)}</p>}
          </Section>

          <Section title="Steps">
            <Steps campaign={campaign} />
            {linkedin && campaign.capacity && (
              <p className="ui-style text-soft">{linkedinCapacityLine(campaign.capacity, campaign.sequence.filter((step) => step.subject !== "Invite").length)}</p>
            )}
          </Section>

          {campaign.briefs.length > 0 && (
            <Section title="Variables">
              <VariableBriefs key={campaign.briefs.map((item) => item.name).join("|")} campaignId={campaign.id} briefs={campaign.briefs} canEdit={canAct} />
            </Section>
          )}

          {mailboxes && <Section title="Sending">{mailboxes}</Section>}

          <Section
            title="Prospects"
            action={
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {!linkedin && (
                  <QuietTabs label="Show prospects" items={FILTER_TABS} value={filter} onChange={(value) => go({ show: value === "all" ? null : value, page: null })} />
                )}
                <form role="search" onSubmit={submitSearch} className="w-full sm:w-48">
                  <Input type="search" aria-label="Search prospects" placeholder="Search" value={draft} onChange={(event) => setDraft(event.target.value)} className="h-8" />
                </form>
              </div>
            }
          >
            {canImport && <AutoAddSetting key={campaign.autoAdd} campaignId={campaign.id} channel={campaign.channel} value={campaign.autoAdd} />}
            {canImport && <ImportLine campaignId={campaign.id} unlinked={campaign.unlinked} />}
            <ProspectsList prospects={prospects} linkedin={linkedin} campaignId={campaign.id} canImport={canImport} />
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
