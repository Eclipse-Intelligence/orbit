"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Button from "@/components/_ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/_ui/dropdown-menu";
import { Monogram, tagBase } from "@/components/beautifui/record-marks";
import SectionHeader from "@/components/crm/section-header";
import ThreadList from "@/components/mail/thread-list";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import ChevronLeftIcon from "@/public/assets/images/_common/chevron-left.svg";
import CalendarIcon from "@/public/assets/images/_common/calendar.svg";
import PlusIcon from "@/public/assets/images/_common/plus.svg";
import SearchIcon from "@/public/assets/images/_common/search.svg";
import ArchiveIcon from "@/public/assets/images/mail/archive.svg";
import ClockIcon from "@/public/assets/images/mail/clock.svg";
import ComposeIcon from "@/public/assets/images/mail/compose.svg";
import FlagIcon from "@/public/assets/images/mail/flag.svg";
import FolderIcon from "@/public/assets/images/mail/folder.svg";
import ForwardIcon from "@/public/assets/images/mail/forward.svg";
import InboxIcon from "@/public/assets/images/mail/inbox.svg";
import MailOpenIcon from "@/public/assets/images/mail/mail-open.svg";
import RefreshIcon from "@/public/assets/images/mail/refresh.svg";
import ReplyAllIcon from "@/public/assets/images/mail/reply-all.svg";
import ReplyIcon from "@/public/assets/images/mail/reply.svg";
import TrashIcon from "@/public/assets/images/mail/trash.svg";
import { ECLIPSE_INBOX, MOCK_NOW, RIDGEON_INBOX, THREADS, VIEWER, WORKSPACES, type MockWorkspace, type WorkspaceId } from "./mock-data";
import { WorkspaceTile } from "./mock-shell";

type Person = {
  name: string;
  email: string;
  line: string;
  deal?: string;
  knownIn: WorkspaceId[];
};

type Detail = {
  key: string;
  account: string;
  subject: string;
  filedIn: WorkspaceId[];
  people: Person[];
  earlier: { from: string; snippet: string; at: string };
  latest: { from: string; address: string; at: string; to: string; body: string[] };
};

const DETAILS: Record<string, Detail> = {
  halden: {
    key: "halden",
    account: RIDGEON_INBOX,
    subject: "Retainer for Q1",
    filedIn: ["ridgeon"],
    people: [
      {
        name: "Sophie Turner",
        email: "sophie@haldengroup.co.uk",
        line: "Head of Marketing at Halden Group",
        deal: "Q1 retainer (Proposal)",
        knownIn: ["ridgeon"],
      },
    ],
    earlier: { from: "You", snippet: "Attached is the positioning summary we walked through on Thursday, with the three messages the board picked.", at: "Fri, 31 Oct 2026, 16:05" },
    latest: {
      from: "Sophie Turner",
      address: "sophie@haldengroup.co.uk",
      at: "Wed, 5 Nov 2026, 09:42",
      to: "To me",
      body: [
        "Hi Mark,",
        "Thanks for Thursday. The board liked the positioning work, and Ian wants the sales team using the new messages before the January kick-off.",
        "Can we talk about carrying the retainer into Q1? Same two days a month would suit us, plus a session with the sales leads in early January.",
        "Sophie",
      ],
    },
  },
  northwind: {
    key: "northwind",
    account: ECLIPSE_INBOX,
    subject: "Re: AI visibility pilot",
    filedIn: ["eclipse"],
    people: [
      { name: "James Patel", email: "james@northwindlabs.com", line: "CMO at Northwind Labs", knownIn: ["eclipse"] },
      { name: "Maya Chen", email: "maya@northwindlabs.com", line: "maya@northwindlabs.com", knownIn: [] },
    ],
    earlier: { from: "You", snippet: "Here's where Northwind shows up across the ten assistants this week, and the three prompts you're missing from.", at: "Mon, 3 Nov 2026, 11:20" },
    latest: {
      from: "James Patel",
      address: "james@northwindlabs.com",
      at: "Wed, 5 Nov 2026, 08:55",
      to: "To me · Cc Maya Chen",
      body: [
        "Mark,",
        "Looping in Maya, who runs content for us. Could you send her last week's GEO report and the list of prompts?",
        "Separately, I'd like your view on our positioning for the 2027 plan. Happy to make that its own piece of work.",
        "James",
      ],
    },
  },
  fernley: {
    key: "fernley",
    account: RIDGEON_INBOX,
    subject: "Intro: Mark and Tom at Fernley",
    filedIn: ["eclipse"],
    people: [{ name: "Nina Alvarez", email: "nina@fernleycapital.com", line: "nina@fernleycapital.com", knownIn: [] }],
    earlier: { from: "Nina Alvarez", snippet: "Mark, meet Tom.", at: "Wed, 5 Nov 2026, 07:31" },
    latest: {
      from: "Nina Alvarez",
      address: "nina@fernleycapital.com",
      at: "Wed, 5 Nov 2026, 07:31",
      to: "To me · Cc Tom Reid",
      body: [
        "Mark, meet Tom. Tom is building out marketing across our portfolio, and I think you two should talk about positioning work for two of the newer companies.",
        "Tom, Mark helped us rethink how we talk about Fernley last spring. I'll leave you both to it.",
        "Nina",
      ],
    },
  },
};

