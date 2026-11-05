"use client";

import { useEffect, useState, type ReactNode } from "react";
import Button from "@/components/_ui/button";
import { Kbd } from "@/components/_ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/_ui/dropdown-menu";
import { ScrollArea } from "@/components/_ui/scroll-area";
import { Sheet, SheetCloseButton, SheetContent, SheetDescription, SheetTitle } from "@/components/_ui/sheet";
import SidebarDocs from "@/components/_common/sidebar/sidebar-docs";
import SidebarNavItem from "@/components/_common/sidebar/sidebar-nav-item";
import SidebarSection from "@/components/_common/sidebar/sidebar-section";
import SidebarShortcuts from "@/components/_common/sidebar/sidebar-shortcuts";
import { CollapseSidebarButton } from "@/components/_common/sidebar/sidebar-toggle";
import { cn } from "@/lib/utils";
import CheckIcon from "@/public/assets/images/assistant/check.svg";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import Logo from "@/public/assets/images/_common/logo.svg";
import PlusIcon from "@/public/assets/images/_common/plus.svg";
import BookClosedIcon from "@/public/assets/images/companies/sidebar/book-closed.svg";
import BuildingIcon from "@/public/assets/images/companies/sidebar/building.svg";
import CalendarIcon from "@/public/assets/images/companies/sidebar/calendar.svg";
import ClipboardIcon from "@/public/assets/images/companies/sidebar/clipboard.svg";
import ColumnsIcon from "@/public/assets/images/companies/sidebar/columns.svg";
import FileSignatureIcon from "@/public/assets/images/companies/sidebar/file-signature.svg";
import MailIcon from "@/public/assets/images/companies/sidebar/mail.svg";
import MessageIcon from "@/public/assets/images/companies/sidebar/message-question.svg";
import TargetIcon from "@/public/assets/images/companies/sidebar/target-05.svg";
import ZapIcon from "@/public/assets/images/companies/sidebar/zap.svg";
import InboxIcon from "@/public/assets/images/mail/inbox.svg";
import { WORKSPACES, type MockWorkspace, type WorkspaceId } from "./mock-data";

const TILE_TONES: Record<WorkspaceId, string> = {
  eclipse: "bg-(--tag-orange-bg) text-(--tag-orange-text) shadow-[inset_0_0_0_1px_var(--tag-orange-border)]",
  ridgeon: "bg-(--tag-purple-bg) text-(--tag-purple-text) shadow-[inset_0_0_0_1px_var(--tag-purple-border)]",
};

export function WorkspaceTile({ workspace, className }: { workspace: MockWorkspace; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-md text-[10px] leading-none font-semibold",
        TILE_TONES[workspace.id],
        className,
      )}
    >
      {workspace.initial}
    </span>
  );
}

export type Section = "mail" | "capture" | "settings" | "companies";

