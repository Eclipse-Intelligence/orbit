"use client";

import { usePathname } from "next/navigation";
import Button from "@/components/_ui/button";
import { ScrollArea } from "@/components/_ui/scroll-area";
import SidebarNavItem from "./sidebar-nav-item";
import SidebarSection from "./sidebar-section";
import { CollapseSidebarButton } from "./sidebar-toggle";
import { useCompaniesStore } from "@/stores/companies-store";
import Logo from "@/public/assets/images/_common/logo.svg";
import BuildingIcon from "@/public/assets/images/companies/sidebar/building.svg";
import ClipboardIcon from "@/public/assets/images/companies/sidebar/clipboard.svg";
import ListIcon from "@/public/assets/images/companies/sidebar/list.svg";
import BookClosedIcon from "@/public/assets/images/companies/sidebar/book-closed.svg";
import MailIcon from "@/public/assets/images/companies/sidebar/mail.svg";
import TargetIcon from "@/public/assets/images/companies/sidebar/target-05.svg";
import AlertIcon from "@/public/assets/images/companies/sidebar/alert-triangle.svg";
import MessageIcon from "@/public/assets/images/companies/sidebar/message-question.svg";

type SidebarContentProps = {
  companyCount: number;
  openActionCount: number;
  workspaceName: string;
};

export default function SidebarContent({
  companyCount,
  openActionCount,
  workspaceName,
}: SidebarContentProps) {
  const pathname = usePathname();
  const openProfile = useCompaniesStore((state) => state.openProfile);
  const current = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

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
              href="/inbox"
              icon={MailIcon}
              label="Inbox"
              active={current("/inbox")}
            />
            <SidebarNavItem
              href="/opportunities"
              icon={ClipboardIcon}
              label="Opportunities"
              active={current("/opportunities")}
            />
            <SidebarNavItem
              href="/activities"
              icon={ListIcon}
              label="Activities"
              active={current("/activities")}
            />
            <SidebarNavItem
              href="/actions"
              icon={TargetIcon}
              label="Next actions"
              count={openActionCount}
              active={current("/actions")}
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
