"use client";

import type { ReactNode } from "react";
import Button from "@/components/_ui/button";
import SidebarNavItem from "@/components/_common/sidebar/sidebar-nav-item";
import SidebarSection from "@/components/_common/sidebar/sidebar-section";
import { CollapseSidebarButton, NewDot } from "@/components/_common/sidebar/sidebar-toggle";
import WorkspaceSwitcher from "@/components/workspaces/workspace-switcher";
import { displayInitials } from "@/lib/companies";
import { cn } from "@/lib/utils";
import BellIcon from "@/public/assets/images/companies/header/bell.svg";
import MenuIcon from "@/public/assets/images/_common/menu.svg";
import SearchIcon from "@/public/assets/images/_common/search.svg";
import ChevronRightIcon from "@/public/assets/images/_common/chevron-right.svg";
import BuildingIcon from "@/public/assets/images/companies/sidebar/building.svg";
import ClipboardIcon from "@/public/assets/images/companies/sidebar/clipboard.svg";
import FileSignatureIcon from "@/public/assets/images/companies/sidebar/file-signature.svg";
import BookClosedIcon from "@/public/assets/images/companies/sidebar/book-closed.svg";
import MailIcon from "@/public/assets/images/companies/sidebar/mail.svg";
import InboxIcon from "@/public/assets/images/mail/inbox.svg";
import CalendarIcon from "@/public/assets/images/companies/sidebar/calendar.svg";
import TargetIcon from "@/public/assets/images/companies/sidebar/target-05.svg";
import ZapIcon from "@/public/assets/images/companies/sidebar/zap.svg";
import MessageIcon from "@/public/assets/images/companies/sidebar/message-question.svg";
import { BELL_UPDATES, type BellUpdate } from "./mock-data";

export type ChromeState = {
  viewer: string;
  role: "owner" | "member";
  active: "capture" | "mail";
  captureCount: number;
  captureNew: boolean;
  otherWorkspaceNew: boolean;
  tasks: number;
  bellUnread: boolean;
};

const WORKSPACES = [
  { id: "00000000-0000-4000-8000-000000000001", name: "Eclipse" },
  { id: "00000000-0000-4000-8000-000000000002", name: "Cntent" },
];

export function MockSidebar({ state }: { state: ChromeState }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-sidebar-border bg-sidebar-accent flex shrink-0 items-center gap-2 border-b p-3">
        <WorkspaceSwitcher
          workspaces={WORKSPACES.map((item, index) => ({ ...item, role: state.role, waiting: index === 1 && state.otherWorkspaceNew }))}
          currentId={WORKSPACES[0].id}
          currentName={WORKSPACES[0].name}
          viewerName={state.viewer}
        />
        <CollapseSidebarButton />
      </div>
      <nav aria-label="Primary" className="min-h-0 flex-1 overflow-y-auto">
        <SidebarSection className="border-sidebar-border border-b">
          <SidebarNavItem icon={InboxIcon} label="Mail" count={12} active={state.active === "mail"} />
          <SidebarNavItem icon={BuildingIcon} label="Companies" count={214} />
          <SidebarNavItem icon={BookClosedIcon} label="Contacts" />
          <SidebarNavItem
            icon={MailIcon}
            label="Capture"
            count={state.captureCount > 0 ? state.captureCount : undefined}
            countLabel="waiting on you"
            accent
            dot={state.active !== "capture" && state.captureNew}
            dotLabel="New since you last looked"
            active={state.active === "capture"}
          />
          <SidebarNavItem icon={CalendarIcon} label="Calendar" />
          <SidebarNavItem icon={ClipboardIcon} label="Opportunities" />
          <SidebarNavItem icon={FileSignatureIcon} label="Proposals" />
          <SidebarNavItem icon={TargetIcon} label="Tasks" count={state.tasks} />
          <SidebarNavItem icon={ZapIcon} label="Workflows" />
        </SidebarSection>
      </nav>
      <SidebarSection className="border-sidebar-border shrink-0 border-t">
        <SidebarNavItem icon={MessageIcon} label="Settings" />
        <Button variant="nav" size="md" className="text-subtle h-[30px] justify-start">
          Account
        </Button>
      </SidebarSection>
    </div>
  );
}