const SPLIT_TABS = [
  { label: "Important", unread: 4, active: true },
  { label: "Other", unread: 0, active: false },
  { label: "News", unread: 2, active: false },
];

function noop() {}

function MailList({ cursor }: { cursor: string | null }) {
  return (
    <>
      <div className="flex shrink-0 flex-col gap-2 px-3 pt-2 pb-1.5 lg:pt-3">
        <div className="lg:hidden">
          <SearchBox place="list" />
        </div>
        <nav aria-label="Mail folders" className="-mx-1 flex items-center gap-0.5 overflow-x-auto px-1 pr-6 [scrollbar-width:none]">
          {SPLIT_TABS.map((tab) => (
            <button
              key={tab.label}
              type="button"
              aria-current={tab.active ? "page" : undefined}
              className={cn(
                "ease-power3-out flex h-8 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2.5 text-[13px] transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                tab.active ? "text-foreground bg-white/[0.07]" : "text-subtle hover:text-foreground hover:bg-white/[0.035]",
              )}
            >
              {tab.label}
              {tab.unread > 0 && <span className={cn("tabular-nums", tab.label === "Important" ? "text-primary-foreground" : "text-soft")}>{tab.unread}</span>}
            </button>
          ))}
          <button
            type="button"
            className="text-subtle hover:text-foreground ease-power3-out flex h-8 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2.5 text-[13px] transition-colors duration-150 outline-none hover:bg-white/[0.035]"
          >
            <FolderIcon aria-hidden className="size-3.5 shrink-0" />
            More
            <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
          </button>
        </nav>
      </div>
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <ThreadList
          threads={THREADS}
          cursor={cursor}
          outgoing={false}
          showAccount
          own={[RIDGEON_INBOX, ECLIPSE_INBOX]}
          now={MOCK_NOW}
          loading={false}
          more={false}
          empty=""
          onOpen={noop}
          onHover={noop}
          onMore={noop}
          swipe={null}
          selected={new Set()}
          onToggle={noop}
        />
      </div>
    </>
  );
}

function SearchBox({ place }: { place: "header" | "list" }) {
  return (
    <form role="search" className={cn("relative", place === "header" && "w-full max-w-[26rem]")}>
      <label htmlFor={`mock-search-${place}`} className="sr-only">
        Search mail
      </label>
      <SearchIcon aria-hidden className="text-subtle pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2" />
      <input
        id={`mock-search-${place}`}
        type="search"
        placeholder="Search, or ask a question"
        autoComplete="off"
        className={cn(
          "placeholder:text-subtle text-foreground w-full rounded-xl bg-white/[0.04] pr-24 pl-9 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
          place === "header" ? "h-8" : "h-9",
        )}
      />
    </form>
  );
}

