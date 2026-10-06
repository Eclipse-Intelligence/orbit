"use client";

import type { ReactNode } from "react";
import Button from "@/components/_ui/button";
import Notifications from "@/components/companies/header/notifications/notifications";
import type { Viewer } from "@/components/crm/viewer";
import { displayInitials } from "@/lib/companies";
import { useCompaniesStore } from "@/stores/companies-store";
import { ExpandSidebarButton } from "@/components/_common/sidebar/sidebar-toggle";
import MenuIcon from "@/public/assets/images/_common/menu.svg";
import SearchIcon from "@/public/assets/images/_common/search.svg";

export default function SectionHeader({
  title,
  viewer,
  action,
}: {
  title: string;
  viewer: Viewer;
  action?: ReactNode;
}) {
  const setSidebarOpen = useCompaniesStore((state) => state.setSidebarOpen);
  const setSearchOpen = useCompaniesStore((state) => state.setSearchOpen);
  const openProfile = useCompaniesStore((state) => state.openProfile);

  return (
    <header className="border-border shrink-0 border-b">
      <div className="flex flex-col gap-3 px-4 py-[14px] sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="secondary"
            size="icon"
            className="lg:hidden"
            aria-label="Open navigation"
            onClick={() => setSidebarOpen(true)}
          >
            <MenuIcon aria-hidden className="size-3.5" />
          </Button>
          <ExpandSidebarButton />
          <div className="flex min-w-0 flex-col">
            <h1 className="truncate">{title}</h1>
            <span className="caption-style text-subtle hidden truncate sm:block">
              {viewer.workspaceName}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-start gap-2 sm:justify-end">
          {action}
          <Button
            variant="secondary"
            size="icon"
            aria-label="Search"
            aria-keyshortcuts="Meta+K Control+K"
            onClick={() => setSearchOpen(true)}
          >
            <SearchIcon aria-hidden className="size-3.5" />
          </Button>
          <Notifications />
          <Button
            variant="secondary"
            size="none"
            className="caption-style h-[30px] gap-1.5 py-[5px] pr-[7px] pl-[5px] font-normal"
            aria-label={`Open account for ${viewer.name}`}
            onClick={openProfile}
          >
            <span
              aria-hidden
              className="bg-muted text-foreground flex size-5 items-center justify-center rounded-full text-[10px] leading-none"
            >
              {displayInitials(viewer.name)}
            </span>
            <span className="hidden max-w-[12rem] truncate sm:inline">{viewer.name}</span>
          </Button>
        </div>
      </div>
    </header>
  );
}
