"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import FilterMenu from "@/components/_common/filter-menu";
import FilterChip from "@/components/_ui/filter-chip";
import { Input } from "@/components/_ui/input";
import Tag from "@/components/_ui/tag";
import { Monogram } from "@/components/beautifui/record-marks";
import CampaignsHeading from "@/components/campaigns/campaigns-heading";
import ChannelIcon from "@/components/campaigns/channel-icon";
import ThreadScreen from "@/components/campaigns/thread-screen";
import SectionHeader from "@/components/crm/section-header";
import { useSyncSignal } from "@/components/crm/sync-signals";
import type { Viewer } from "@/components/crm/viewer";
import { When } from "@/components/mail/thread-reader";
import KeyboardList from "@/components/shortcuts/keyboard-list";
import type { Conversation, ConversationList } from "@/lib/campaigns/conversations";
import { categoryTone } from "@/lib/campaigns/format";
import { conversationsHref, type ConversationShow, type ConversationView } from "@/lib/campaigns/conversation-view";
import type { ProspectThread } from "@/lib/campaigns/threads";
import type { CampaignChannel } from "@/lib/campaigns/types";
import { KEYBOARD_ROW_CLASS } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { useCompaniesStore } from "@/stores/companies-store";

const SEARCH_SETTLE_MS = 300;

const CHIPS: { id: ConversationShow; label: string; channel?: CampaignChannel }[] = [
  { id: "needs_reply", label: "Needs reply" },
  { id: "all", label: "All" },
  { id: "linkedin", label: "LinkedIn", channel: "linkedin" },
  { id: "email", label: "Email", channel: "email" },
];

function Row({ conversation, href, selected }: { conversation: Conversation; href: string; selected: boolean }) {
  const last = conversation.lastMessage;
  const where = [conversation.campaigns[0]?.name, conversation.companyName].filter(Boolean).join(" · ");
  return (
    <li
      data-list-row=""
      data-row-href={href}
      className={cn(
        KEYBOARD_ROW_CLASS,
        "border-border relative flex gap-2.5 border-b px-4 py-3 transition-colors duration-150 hover:bg-white/3",
        selected && "bg-white/[0.07] hover:bg-white/[0.07]",
      )}
    >
      <Monogram name={conversation.name} className="mt-0.5 size-7 rounded-full text-[11px]" />
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <div className="flex min-w-0 items-center gap-1.5">
          {conversation.unread && <span aria-hidden className="bg-primary size-[7px] shrink-0 rounded-full" />}
          <Link href={href} aria-current={selected ? "page" : undefined} className="truncate text-[14px] leading-5 font-medium after:absolute after:inset-0">
            {conversation.unread && <span className="sr-only">Unread, </span>}
            {conversation.name}
          </Link>
          {conversation.category && (
            <Tag tone={categoryTone(conversation.category)} size="sm" className="caption-style h-5 shrink-0">
              {conversation.category}
            </Tag>
          )}
          {last && <When at={last.at} className="caption-style text-subtle ml-auto shrink-0 pl-1 tabular-nums" />}
        </div>
        <div className="caption-style text-subtle flex min-w-0 items-center gap-1.5">
          {conversation.channels.map((channel) => (
            <ChannelIcon key={channel} channel={channel} className="size-3.5 shrink-0" />
          ))}
          <span className="truncate">{where}</span>
        </div>
        {last && (
          <p className={cn("ui-style truncate", conversation.unread ? "text-foreground" : "text-soft")}>
            {last.direction === "outbound" && "You: "}
            {last.text}
          </p>
        )}
      </div>
    </li>
  );
}

