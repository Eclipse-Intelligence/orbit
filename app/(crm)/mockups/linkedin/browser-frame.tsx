"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import ChevronLeftIcon from "@/public/assets/images/_common/chevron-left.svg";
import ChevronRightIcon from "@/public/assets/images/_common/chevron-right.svg";
import Logo from "@/public/assets/images/_common/logo.svg";
import MoreIcon from "@/public/assets/images/_common/more.svg";
import RefreshIcon from "@/public/assets/images/mail/refresh.svg";
import CloseIcon from "@/public/assets/images/companies/detail/x.svg";

export type Tab = { title: string; active?: boolean; orbit?: boolean };

function TabStrip({ tabs }: { tabs: Tab[] }) {
  return (
    <div className="flex h-9 shrink-0 items-end gap-1 bg-[#1b1c1e] px-3 pt-1.5">
      <span aria-hidden className="mr-2 mb-2.5 flex gap-1.5">
        <span className="size-3 rounded-full bg-[#4a4b4e]" />
        <span className="size-3 rounded-full bg-[#4a4b4e]" />
        <span className="size-3 rounded-full bg-[#4a4b4e]" />
      </span>
      {tabs.map((tab) => (
        <span
          key={tab.title}
          className={cn(
            "flex h-[30px] w-[14em] min-w-0 items-center gap-2 rounded-t-lg px-3 text-[12px] leading-none",
            tab.active ? "bg-[#2c2d30] text-[#e8e8e8]" : "text-[#9a9a9a]",
          )}
        >
          {tab.orbit ? (
            <Logo aria-hidden className="size-4 shrink-0" />
          ) : (
            <span aria-hidden className="size-3.5 shrink-0 rounded-[3px] bg-[#8d8d8d]" />
          )}
          <span className="truncate">{tab.title}</span>
          <CloseIcon aria-hidden className="ml-auto size-3 shrink-0 opacity-60" />
        </span>
      ))}
    </div>
  );
}

function Toolbar({ url, badge }: { url: string; badge?: "in" | "maybe" | null }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 bg-[#2c2d30] px-3 text-[#c4c4c4]">
      <ChevronLeftIcon aria-hidden className="size-4" />
      <ChevronRightIcon aria-hidden className="size-4 opacity-50" />
      <RefreshIcon aria-hidden className="mx-1 size-3.5" />
      <span className="flex h-7 min-w-0 flex-1 items-center rounded-full bg-[#1e1f21] px-4 text-[13px] leading-none text-[#d8d8d8]">
        <span className="truncate">{url}</span>
      </span>
      <span className="relative ml-1 flex size-7 items-center justify-center rounded-full bg-white/10" title="Orbit extension">
        <Logo aria-hidden className="size-6" />
        {badge && (
          <span
            aria-hidden
            className={cn(
              "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full shadow-[0_0_0_2px_#2c2d30]",
              badge === "in" ? "bg-success" : "bg-warning",
            )}
          />
        )}
      </span>
      <MoreIcon aria-hidden className="size-4 rotate-90" />
    </div>
  );
}

export function ChromeSidePanel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <aside aria-label="Chrome side panel" className={cn("flex w-[380px] shrink-0 flex-col bg-[#2c2d30]", className)}>
      <div className="flex h-10 shrink-0 items-center gap-2 px-3 text-[#d8d8d8]">
        <Logo aria-hidden className="size-5" />
        <span className="text-[13px] leading-none">Orbit</span>
        <span className="ml-auto flex items-center gap-3 text-[#a8a8a8]">
          <MoreIcon aria-hidden className="size-3.5 rotate-90" />
          <CloseIcon aria-hidden className="size-3.5" />
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-tl-xl">{children}</div>
    </aside>
  );
}

export default function BrowserFrame({
  url,
  tabs,
  badge,
  page,
  panel,
}: {
  url: string;
  tabs: Tab[];
  badge?: "in" | "maybe" | null;
  page: ReactNode;
  panel?: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-[#1b1c1e]">
      <TabStrip tabs={tabs} />
      <Toolbar url={url} badge={badge} />
      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">{page}</div>
        {panel && <ChromeSidePanel>{panel}</ChromeSidePanel>}
      </div>
    </div>
  );
}

export function PanelCrop({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-[60] overflow-auto bg-[#111]">
      <div data-crop className="w-[380px]">
        <ChromeSidePanel>
          <div className="flex min-h-[640px] flex-col">{children}</div>
        </ChromeSidePanel>
      </div>
    </div>
  );
}