function WorkspaceSwitcher({ workspace, open }: { workspace: MockWorkspace; open: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => setMenuOpen(true), 500);
    return () => window.clearTimeout(timer);
  }, [open]);
  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="none"
          aria-label={`Workspace: ${workspace.name}. Switch workspace`}
          className="text-foreground hover:text-foreground data-[state=open]:bg-white/6 -m-1 min-w-0 flex-1 justify-start gap-2 rounded-lg p-1 text-left font-normal active:scale-100 max-lg:mr-7"
        >
          <Logo aria-hidden className="size-8 shrink-0 overflow-visible" />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="lead-style block truncate font-medium tracking-[-0.01em]">Orbit</span>
            <span className="caption-style text-subtle flex min-w-0 items-center gap-1">
              <span className="truncate">{workspace.name}</span>
              <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
            </span>
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={10} className="w-[14.5rem]">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {Object.values(WORKSPACES).map((item) => (
          <DropdownMenuItem key={item.id} className="max-lg:py-2.5">
            <WorkspaceTile workspace={item} />
            <span className="min-w-0 flex-1 truncate">{item.name}</span>
            {item.id === workspace.id && (
              <>
                <CheckIcon aria-hidden className="text-foreground size-3.5 shrink-0" />
                <span className="sr-only">Current</span>
              </>
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-soft max-lg:py-2.5">
          <span aria-hidden className="flex size-5 shrink-0 items-center justify-center">
            <PlusIcon className="size-3.5" />
          </span>
          New workspace
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SidebarBody({ workspace, section, switcherOpen }: { workspace: MockWorkspace; section: Section; switcherOpen: boolean }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-sidebar-border bg-sidebar-accent flex shrink-0 items-center gap-2 border-b p-3">
        <WorkspaceSwitcher workspace={workspace} open={switcherOpen} />
        <CollapseSidebarButton />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <nav aria-label="Primary">
          <SidebarSection className="border-sidebar-border border-b">
            <SidebarNavItem href="#mail" icon={InboxIcon} label="Mail" count={7} active={section === "mail"} />
            <SidebarNavItem href="#companies" icon={BuildingIcon} label="Companies" count={workspace.companies} active={section === "companies"} />
            <SidebarNavItem href="#contacts" icon={BookClosedIcon} label="Contacts" />
            <SidebarNavItem
              href="#capture"
              icon={MailIcon}
              label="Capture"
              count={workspace.capture}
              countLabel="waiting to file"
              accent
              active={section === "capture"}
            />
            <SidebarNavItem href="#calendar" icon={CalendarIcon} label="Calendar" />
            <SidebarNavItem
              href="#opportunities"
              icon={ClipboardIcon}
              label="Opportunities"
              accessory={
                <Button variant="ghost" size="icon-sm" aria-label="Hide boards" aria-expanded className="size-5 rounded-md">
                  <ChevronDownIcon aria-hidden className="size-3" />
                </Button>
              }
            />
            <li>
              <ul aria-label="Boards" className="border-sidebar-border mb-1 ml-[15px] flex flex-col border-l pl-1.5">
                {workspace.boards.map((board) => (
                  <SidebarNavItem key={board.id} href={`#${board.id}`} icon={ColumnsIcon} label={board.name} count={board.count} />
                ))}
              </ul>
            </li>
            <SidebarNavItem href="#proposals" icon={FileSignatureIcon} label="Proposals" />
            <SidebarNavItem href="#tasks" icon={TargetIcon} label="Tasks" count={workspace.tasks} />
            <SidebarNavItem href="#workflows" icon={ZapIcon} label="Workflows" />
          </SidebarSection>
          <SidebarDocs />
        </nav>
      </ScrollArea>
      <SidebarSection className="border-sidebar-border shrink-0 border-t">
        <SidebarNavItem href="#settings" icon={MessageIcon} label="Settings" active={section === "settings"} />
        <SidebarShortcuts />
        <Button variant="nav" size="md" className="text-subtle h-[30px] justify-start">
          Account
        </Button>
      </SidebarSection>
    </div>
  );
}

export function MockFrame({
  workspace,
  section,
  switcherOpen = false,
  phoneNav = false,
  dock = true,
  children,
}: {
  workspace: MockWorkspace;
  section: Section;
  switcherOpen?: boolean;
  phoneNav?: boolean;
  dock?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="bg-background fixed inset-0 z-[45] flex overflow-hidden">
      <aside className="border-sidebar-border bg-sidebar relative hidden w-(--sidebar-width) shrink-0 border-r lg:flex lg:flex-col">
        <SidebarBody workspace={workspace} section={section} switcherOpen={switcherOpen && !phoneNav} />
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      {dock && <DockPill workspace={workspace} />}
      <QuickAddButton hideOnPhone={!dock} />
      {phoneNav && (
        <Sheet open>
          <SheetContent side="left" className="border-sidebar-border bg-sidebar w-[254px] max-w-[85vw]">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SheetDescription className="sr-only">Companies, contacts, opportunities, and tasks.</SheetDescription>
            <SheetCloseButton label="Close menu" className="absolute top-3 right-3 z-10 mr-0" />
            <SidebarBody workspace={workspace} section={section} switcherOpen={switcherOpen} />
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}

export const DOCK_PLACEMENT =
  "fixed z-40 bottom-4 left-3 right-[4.75rem] md:right-auto md:left-1/2 md:-translate-x-1/2 lg:left-[calc(var(--sidebar-width)+(100vw-var(--sidebar-width))/2)]";

function DockPill({ workspace }: { workspace: MockWorkspace }) {
  return (
    <div className={DOCK_PLACEMENT}>
      <button
        type="button"
        aria-keyshortcuts="o"
        className="group text-subtle hover:text-foreground focus-visible:ring-ring/60 ease-power3-out flex h-11 w-full cursor-text items-center gap-2.5 rounded-full bg-[#1f1f1f]/90 pr-2 pl-5 text-left text-[14px] shadow-[0_12px_40px_rgba(0,0,0,0.5)] backdrop-blur-xl transition-[color,background-color] duration-150 outline-none hover:bg-[#232323]/95 focus-visible:ring-2 md:w-[24rem]"
      >
        <span className="min-w-0 flex-1 truncate">Ask Orbit in {workspace.name}</span>
        <Kbd aria-hidden className="max-md:hidden">
          O
        </Kbd>
      </button>
    </div>
  );
}

function QuickAddButton({ hideOnPhone }: { hideOnPhone: boolean }) {
  return (
    <div className={cn("pointer-events-none fixed right-4 bottom-4 z-40", hideOnPhone && "max-md:hidden")}>
      <button
        type="button"
        aria-label="Quick add"
        className="bg-primary text-primary-foreground pointer-events-auto flex size-12 cursor-pointer items-center justify-center rounded-full shadow-[0px_8px_24px_0px_rgba(0,0,0,0.45),0px_0px_0px_1px_#0e0e0e,inset_0px_4px_6px_0px_rgba(255,255,255,0.2),inset_0px_0px_0px_1px_rgba(255,255,255,0.15),inset_0px_-8px_14px_0px_rgba(0,0,0,0.15)]"
      >
        <PlusIcon aria-hidden className="size-5" />
      </button>
    </div>
  );
}
