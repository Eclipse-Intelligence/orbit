"use client";

import Button from "@/components/_ui/button";
import { ScrollArea } from "@/components/_ui/scroll-area";
import SidebarNavItem from "./sidebar-nav-item";
import SidebarSection from "./sidebar-section";
import { useCompaniesStore } from "@/stores/companies-store";
import Logo from "@/public/assets/images/_common/logo.svg";
import BuildingIcon from "@/public/assets/images/companies/sidebar/building.svg";
import ClipboardIcon from "@/public/assets/images/companies/sidebar/clipboard.svg";
import ListIcon from "@/public/assets/images/companies/sidebar/list.svg";
import BookClosedIcon from "@/public/assets/images/companies/sidebar/book-closed.svg";
import TargetIcon from "@/public/assets/images/companies/sidebar/target-05.svg";

type SidebarContentProps = {
  companyCount: number;
  workspaceName: string;
};

export default function SidebarContent({
  companyCount,
  workspaceName,
}: SidebarContentProps) {
  const openProfile = useCompaniesStore((state) => state.openProfile);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-sidebar-border bg-sidebar-accent flex shrink-0 items-center gap-2 border-b p-3">
        <Logo aria-hidden className="size-8 shrink-0 overflow-visible" />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="lead-style block truncate font-medium tracking-[-0.01em]">
            Sales CRM
          </span>
          <span className="caption-style text-subtle block truncate">
            {workspaceName}
          </span>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <nav aria-label="Primary">
          <SidebarSection className="border-sidebar-border border-b">
            <SidebarNavItem
              icon={BuildingIcon}
              label="Companies"
              count={companyCount}
              active
            />
            <SidebarNavItem icon={BookClosedIcon} label="Contacts" disabled />
            <SidebarNavItem icon={ClipboardIcon} label="Opportunities" disabled />
            <SidebarNavItem icon={ListIcon} label="Activities" disabled />
            <SidebarNavItem icon={TargetIcon} label="Next actions" disabled />
          </SidebarSection>
        </nav>
      </ScrollArea>

      <SidebarSection className="border-sidebar-border shrink-0 border-t">
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