function FiledMenu({ detail, open }: { detail: Detail; open: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => setMenuOpen(true), 500);
    return () => window.clearTimeout(timer);
  }, [open]);
  const filed = detail.filedIn.map((id) => WORKSPACES[id]);
  const domain = detail.latest.address.split("@")[1];
  const label = filed.map((item) => item.name).join(" and ");
  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Filed in ${label}. Change where this email is filed`}
          title="Change where this email is filed"
          className="data-[state=open]:bg-white/6 data-[state=open]:text-foreground -mr-1.5 min-w-0 gap-1.5 text-[13px] font-normal"
        >
          {filed.map((item) => (
            <WorkspaceTile key={item.id} workspace={item} className="size-4 rounded-[5px] text-[9px]" />
          ))}
          <span className="truncate">Filed in {label}</span>
          <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[16rem]">
        <DropdownMenuLabel>File this email in</DropdownMenuLabel>
        {Object.values(WORKSPACES).map((item) => (
          <DropdownMenuItem key={item.id} className="max-sm:py-2.5">
            <WorkspaceTile workspace={item} className="size-4 rounded-[5px] text-[9px]" />
            <span className="flex-1">{item.name}</span>
            {detail.filedIn.length === 1 && detail.filedIn[0] === item.id && <span className="text-subtle">Now</span>}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem className="max-sm:py-2.5">
          <span aria-hidden className="flex">
            <WorkspaceTile workspace={WORKSPACES.eclipse} className="size-4 rounded-[5px] text-[9px]" />
            <WorkspaceTile workspace={WORKSPACES.ridgeon} className="ring-popover -ml-1 size-4 rounded-[5px] text-[9px] ring-2" />
          </span>
          <span className="flex-1">Both</span>
        </DropdownMenuItem>
        <DropdownMenuLabel>Everyone at @{domain}</DropdownMenuLabel>
        {Object.values(WORKSPACES).map((item) => (
          <DropdownMenuItem key={`domain-${item.id}`} className="max-sm:py-2.5">
            <WorkspaceTile workspace={item} className="size-4 rounded-[5px] text-[9px]" />
            {item.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PersonChip({ person, workspace }: { person: Person; workspace: MockWorkspace }) {
  const knownHere = person.knownIn.includes(workspace.id);
  const elsewhere = !knownHere ? person.knownIn.map((id) => WORKSPACES[id]) : [];
  return (
    <li className="flex max-w-full min-w-0 items-center gap-2 rounded-xl bg-white/[0.035] py-1.5 pr-1.5 pl-3 text-[13px] leading-5">
      <span className="flex min-w-0 flex-col">
        {knownHere ? (
          <Link href="#contact" className="text-foreground truncate font-medium hover:underline hover:decoration-white/40 hover:underline-offset-2">
            {person.name}
          </Link>
        ) : (
          <span className="text-foreground truncate font-medium" title={person.email}>
            {person.name}
          </span>
        )}
        <span className="text-subtle truncate text-[12px]">
          {person.line}
          {person.deal && (
            <>
              {" · "}
              <Link href="#deal" className="hover:text-foreground hover:underline">
                {person.deal}
              </Link>
            </>
          )}
        </span>
      </span>
      {elsewhere.map((item) => (
        <span
          key={item.id}
          title={`${person.name} is a contact in ${item.name}`}
          className="text-soft flex h-[22px] shrink-0 items-center gap-1.5 rounded-full bg-white/[0.05] pr-2 pl-[3px] text-[12px] leading-none"
        >
          <WorkspaceTile workspace={item} className="size-4 rounded-full text-[9px]" />
          In {item.name}
        </span>
      ))}
      {!knownHere && (
        <Button
          variant="secondary"
          size="sm"
          aria-label={elsewhere.length ? `Add ${person.name} to ${workspace.name}` : `Add ${person.name} as a contact`}
          title={elsewhere.length ? `Add to ${workspace.name}` : "Add contact"}
          className="shrink-0 max-sm:size-8 max-sm:p-0"
        >
          <PlusIcon aria-hidden className="size-3.5 sm:hidden" />
          <span className="max-sm:hidden">{elsewhere.length ? `Add to ${workspace.name}` : "Add contact"}</span>
        </Button>
      )}
    </li>
  );
}

function Reader({ detail, workspace, filedOpen }: { detail: Detail; workspace: MockWorkspace; filedOpen: boolean }) {
  const toolbar = [
    { label: "Archive", icon: ArchiveIcon },
    { label: "Remind me", icon: ClockIcon },
    { label: "Move to Trash", icon: TrashIcon },
    { label: "Mark unread", icon: MailOpenIcon },
    { label: "Flag", icon: FlagIcon },
    { label: "Send an invite from this email", icon: CalendarIcon },
  ];
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-3 py-2 sm:px-5">
        <Button variant="ghost" size="icon" aria-label="Back to the list" className="md:hidden">
          <ChevronLeftIcon aria-hidden className="size-3.5" />
        </Button>
        {toolbar.map((tool) => (
          <Button key={tool.label} variant="ghost" size="icon" aria-label={tool.label} title={tool.label} className={cn(tool.label === "Flag" && "max-sm:hidden")}>
            <tool.icon aria-hidden className="size-3.5" />
          </Button>
        ))}
        <span className="ml-auto flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="sm" aria-label="Split: Important. Change where this sender goes">
            Important
            <ChevronDownIcon aria-hidden className="size-3" />
          </Button>
          <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: tagBase(detail.account) }} />
          <span className="caption-style text-subtle truncate max-sm:sr-only">{detail.account}</span>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[52em] flex-col gap-4 px-3 pt-3 pb-32 sm:px-6">
          <h2 className="px-4 text-pretty">{detail.subject}</h2>
          <section aria-label="People on this conversation" className="flex flex-col gap-2 px-4">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <button
                type="button"
                aria-expanded
                className="text-subtle hover:text-foreground focus-visible:ring-ring/60 -ml-1.5 flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] leading-5 transition-colors duration-150 outline-none focus-visible:ring-2"
              >
                Contacts
                <span className="tabular-nums">{detail.people.length}</span>
                <ChevronDownIcon aria-hidden className="size-3 rotate-180" />
              </button>
              <FiledMenu detail={detail} open={filedOpen} />
            </div>
            <ul className="flex flex-wrap gap-2">
              {detail.people.map((person) => (
                <PersonChip key={person.email} person={person} workspace={workspace} />
              ))}
            </ul>
          </section>
          <div className="flex flex-col gap-1.5">
            <article className="ease-power3-out rounded-2xl transition-colors duration-150 hover:bg-white/[0.025]">
              <div className="flex items-start gap-3 px-4 py-3">
                <Monogram name={detail.earlier.from} className="mt-0.5 size-7 rounded-full text-[11px]" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="text-foreground truncate text-[14px]">{detail.earlier.from}</span>
                    <span className="text-subtle ml-auto shrink-0 text-[12px] tabular-nums">{detail.earlier.at}</span>
                  </span>
                  <span className="text-subtle truncate text-[13px]">{detail.earlier.snippet}</span>
                </span>
              </div>
            </article>
            <article className="rounded-2xl bg-white/[0.025]">
              <div className="flex items-start gap-3 px-4 py-3">
                <Monogram name={detail.latest.from} className="mt-0.5 size-7 rounded-full text-[11px]" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="text-foreground truncate text-[14px] font-medium">{detail.latest.from}</span>
                    <span className="text-subtle hidden min-w-0 truncate text-[12px] sm:inline">{detail.latest.address}</span>
                    <span className="text-subtle ml-auto shrink-0 text-[12px] tabular-nums">{detail.latest.at}</span>
                  </span>
                  <span className="text-subtle flex min-w-0 items-center gap-1 text-[12px]">
                    <span className="truncate">{detail.latest.to}</span>
                    <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
                  </span>
                </span>
              </div>
              <div className="flex flex-col gap-3 px-4 pb-4 sm:pl-14">
                {detail.latest.body.map((paragraph) => (
                  <p key={paragraph} className="text-foreground">
                    {paragraph}
                  </p>
                ))}
              </div>
            </article>
          </div>
          <div className="flex flex-wrap items-center gap-2 px-4">
            <Button variant="secondary">
              <ReplyIcon aria-hidden className="size-3.5" />
              Reply
            </Button>
            <Button variant="secondary">
              <ReplyAllIcon aria-hidden className="size-3.5" />
              Reply all
            </Button>
            <Button variant="secondary">
              <ForwardIcon aria-hidden className="size-3.5" />
              Forward
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function MailMock({
  workspace,
  thread,
  phoneView,
  filedOpen = false,
}: {
  workspace: MockWorkspace;
  thread: keyof typeof DETAILS;
  phoneView: "list" | "thread";
  filedOpen?: boolean;
}) {
  const detail = DETAILS[thread];
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader
        title="Mail"
        viewer={VIEWER}
        heading={
          <div className="flex min-w-0 items-center gap-5">
            <h1 className="shrink-0">Mail</h1>
            <div className="hidden min-w-0 flex-1 lg:flex">
              <SearchBox place="header" />
            </div>
          </div>
        }
        action={
          <>
            <Button variant="primary" aria-label="Compose" shortcut={["C", "M"]} className="max-sm:size-[30px] max-sm:p-0">
              <ComposeIcon aria-hidden className="size-3.5 sm:hidden" />
              <span className="max-sm:sr-only">Compose</span>
            </Button>
            <Button variant="secondary" aria-label="Account: All accounts" className="max-w-[16em]">
              <InboxIcon aria-hidden className="size-3.5 shrink-0 sm:hidden" />
              <span className="truncate max-sm:sr-only">All accounts</span>
              <ChevronDownIcon aria-hidden className="text-subtle size-3" />
            </Button>
            <Button variant="secondary" size="icon" aria-label="Check for new mail">
              <RefreshIcon aria-hidden className="size-3.5" />
            </Button>
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className={cn("min-h-0 w-full flex-col md:flex md:w-[20rem] md:shrink-0 lg:w-[25rem] xl:w-[29rem]", phoneView === "thread" ? "hidden" : "flex")}>
          <MailList cursor={detail.key} />
        </div>
        <div
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:my-2 md:mr-2 md:flex md:rounded-2xl md:bg-white/[0.02]",
            phoneView === "thread" ? "flex" : "hidden",
          )}
        >
          <Reader detail={detail} workspace={workspace} filedOpen={filedOpen} />
        </div>
      </div>
    </section>
  );
}
