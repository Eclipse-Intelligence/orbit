"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { PagePerson, ThreadMessage } from "./mock-data";

function Bar({ className }: { className?: string }) {
  return <span aria-hidden className={cn("block h-2.5 rounded-full bg-[#dcdcd8]", className)} />;
}

function PageLabel({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-6 items-center rounded-md border border-dashed border-[#9a9a95] bg-[#f7f7f5] px-2 text-[11px] leading-none font-medium tracking-[1px] text-[#55554f] uppercase">
      {children}
    </span>
  );
}

function SiteNav({ label, dark }: { label: string; dark?: boolean }) {
  return (
    <div className={cn("flex h-[52px] shrink-0 items-center gap-4 border-b px-8", dark ? "border-[#3a3a38] bg-[#4a4a47]" : "border-[#dcdcd8] bg-white")}>
      <span aria-hidden className={cn("size-8 rounded-md", dark ? "bg-[#6b6b67]" : "bg-[#bdbdb8]")} />
      <span aria-hidden className={cn("h-8 w-[16em] rounded-md", dark ? "bg-[#5c5c58]" : "bg-[#efefec]")} />
      <PageLabel>{label}</PageLabel>
      <span className="ml-auto flex items-center gap-6">
        {["Home", "Network", "Jobs", "Messaging", "Me"].map((item) => (
          <span key={item} className="flex flex-col items-center gap-1">
            <span aria-hidden className={cn("size-5 rounded-[5px]", dark ? "bg-[#6b6b67]" : "bg-[#c9c9c4]")} />
            <span className={cn("text-[11px] leading-none", dark ? "text-[#d6d6d2]" : "text-[#6b6b66]")}>{item}</span>
          </span>
        ))}
      </span>
    </div>
  );
}

function PageCard({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn("rounded-lg border border-[#dcdcd8] bg-white", className)}>{children}</section>;
}

function GreyButton({ children, filled }: { children: ReactNode; filled?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-8 items-center rounded-full px-4 text-[14px] leading-none font-semibold",
        filled ? "bg-[#4d4d49] text-white" : "border border-[#6b6b66] text-[#3d3d39]",
      )}
    >
      {children}
    </span>
  );
}

function SideRail() {
  return (
    <aside aria-hidden className="flex w-[300px] shrink-0 flex-col gap-3">
      <PageCard className="flex flex-col gap-4 p-4">
        <span className="text-[15px] font-semibold text-[#2b2b28]">People also viewed</span>
        {[0, 1, 2, 3].map((item) => (
          <span key={item} className="flex items-center gap-3">
            <span className="size-11 rounded-full bg-[#dcdcd8]" />
            <span className="flex flex-1 flex-col gap-2">
              <Bar className="w-2/3" />
              <Bar className="w-full bg-[#ebebe8]" />
            </span>
          </span>
        ))}
      </PageCard>
    </aside>
  );
}

function PageShell({ label, children, dark }: { label: string; children: ReactNode; dark?: boolean }) {
  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden bg-[#ececea] font-sans text-[#1f1f1d]">
      <SiteNav label={label} dark={dark} />
      <div className="flex min-h-0 flex-1 justify-center gap-5 overflow-hidden px-8 pt-5">{children}</div>
    </div>
  );
}