export function MockHeader({ title, state, bell }: { title: string; state: ChromeState; bell?: ReactNode }) {
  const menuDot = state.active !== "capture" && state.captureNew;
  return (
    <header className="border-border relative shrink-0 border-b">
      <div className="flex items-center justify-between gap-3 px-3 py-2.5 sm:px-4 sm:py-[14px]">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Button variant="secondary" size="icon" className="relative lg:hidden" aria-label={menuDot ? "Open navigation, new in Capture" : "Open navigation"}>
            <MenuIcon aria-hidden className="size-3.5" />
            {menuDot && <NewDot />}
          </Button>
          <h1 className="truncate">{title}</h1>
        </div>
        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <Button variant="secondary" size="icon" aria-label="Search and commands">
            <SearchIcon aria-hidden className="size-3.5" />
          </Button>
          <span className="sm:relative">
            <Button variant="secondary" size="icon" aria-label="Notifications" aria-expanded={Boolean(bell)} className={cn("relative", bell && "bg-muted")}>
              <BellIcon aria-hidden className="size-3.5" />
              {state.bellUnread && <span className="bg-danger absolute top-1 right-1 size-1.5 rounded-full" />}
            </Button>
            {bell}
          </span>
          <Button variant="secondary" size="none" className="caption-style h-[30px] gap-1.5 py-[5px] pr-[7px] pl-[5px] font-normal" aria-label={`Account menu for ${state.viewer}`}>
            <span aria-hidden className="bg-muted text-foreground flex size-5 items-center justify-center rounded-full text-[10px] leading-none">
              {displayInitials(state.viewer)}
            </span>
            <span className="hidden max-w-[12rem] truncate sm:inline">{state.viewer}</span>
          </Button>
        </div>
      </div>
    </header>
  );
}

export function BellPanel({ count, summary, updates = BELL_UPDATES }: { count: number; summary: string; updates?: BellUpdate[] }) {
  return (
    <div className="border-line-strong bg-popover text-popover-foreground shadow-overlay absolute inset-x-3 top-[52px] z-50 overflow-hidden rounded-xl border sm:inset-x-auto sm:top-[calc(100%+8px)] sm:right-0 sm:w-[360px]">
      <div className="flex max-h-[min(560px,calc(100dvh-6rem))] flex-col gap-3 overflow-auto px-4 py-5">
        <h2>Notifications</h2>
        {count > 0 && (
          <Button variant="ghost" size="sm" className="h-auto w-full items-center justify-start gap-2.5 rounded-lg bg-white/[0.04] px-2.5 py-2.5 text-left whitespace-normal">
            <span aria-hidden className="bg-primary text-primary-foreground flex size-6 shrink-0 items-center justify-center rounded-full">
              <MailIcon className="size-3" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-foreground text-[14px] leading-5">{count} waiting in Capture</span>
              <span className="caption-style text-subtle">{summary}</span>
            </span>
            <ChevronRightIcon aria-hidden className="text-subtle size-3 shrink-0" />
          </Button>
        )}
        <ul className="flex flex-col gap-1">
          {updates.map((item) => (
            <li key={item.id}>
              <Button variant="ghost" size="sm" className="h-auto w-full items-start justify-start rounded-lg px-2 py-2 text-left whitespace-normal">
                <span aria-hidden className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", item.fresh ? (item.tone === "alert" ? "bg-danger" : "bg-primary") : "bg-transparent")} />
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="text-foreground text-[14px] leading-5">{item.title}</span>
                  <span className="caption-style text-subtle line-clamp-2">{item.body}</span>
                  <span className="caption-style text-subtle">{item.when}</span>
                </span>
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function MockFrame({ state, title, bell, sheet, children }: { state: ChromeState; title: string; bell?: ReactNode; sheet?: boolean; children: ReactNode }) {
  return (
    <div className={cn("bg-background fixed inset-0 flex overflow-hidden", sheet ? "z-[55]" : "z-30")}>
      <aside className="border-sidebar-border bg-sidebar relative hidden w-(--sidebar-width) shrink-0 border-r lg:flex lg:flex-col">
        <MockSidebar state={state} />
      </aside>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <MockHeader title={title} state={state} bell={bell} />
        <div className="min-h-0 flex-1 overflow-y-auto pb-24">
          <div className="mx-auto flex w-full max-w-[52rem] flex-col gap-6 px-4 py-5 sm:px-6 sm:py-6">{children}</div>
        </div>
      </section>
      {sheet && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div aria-hidden className="absolute inset-0 bg-black/60 backdrop-blur-[6px]" />
          <div className="border-line-strong bg-sidebar border-sidebar-border absolute inset-y-0 left-0 flex h-dvh w-[254px] max-w-[85vw] flex-col border-r">
            <MockSidebar state={state} />
          </div>
        </div>
      )}
    </div>
  );
}
