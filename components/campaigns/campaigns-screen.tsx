"use client";

import { useState } from "react";
import Link from "next/link";
import FilterMenu from "@/components/_common/filter-menu";
import Tag from "@/components/_ui/tag";
import ChannelIcon from "@/components/campaigns/channel-icon";
import { QuietTabs } from "@/components/crm/contact-activities";
import SectionHeader from "@/components/crm/section-header";
import KeyboardList from "@/components/shortcuts/keyboard-list";
import type { Viewer } from "@/components/crm/viewer";
import { campaignRates, campaignView, number, STATUS_LABELS, type CampaignView } from "@/lib/campaigns/format";
import { PROVIDER_CHANNEL, type CampaignChannel, type CampaignProviderId, type CampaignSummary } from "@/lib/campaigns/types";
import { SETTINGS_PATHS } from "@/lib/settings-nav";
import { KEYBOARD_ROW_CLASS } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

const GRID_CLASS = "md:grid md:grid-cols-[minmax(0,1fr)_5.5rem_5.5rem_5.5rem_5.5rem] md:gap-4";

const VIEW_TABS: { id: CampaignView; label: string }[] = [
  { id: "live", label: "Live" },
  { id: "paused", label: "Paused" },
  { id: "archived", label: "Archived" },
];

const CHANNEL_OPTIONS = [
  { value: "all", label: "All" },
  { value: "email", label: "Email" },
  { value: "linkedin", label: "LinkedIn" },
];

function Empty() {
  return (
    <>
      <span aria-hidden>·</span>
      <span className="sr-only">None</span>
    </>
  );
}

function Figure({ value }: { value: string | null }) {
  return <span className="hidden text-right text-[14px] leading-5 tabular-nums md:block">{value ?? <Empty />}</span>;
}

export default function CampaignsScreen({
  viewer,
  campaigns,
  connected,
  canAdmin,
  syncLine,
}: {
  viewer: Viewer;
  campaigns: CampaignSummary[];
  connected: CampaignProviderId[];
  canAdmin: boolean;
  syncLine: string | null;
}) {
  const [view, setView] = useState<CampaignView>("live");
  const [channel, setChannel] = useState<"all" | CampaignChannel>("all");
  const bothChannels = new Set(connected.map((provider) => PROVIDER_CHANNEL[provider])).size > 1;
  const shown = campaigns.filter(
    (campaign) => campaignView(campaign.status) === view && (channel === "all" || campaign.channel === channel),
  );

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader title="Campaigns" viewer={viewer} />
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <QuietTabs label="Campaign status" items={VIEW_TABS} value={view} onChange={setView} />
        {bothChannels && (
          <FilterMenu
            label="Channel"
            value={channel}
            options={CHANNEL_OPTIONS}
            onChange={(value) => setChannel(value as "all" | CampaignChannel)}
            align="end"
          />
        )}
      </div>
      {syncLine && <p className="caption-style text-subtle px-4 pb-2">{syncLine}</p>}
      {shown.length === 0 ? (
        <div className="caption-style text-subtle flex flex-col gap-1 px-4 py-8">
          <p>No campaigns</p>
          {connected.length === 0 && canAdmin && (
            <p>
              Connect Smartlead or HeyReach in{" "}
              <Link href={`${SETTINGS_PATHS.tools}#smartlead`} className="text-foreground underline-offset-2 hover:underline">
                Settings › Tools
              </Link>
              .
            </p>
          )}
        </div>
      ) : (
        <KeyboardList sequence className="flex min-h-0 flex-1 flex-col">
        <ul className="min-h-0 flex-1 overflow-auto pb-20">
          <li className={cn("caption-style text-subtle border-border hidden border-b px-4 py-2", GRID_CLASS)}>
            <span>Name</span>
            <span className="text-right">Prospects</span>
            <span className="text-right">Replied</span>
            <span className="text-right">Positive</span>
            <span className="text-right">Bounced</span>
          </li>
          {shown.map((campaign) => {
            const rates = campaignRates(campaign);
            const href = `/campaigns/${campaign.id}`;
            const meta = [number(campaign.prospects), rates.replied ? `${rates.replied} replied` : null].filter(Boolean).join(" · ");
            return (
              <li
                key={campaign.id}
                data-list-row=""
                data-row-href={href}
                className={cn(
                  KEYBOARD_ROW_CLASS,
                  "border-border relative flex min-h-12 items-center gap-3 border-b px-4 py-2 transition-colors duration-150 hover:bg-white/3",
                  GRID_CLASS,
                )}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <ChannelIcon channel={campaign.channel} className="text-subtle size-3.5 shrink-0" />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <Link href={href} className="truncate text-[14px] leading-5 after:absolute after:inset-0">
                      {campaign.name || "Untitled campaign"}
                    </Link>
                    {meta && <span className="caption-style text-subtle truncate md:hidden">{meta}</span>}
                  </span>
                  {campaign.status !== "active" && campaign.status !== "paused" && (
                    <Tag tone="neutral" size="sm" className="caption-style">
                      {STATUS_LABELS[campaign.status]}
                    </Tag>
                  )}
                </span>
                <Figure value={number(campaign.prospects)} />
                <Figure value={rates.replied} />
                <Figure value={rates.positive} />
                <Figure value={rates.bounced} />
              </li>
            );
          })}
        </ul>
        </KeyboardList>
      )}
    </section>
  );
}