export function ProfilePage({ person }: { person: PagePerson }) {
  return (
    <PageShell label="Profile page">
      <div className="flex w-[640px] shrink-0 flex-col gap-3">
        <PageCard className="overflow-hidden">
          <div aria-hidden className="h-[120px] bg-gradient-to-r from-[#c9c9c4] to-[#deded9]" />
          <div className="relative flex flex-col gap-1 px-6 pt-14 pb-5">
            <span className="absolute -top-16 left-6 flex size-[120px] items-center justify-center rounded-full border-4 border-white bg-[#a9a9a4] text-[34px] font-semibold text-white">
              {person.initials}
            </span>
            <div className="flex items-start justify-between gap-6">
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="text-[24px] leading-tight font-semibold">{person.name}</span>
                <span className="text-[15px] leading-snug text-[#2f2f2c]">{person.headline}</span>
                <span className="text-[13px] text-[#6b6b66]">
                  {person.location} · <span className="font-semibold text-[#4d4d49]">Contact info</span>
                </span>
                <span className="text-[13px] font-semibold text-[#4d4d49]">500+ connections</span>
              </div>
              <span className="flex shrink-0 items-center gap-2 pt-1 text-[13px] font-semibold text-[#2f2f2c]">
                <span aria-hidden className="size-8 rounded-[4px] bg-[#cfcfca]" />
                {person.company}
              </span>
            </div>
            <span className="mt-3 flex gap-2">
              <GreyButton filled>Message</GreyButton>
              <GreyButton>More</GreyButton>
            </span>
          </div>
        </PageCard>
        <PageCard className="flex flex-col gap-2 p-6">
          <span className="text-[18px] font-semibold">About</span>
          <p className="text-[14px] leading-[1.5] text-[#2f2f2c]">{person.about}</p>
        </PageCard>
        <PageCard className="flex flex-col gap-4 p-6">
          <span className="text-[18px] font-semibold">Experience</span>
          <div className="flex gap-3">
            <span aria-hidden className="size-12 shrink-0 rounded-[4px] bg-[#cfcfca]" />
            <span className="flex flex-col gap-0.5">
              <span className="text-[15px] font-semibold">{person.role}</span>
              <span className="text-[14px] text-[#2f2f2c]">{person.company} · Full time</span>
              <span className="text-[13px] text-[#6b6b66]">{person.roleSince}</span>
            </span>
          </div>
          <div aria-hidden className="flex gap-3 opacity-70">
            <span className="size-12 shrink-0 rounded-[4px] bg-[#e0e0dc]" />
            <span className="flex flex-1 flex-col gap-2 pt-1">
              <Bar className="w-1/3" />
              <Bar className="w-1/2 bg-[#ebebe8]" />
            </span>
          </div>
        </PageCard>
      </div>
      <SideRail />
    </PageShell>
  );
}

export function SalesNavPage({ person }: { person: PagePerson }) {
  return (
    <PageShell label="Sales Navigator lead page" dark>
      <div className="flex w-[980px] shrink-0 gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <PageCard className="flex flex-col gap-4 p-6">
            <div className="flex items-start gap-5">
              <span className="flex size-[88px] shrink-0 items-center justify-center rounded-full bg-[#a9a9a4] text-[26px] font-semibold text-white">{person.initials}</span>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="text-[22px] leading-tight font-semibold">{person.name}</span>
                <span className="text-[15px] text-[#2f2f2c]">
                  {person.role} at {person.company}
                </span>
                <span className="text-[13px] text-[#6b6b66]">{person.location} · 2nd</span>
              </div>
              <span className="flex shrink-0 gap-2">
                <GreyButton>Save to list</GreyButton>
                <GreyButton filled>Message</GreyButton>
              </span>
            </div>
          </PageCard>
          <PageCard className="flex flex-col gap-3 p-6">
            <span className="text-[16px] font-semibold">Current role</span>
            <div className="flex gap-3">
              <span aria-hidden className="size-12 shrink-0 rounded-[4px] bg-[#cfcfca]" />
              <span className="flex flex-col gap-0.5">
                <span className="text-[15px] font-semibold">{person.role}</span>
                <span className="text-[14px] text-[#2f2f2c]">{person.company}</span>
                <span className="text-[13px] text-[#6b6b66]">{person.roleSince}</span>
              </span>
            </div>
          </PageCard>
          <PageCard className="flex flex-col gap-3 p-6">
            <span className="text-[16px] font-semibold">Recent activity</span>
            <Bar className="w-3/4" />
            <Bar className="w-2/3 bg-[#ebebe8]" />
            <Bar className="w-1/2 bg-[#ebebe8]" />
          </PageCard>
        </div>
        <aside aria-hidden className="flex w-[280px] shrink-0 flex-col gap-3">
          <PageCard className="flex flex-col gap-3 p-4">
            <span className="text-[15px] font-semibold">Lead lists</span>
            <span className="text-[13px] text-[#6b6b66]">Q4 agencies · Leeds PR</span>
          </PageCard>
          <PageCard className="flex flex-col gap-3 p-4">
            <span className="text-[15px] font-semibold">Notes</span>
            <Bar className="w-full bg-[#ebebe8]" />
            <Bar className="w-2/3 bg-[#ebebe8]" />
          </PageCard>
        </aside>
      </div>
    </PageShell>
  );
}

