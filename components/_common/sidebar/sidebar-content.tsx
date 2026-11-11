"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import Button from "@/components/_ui/button";
import { ScrollArea } from "@/components/_ui/scroll-area";
import SidebarBoards from "./sidebar-boards";
import SidebarDocs from "./sidebar-docs";
import SidebarNavItem from "./sidebar-nav-item";
import SidebarSection from "./sidebar-section";
import SidebarShortcuts from "./sidebar-shortcuts";
import { CollapseSidebarButton } from "./sidebar-toggle";
import { captureHasNew, captureLeft, useCompaniesStore } from "@/stores/companies-store";
import { sidebarBadge } from "@/lib/chat/timeline";
import type { CaptureStatus } from "@/lib/crm/capture";
import { TASKS_PATH } from "@/lib/crm/task-views";
import { SETTINGS_ROOT } from "@/lib/settings-nav";
import type { BoardSummary } from "@/lib/crm/types";
import { cn } from "@/lib/utils";
import WorkspaceSwitcher from "@/components/workspaces/workspace-switcher";
import type { SidebarWorkspace } from "./sidebar";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import BuildingIcon from "@/public/assets/images/companies/sidebar/building.svg";
import ClipboardIcon from "@/public/assets/images/companies/sidebar/clipboard.svg";
import FileSignatureIcon from "@/public/assets/images/companies/sidebar/file-signature.svg";
import BookClosedIcon from "@/public/assets/images/companies/sidebar/book-closed.svg";
import MailIcon from "@/public/assets/images/companies/sidebar/mail.svg";
import InboxIcon from "@/public/assets/images/mail/inbox.svg";
import ChatIcon from "@/public/assets/images/chat/chat.svg";
import CalendarIcon from "@/public/assets/images/companies/sidebar/calendar.svg";
import TargetIcon from "@/public/assets/images/companies/sidebar/target-05.svg";
import ZapIcon from "@/public/assets/images/companies/sidebar/zap.svg";
import MessageIcon from "@/public/assets/images/companies/sidebar/message-question.svg";

type SidebarContentProps = {
  boards: BoardSummary[];
  companyCount: number;
  openActionCount: number;
  capture: CaptureStatus | null;
  workspace: SidebarWorkspace;
  settingsHref?: string;
};

export default function SidebarContent({
  boards,
  companyCount,
  openActionCount,
  capture,
  workspace,
  settingsHref = SETTINGS_ROOT,
}: SidebarContentProps) {
  const pathname = usePathname();
  const openProfile = useCompaniesStore((state) => state.openProfile);
  const liveMailUnread = useCompaniesStore((state) => state.mailUnread);
  const unreadMail = liveMailUnread ?? 0;
  const chat = sidebarBadge(useCompaniesStore((state) => state.chat));
  const liveCapture = useCompaniesStore((state) => state.capture);
  const captureCleared = useCompaniesStore((state) => state.captureCleared);
  const captureSeen = useCompaniesStore((state) => state.captureSeen);
  const waiting = liveCapture ?? capture;
  const waitingCount = captureLeft(waiting, captureCleared).total;
  const [boardsOpen, setBoardsOpen] = useState(true);
  const current = (href: string) =>
    href === "/"
      ? pathname === "/" || pathname.startsWith("/companies/")
      : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-sidebar-border bg-sidebar-accent flex shrink-0 items-center gap-2 border-b p-3 lg:h-(--header-height) lg:py-0">
        <WorkspaceSwitcher
          workspaces={workspace.choices}
          currentId={workspace.id}
          currentName={workspace.name}
          viewerName={workspace.viewerName}
        />
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
              href="/chat"
              icon={ChatIcon}
              label="Chat"
              count={chat.count > 0 ? chat.count : undefined}
              countLabel={chat.mentioned ? "unread, mentions you" : "unread"}
              accent={chat.mentioned}
              active={current("/chat")}
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
              count={waitingCount > 0 ? waitingCount : undefined}
              countLabel="waiting on you"
              accent
              dot={!current("/capture") && captureHasNew(waiting, captureSeen)}
              dotLabel="New since you last looked"
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
              href="/proposals"
              icon={FileSignatureIcon}
              label="Proposals"
              active={current("/proposals")}
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
              active={current("/workflows")}
            />
          </SidebarSection>
          <SidebarDocs />
        </nav>
      </ScrollArea>

      <SidebarSection className="border-sidebar-border shrink-0 border-t">
        <SidebarNavItem
          href={settingsHref}
          icon={MessageIcon}
          label="Settings"
          active={current(SETTINGS_ROOT)}
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
