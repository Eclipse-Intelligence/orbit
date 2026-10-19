"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import Button from "@/components/_ui/button";
import { ScrollArea } from "@/components/_ui/scroll-area";
import SidebarBoards from "./sidebar-boards";
import SidebarNavItem from "./sidebar-nav-item";
import SidebarSection from "./sidebar-section";
import SidebarShortcuts from "./sidebar-shortcuts";
import { CollapseSidebarButton } from "./sidebar-toggle";
import { useCompaniesStore } from "@/stores/companies-store";
import { TASKS_PATH } from "@/lib/crm/task-views";
import type { BoardSummary } from "@/lib/crm/types";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import Logo from "@/public/assets/images/_common/logo.svg";
import BuildingIcon from "@/public/assets/images/companies/sidebar/building.svg";
import ClipboardIcon from "@/public/assets/images/companies/sidebar/clipboard.svg";
import ListIcon from "@/public/assets/images/companies/sidebar/list.svg";
import BookClosedIcon from "@/public/assets/images/companies/sidebar/book-closed.svg";
import MailIcon from "@/public/assets/images/companies/sidebar/mail.svg";
import InboxIcon from "@/public/assets/images/mail/inbox.svg";
import CalendarIcon from "@/public/assets/images/companies/sidebar/calendar.svg";
import TargetIcon from "@/public/assets/images/companies/sidebar/target-05.svg";
import AlertIcon from "@/public/assets/images/companies/sidebar/alert-triangle.svg";
import ZapIcon from "@/public/assets/images/companies/sidebar/zap.svg";
import MessageIcon from "@/public/assets/images/companies/sidebar/message-question.svg";

type SidebarContentProps = {
  boards: BoardSummary[];
  approvals: number;
  companyCount: number;
  openActionCount: number;
  mailUnread: number;
  workspaceName: string;
};

export default function SidebarContent({
  boards,
  approvals,
  companyCount,
  openActionCount,
  mailUnread,
  workspaceName,
}: SidebarContentProps) {
  const pathname = usePathname();
  const openProfile = useCompaniesStore((state) => state.openProfile);
  const liveMailUnread = useCompaniesStore((state) => state.mailUnread);
  const unreadMail = liveMailUnread ?? mailUnread;
  const [boardsOpen, setBoardsOpen] = useState(true);
  const current = (href: string) =>
    href === "/"
      ? pathname === "/" || pathname.startsWith("/companies/")
      : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-sidebar-border bg-sidebar-accent flex shrink-0 items-center gap-2 border-b p-3">
        <Logo aria-hidden className="size-8 shrink-0 overflow-visible" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="lead-style block truncate font-medium tracking-[-0.01em]">
            Orbit
          </span>
          <span className="caption-style text-subtle block truncate">
            {workspaceName}
          </span>
        </div>
        <CollapseSidebarButton />
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <nav aria-label="Primary">
          <SidebarSection className="border-sidebar-border border-b">
            <SidebarNavItem
              href="/mail"
              icon={InboxIcon}
              label="Mail"
              count={unreadMail > 0 ? unreadMail : undefined}
              active={current("/mail")}
            />
            <SidebarNavItem
              href="/"
              icon={BuildingIcon}
              label="Companies"
              count={companyCount}
              active={current("/")}
            />
            <SidebarNavItem
              href="/contacts"
              icon={BookClosedIcon}
              label="Contacts"
              active={current("/contacts")}
            />
            <SidebarNavItem
              href="/capture"
              icon={MailIcon}
              label="Capture"
              active={current("/capture")}
            />
            <SidebarNavItem
              href="/calendar"
              icon={CalendarIcon}
              label="Calendar"
              active={current("/calendar")}
            />
            <SidebarNavItem
              href="/opportunities"
              icon={ClipboardIcon}
              label="Opportunities"
              active={current("/opportunities")}
              accessory={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={boardsOpen ? "Hide boards" : "Show boards"}
                  aria-expanded={boardsOpen}
                  onClick={() => setBoardsOpen((value) => !value)}
                  className="size-5 rounded-md"
                >
                  <ChevronDownIcon
                    aria-hidden
                    className={cn("ease-power3-out size-3 transition-transform duration-150", !boardsOpen && "-rotate-90")}
                  />
                </Button>
              }
            />
            <SidebarBoards boards={boards} open={boardsOpen} current={current} />
            <SidebarNavItem
              href="/activities"
              icon={ListIcon}
              label="Activities"
              active={current("/activities")}
            />
            <SidebarNavItem
              href={TASKS_PATH}
              icon={TargetIcon}
              label="Tasks"
              count={openActionCount}
              active={current(TASKS_PATH)}
            />
            <SidebarNavItem
              href="/workflows"
              icon={ZapIcon}
              label="Workflows"
              count={approvals > 0 ? approvals : undefined}
              active={current("/workflows")}
            />
            <SidebarNavItem
              href="/quiet"
              icon={AlertIcon}
              label="Quiet"
              active={current("/quiet")}
            />
          </SidebarSection>
        </nav>
      </ScrollArea>

      <SidebarSection className="border-sidebar-border shrink-0 border-t">
        <SidebarNavItem
          href="/settings"
          icon={MessageIcon}
          label="Settings"
          active={current("/settings")}
        />
        <SidebarShortcuts />
        <Button
          variant="nav"
          size="md"
          className="text-subtle h-[30px] justify-start"
          onClick={openProfile}
        >
          Account
        </Button>
      </SidebarSection>
    </div>
  );
}