export function MessagingPage({ person, messages }: { person: PagePerson; messages: ThreadMessage[] }) {
  return (
    <PageShell label="Messaging page">
      <PageCard className="mb-5 flex w-[980px] shrink-0 overflow-hidden">
        <div className="flex w-[300px] shrink-0 flex-col border-r border-[#dcdcd8]">
          <div className="border-b border-[#dcdcd8] px-4 py-3 text-[15px] font-semibold">Messaging</div>
          {[{ name: person.name, line: messages.at(-1)?.text ?? "", active: true }, { name: "James Patel", line: "Thanks, speak next week." }, { name: "Laura Kim", line: "Sounds good to me." }, { name: "Owen Price", line: "Sent you the deck." }].map((item) => (
            <div key={item.name} className={cn("flex gap-3 border-b border-[#ebebe8] px-4 py-3", item.active && "bg-[#f1f1ee] shadow-[inset_3px_0_0_#4d4d49]")}>
              <span aria-hidden className="size-11 shrink-0 rounded-full bg-[#c9c9c4]" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[14px] font-semibold">{item.name}</span>
                <span className="truncate text-[13px] text-[#6b6b66]">{item.line}</span>
              </span>
            </div>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-3 border-b border-[#dcdcd8] px-5 py-3">
            <span className="text-[15px] font-semibold">{person.name}</span>
            <span className="text-[13px] text-[#6b6b66]">{person.headline}</span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-5 py-4">
            <span aria-hidden className="mx-auto h-2.5 w-24 rounded-full bg-[#e2e2de]" />
            {messages.map((message) => (
              <div key={message.id} className="flex gap-3">
                <span aria-hidden className="size-9 shrink-0 rounded-full bg-[#c9c9c4]" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[14px]">
                    <span className="font-semibold">{message.mine ? "Mark Ridgeon" : message.from}</span>
                    <span className="ml-2 text-[12px] text-[#6b6b66]">{message.when}</span>
                  </span>
                  <span className="text-[14px] leading-[1.45] text-[#2f2f2c]">{message.text}</span>
                </span>
              </div>
            ))}
          </div>
          <div className="border-t border-[#dcdcd8] p-4">
            <span className="flex h-16 items-start rounded-md bg-[#f1f1ee] p-3 text-[14px] text-[#8a8a85]">Write a message…</span>
          </div>
        </div>
      </PageCard>
    </PageShell>
  );
}

export type PageCompany = { name: string; initials: string; tagline: string; industry: string; size: string; location: string; website: string; founded: string };

export function CompanyPage({ company }: { company: PageCompany }) {
  return (
    <PageShell label="Company page">
      <div className="flex w-[640px] shrink-0 flex-col gap-3">
        <PageCard className="overflow-hidden">
          <div aria-hidden className="h-[110px] bg-gradient-to-r from-[#c9c9c4] to-[#deded9]" />
          <div className="relative flex flex-col gap-1.5 px-6 pt-12 pb-5">
            <span className="absolute -top-12 left-6 flex size-[96px] items-center justify-center rounded-lg border-4 border-white bg-[#8f8f8a] text-[34px] font-semibold text-white">
              {company.initials}
            </span>
            <span className="text-[24px] leading-tight font-semibold">{company.name}</span>
            <span className="text-[15px] text-[#2f2f2c]">{company.tagline}</span>
            <span className="text-[13px] text-[#6b6b66]">
              {company.industry} · {company.location} · 1,204 followers · {company.size}
            </span>
            <span className="mt-3 flex gap-2">
              <GreyButton filled>Follow</GreyButton>
              <GreyButton>Visit website</GreyButton>
            </span>
          </div>
          <div className="flex gap-6 border-t border-[#dcdcd8] px-6 text-[14px] font-semibold text-[#6b6b66]">
            {["Home", "About", "Posts", "Jobs", "People"].map((tab) => (
              <span key={tab} className={cn("py-3", tab === "About" && "text-[#2b2b28] shadow-[inset_0_-2px_0_#4d4d49]")}>
                {tab}
              </span>
            ))}
          </div>
        </PageCard>
        <PageCard className="flex flex-col gap-4 p-6">
          <span className="text-[18px] font-semibold">Overview</span>
          <dl className="grid grid-cols-[9em_1fr] gap-y-3 text-[14px]">
            <dt className="font-semibold">Website</dt>
            <dd className="font-semibold text-[#3d3d39] underline">{company.website}</dd>
            <dt className="font-semibold">Industry</dt>
            <dd>{company.industry}</dd>
            <dt className="font-semibold">Company size</dt>
            <dd>{company.size}</dd>
            <dt className="font-semibold">Headquarters</dt>
            <dd>{company.location}, England</dd>
            <dt className="font-semibold">Founded</dt>
            <dd>{company.founded}</dd>
          </dl>
        </PageCard>
      </div>
      <SideRail />
    </PageShell>
  );
}
