"use client";

import type { ReactNode } from "react";
import Button from "@/components/_ui/button";
import SectionHeader from "@/components/crm/section-header";
import type { Viewer } from "@/components/crm/viewer";
import { cn } from "@/lib/utils";
import SearchIcon from "@/public/assets/images/_common/search.svg";
import ComposeIcon from "@/public/assets/images/mail/compose.svg";
import FollowUpIcon from "@/public/assets/images/mail/follow-up.svg";

export type MockRow = {
  key: string;
  people: string;
  subject: string;
  snippet: string;
  when: string;
  unread?: boolean;
  count?: number;
  pill?: string;
  followUpOn?: string;
};

export const ROWS: MockRow[] = [
  { key: "sam", people: "Sam Person", subject: "Lunch on Thursday?", snippet: "Works for me. 12:30 at the usual place?", when: "10:41", unread: true },
  { key: "brightwave", people: "Priya Shah", subject: "Brightwave contract", snippet: "Signed copy attached. Thanks for turning it round so quickly.", when: "09:58", unread: true },
  { key: "jane", people: "Me, Jane Doe", subject: "Acme pilot: proposal and next steps", snippet: "Here's the pilot we talked about on Tuesday: six weeks, both sales teams", when: "08:12", count: 2 },
  { key: "insights", people: "Insights Daily", subject: "Agencies move budget to AI search", snippet: "This week: the agencies moving spend first", when: "3 Nov" },
  { key: "northwind", people: "Tom Baker", subject: "Northwind intro", snippet: "Great to meet you both. Looping in Ana from our side", when: "3 Nov", unread: true },
  { key: "product", people: "Product Digest", subject: "Your product digest", snippet: "Five launches worth a look this week", when: "2 Nov" },
  { key: "client", people: "Client Seed", subject: "Client Seed update", snippet: "Quarterly numbers and what's next", when: "1 Nov" },
  { key: "brand", people: "Brand Weekly", subject: "This week in brand", snippet: "The rebrands everyone is talking about", when: "31 Oct" },
];

function Row({ row, active }: { row: MockRow; active: boolean }) {
  return (
    <li>
      <button
        type="button"
        aria-current={active ? "true" : undefined}
        className={cn(
          "ease-power3-out relative flex w-full cursor-pointer flex-col gap-0.5 rounded-xl px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
          active ? "bg-white/[0.07]" : "hover:bg-white/[0.035]",
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", row.unread ? "bg-primary shadow-[0_0_0_3px_rgba(65,36,251,0.18)]" : "bg-transparent")} />
          <span className={cn("min-w-0 truncate text-[14px]", row.unread ? "text-foreground font-medium" : "text-soft")}>{row.people}</span>
          {row.count && <span className="text-subtle shrink-0 text-[12px] tabular-nums">{row.count}</span>}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {row.followUpOn ? (
              <span className="text-primary-foreground flex items-center gap-1 text-[12px] tabular-nums" title="Follow-up goes out if nobody replies">
                <FollowUpIcon aria-hidden className="size-3" />
                {row.followUpOn}
              </span>
            ) : (
              <span className={cn("text-[12px] tabular-nums", row.unread ? "text-foreground" : "text-subtle")}>{row.when}</span>
            )}
          </span>
        </span>
        <span className="flex min-w-0 items-baseline gap-1.5 pl-3.5 text-[13px]">
          {row.pill && (
            <span className="text-primary-foreground shrink-0 rounded-full bg-[color-mix(in_srgb,var(--primary)_30%,transparent)] px-1.5 text-[11px] leading-[18px] font-medium">
              {row.pill}
            </span>
          )}
          <span className={cn("max-w-[70%] shrink-0 truncate", row.unread ? "text-foreground" : "text-soft")}>{row.subject}</span>
          <span className="text-subtle min-w-0 truncate">{row.snippet}</span>
        </span>
      </button>
    </li>
  );
}

export default function MailFrame({
  viewer,
  rows = ROWS,
  active = null,
  children,
}: {
  viewer: Viewer;
  rows?: MockRow[];
  active?: string | null;
  children?: ReactNode;
}) {
  const open = Boolean(children);
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader
        title="Mail"
        viewer={viewer}
        heading={
          <div className="flex min-w-0 items-center gap-5">
            <h1 className="shrink-0">Mail</h1>
            <div className="hidden min-w-0 flex-1 lg:flex">
              <div className="relative w-full max-w-[26rem]">
                <SearchIcon aria-hidden className="text-subtle pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2" />
                <label htmlFor="mock-search" className="sr-only">
                  Search mail
                </label>
                <input
                  id="mock-search"
                  placeholder="Search, or ask a question"
                  className="placeholder:text-subtle text-foreground h-8 w-full rounded-xl bg-white/[0.04] pr-24 pl-9 text-[14px] outline-none"
                />
              </div>
            </div>
          </div>
        }
        action={
          <Button variant="primary" title="Write an email (C then M)" aria-label="Compose" shortcut={["C", "M"]} className="max-sm:size-[30px] max-sm:p-0">
            <ComposeIcon aria-hidden className="size-3.5 sm:hidden" />
            <span className="max-sm:sr-only">Compose</span>
          </Button>
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className={cn("min-h-0 w-full flex-col md:flex md:w-[20rem] md:shrink-0 lg:w-[25rem] xl:w-[29rem]", open ? "hidden" : "flex")}>
          <div className="flex shrink-0 flex-col gap-2 px-3 pt-2 pb-1.5 lg:pt-3">
            <nav aria-label="Mail folders" className="-mx-1 flex items-center gap-0.5 px-1">
              {[
                ["Important", "7"],
                ["Other", ""],
                ["News", "4"],
              ].map(([label, unread], index) => (
                <button
                  key={label}
                  type="button"
                  aria-current={index === 0 ? "page" : undefined}
                  className={cn(
                    "flex h-8 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2.5 text-[13px] outline-none",
                    index === 0 ? "text-foreground bg-white/[0.07]" : "text-subtle hover:text-foreground hover:bg-white/[0.035]",
                  )}
                >
                  {label}
                  {unread && <span className={cn("tabular-nums", index === 0 ? "text-primary-foreground" : "text-soft")}>{unread}</span>}
                </button>
              ))}
            </nav>
          </div>
          <div className="relative min-h-0 flex-1 overflow-y-auto">
            <ul aria-label="Conversations" className="flex flex-col gap-px px-2 pb-24">
              {rows.map((row) => (
                <Row key={row.key} row={row} active={row.key === active} />
              ))}
            </ul>
          </div>
        </div>
        <div
          data-mock-reader=""
          className={cn("min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:my-2 md:mr-2 md:flex md:rounded-2xl md:bg-white/[0.02]", open ? "flex" : "hidden")}
        >
          {children ?? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
              <p className="text-soft">Nothing open.</p>
              <p className="caption-style text-subtle">Press J or K to move through your mail, or pick a conversation.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
