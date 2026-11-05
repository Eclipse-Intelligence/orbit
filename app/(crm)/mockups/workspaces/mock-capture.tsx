"use client";

import Button from "@/components/_ui/button";
import { Monogram, tagBase } from "@/components/beautifui/record-marks";
import SectionHeader from "@/components/crm/section-header";
import { KEYBOARD_ROW_CLASS } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { ECLIPSE_INBOX, RIDGEON_INBOX, VIEWER, WORKSPACES, type MockWorkspace } from "./mock-data";
import { WorkspaceTile } from "./mock-shell";

type UnknownEmail = {
  id: string;
  name: string;
  email: string;
  account: string;
  when: string;
  subject: string;
  snippet: string;
};

const EMAILS: UnknownEmail[] = [
  {
    id: "fernley",
    name: "Nina Alvarez",
    email: "nina@fernleycapital.com",
    account: RIDGEON_INBOX,
    when: "Today 07:31",
    subject: "Intro: Mark and Tom at Fernley",
    snippet: "Mark, meet Tom. Tom is building out marketing across our portfolio, and I think you two should talk about positioning work for two of the newer companies.",
  },
  {
    id: "lumen",
    name: "Daniel Brooks",
    email: "daniel@lumenagency.co.uk",
    account: ECLIPSE_INBOX,
    when: "Yesterday 11:48",
    subject: "Pricing for agencies",
    snippet: "We run content for 14 B2B clients and want to add AI visibility reporting. What does Eclipse cost for a team like ours?",
  },
];

const MET = [
  { name: "Grace Okafor", line: "grace@meridianhealth.co.uk · 2 meetings" },
  { name: "Sam Whitfield", line: "sam@parcelpoint.com · 1 meeting" },
];

function EmailCard({ email, workspace }: { email: UnknownEmail; workspace: MockWorkspace }) {
  const others = Object.values(WORKSPACES).filter((item) => item.id !== workspace.id);
  return (
    <li data-list-row="" className={cn(KEYBOARD_ROW_CLASS, "bg-card border-line-strong flex flex-col gap-3 rounded-2xl border p-4")}>
      <div className="flex items-start gap-2.5">
        <Monogram name={email.name} className="mt-px size-6 rounded-full text-[11px]" />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[14px] leading-5">{email.name}</span>
            <span className="caption-style text-subtle ml-auto shrink-0 tabular-nums">{email.when}</span>
          </span>
          <span className="caption-style text-subtle flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 leading-[1.4]">
            <span className="min-w-0 truncate">{email.email}</span>
            <span aria-hidden className="max-sm:hidden">·</span>
            <span className="flex min-w-0 items-center gap-1.5">
              <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: tagBase(email.account) }} />
              <span className="truncate">To {email.account}</span>
            </span>
          </span>
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[14px] leading-5">{email.subject}</span>
        <p className="caption-style text-soft line-clamp-2 leading-[1.5]">{email.snippet}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" className="max-w-full" data-row-key="a" title="Create contact and file (A)">
          <span className="truncate">Create {email.name} &amp; file</span>
        </Button>
        <Button variant="secondary" size="sm" data-row-key="f" title="File to… (F)">
          File to…
        </Button>
        {others.map((item) => (
          <Button key={item.id} variant="secondary" size="sm" data-row-key="m" title={`Move to ${item.name}'s Capture (M)`}>
            <WorkspaceTile workspace={item} className="size-4 rounded-[5px] text-[9px]" />
            Move to {item.name}
          </Button>
        ))}
        <Button variant="ghost" size="sm" data-row-key="i" title="Ignore (I)">
          Ignore
        </Button>
      </div>
    </li>
  );
}

export function CaptureMock({ workspace }: { workspace: MockWorkspace }) {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader title="Capture" viewer={VIEWER} />
      <div className="min-h-0 flex-1 overflow-y-auto pb-24">
        <div className="mx-auto flex w-full max-w-[52rem] flex-col gap-6 px-4 py-5 sm:px-6 sm:py-6">
          <section aria-labelledby="to-file-heading" className="flex flex-col gap-3">
            <h2 id="to-file-heading" className="eyebrow-style text-subtle flex items-center gap-2 font-normal">
              To file
              <span className="text-soft tracking-normal tabular-nums">{workspace.capture}</span>
            </h2>
            <div className="flex flex-col gap-6">
              <section className="flex flex-col gap-2" aria-labelledby="unknown-email-heading">
                <h3 id="unknown-email-heading" className="h4-style">
                  Email from people not in Orbit
                </h3>
                <ul className="flex flex-col gap-2">
                  {EMAILS.map((email) => (
                    <EmailCard key={email.id} email={email} workspace={workspace} />
                  ))}
                </ul>
              </section>
              <section className="flex flex-col gap-2" aria-labelledby="people-met-heading">
                <h3 id="people-met-heading" className="h4-style">
                  People you&apos;ve met who aren&apos;t in Orbit
                </h3>
                <ul className="bg-card border-line-strong divide-line-strong flex flex-col divide-y overflow-hidden rounded-2xl border">
                  {MET.map((person) => (
                    <li key={person.name} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                      <Monogram name={person.name} />
                      <span className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
                        <span className="truncate text-[14px] leading-5">{person.name}</span>
                        <span className="caption-style text-subtle truncate leading-[1.4]">{person.line}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1 max-sm:pl-11">
                        <Button variant="secondary" size="sm">
                          Create contact
                        </Button>
                        <Button variant="ghost" size="sm">
                          Hide
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}