function SearchField({ value, onSearch }: { value: string; onSearch: (value: string) => void }) {
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setText(value);
  }
  useEffect(() => {
    if (text.trim() === value) return;
    const timer = window.setTimeout(() => onSearch(text.trim()), SEARCH_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [text, value, onSearch]);
  return (
    <Input
      type="search"
      value={text}
      onChange={(event) => setText(event.target.value)}
      placeholder="Search"
      aria-label="Search conversations"
      className="h-8 rounded-full text-[13px]"
    />
  );
}

export default function ConversationsScreen({
  viewer,
  list,
  view,
  campaigns,
  thread,
  canAct,
}: {
  viewer: Viewer;
  list: ConversationList;
  view: ConversationView;
  campaigns: { id: string; name: string }[];
  thread: ProspectThread | null;
  canAct: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const setWaiting = useCompaniesStore((state) => state.setCampaignsWaiting);
  const openIds = new Set(thread?.campaigns.map((campaign) => campaign.prospectId) ?? []);

  useSyncSignal("campaigns", () => router.refresh());

  useEffect(() => {
    if (!view.campaignId && !view.search) setWaiting(list.needsReply);
  }, [list.needsReply, view.campaignId, view.search, setWaiting]);

  function show(next: Partial<ConversationView>) {
    startTransition(() => router.replace(conversationsHref({ ...view, ...next }, thread ? thread.prospectId : null), { scroll: false }));
  }

  const campaignOptions = [{ value: "all", label: "All campaigns" }, ...campaigns.map((campaign) => ({ value: campaign.id, label: campaign.name || "Untitled campaign" }))];
  const empty = view.show === "needs_reply" && !view.search ? "Nothing needs a reply" : "No conversations";

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className={cn("shrink-0", thread && "max-md:hidden")}>
        <SectionHeader
          title="Conversations"
          viewer={viewer}
          heading={<CampaignsHeading current="conversations" />}
          action={
            campaigns.length > 0 ? (
              <FilterMenu label="Campaign" value={view.campaignId ?? "all"} options={campaignOptions} onChange={(value) => show({ campaignId: value === "all" ? null : value })} align="end" className="max-w-[16em]" />
            ) : null
          }
        />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className={cn("border-border flex min-h-0 w-full min-w-0 flex-col md:w-[21.25rem] md:shrink-0 md:border-r", thread && "max-md:hidden")}>
          <div className="border-border flex shrink-0 flex-col gap-2 border-b px-3 py-2.5">
            <div role="group" aria-label="Show" className="-mx-1 flex min-w-0 items-center gap-0.5 overflow-x-auto px-1 [scrollbar-width:none]">
              {CHIPS.map((chip) => {
                const active = view.show === chip.id;
                return (
                  <FilterChip
                    key={chip.id}
                    active={active}
                    aria-pressed={active}
                    count={chip.id === "needs_reply" ? list.needsReply : 0}
                    icon={chip.channel ? <ChannelIcon channel={chip.channel} className="size-3.5 shrink-0" /> : undefined}
                    onClick={() => show({ show: chip.id })}
                    className="shrink-0"
                  >
                    {chip.label}
                  </FilterChip>
                );
              })}
            </div>
            <SearchField value={view.search} onSearch={(search) => show({ search })} />
          </div>
          {list.conversations.length === 0 ? (
            <p role="status" className="caption-style text-subtle px-4 py-8">
              {empty}
            </p>
          ) : (
            <KeyboardList className={cn("flex min-h-0 flex-1 flex-col transition-opacity duration-150", pending && "opacity-60")}>
              <ul aria-label="Conversations" className="min-h-0 flex-1 overflow-auto pb-20">
                {list.conversations.map((conversation) => (
                  <Row
                    key={conversation.prospectId}
                    conversation={conversation}
                    href={conversationsHref(view, conversation.prospectId)}
                    selected={openIds.has(conversation.prospectId)}
                  />
                ))}
                {list.more && <li className="caption-style text-subtle px-4 py-3">Showing the latest {list.conversations.length.toLocaleString("en-GB")}. Search to find others.</li>}
              </ul>
            </KeyboardList>
          )}
        </div>
        <div className={cn("min-w-0 flex-1 flex-col", thread ? "flex" : "hidden md:flex")}>
          {thread ? (
            <ThreadScreen key={thread.prospectId} viewer={viewer} thread={thread} canAct={canAct} pane={{ back: conversationsHref(view, null) }} />
          ) : (
            <p className="caption-style text-subtle m-auto">Pick a conversation</p>
          )}
        </div>
      </div>
    </section>
  );
}
