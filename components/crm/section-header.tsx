"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import Button from "@/components/_ui/button";
import Notifications from "@/components/companies/header/notifications/notifications";
import { useListHref } from "@/components/crm/list-memory";
import type { Viewer } from "@/components/crm/viewer";
import { displayInitials } from "@/lib/companies";
import { RECORD_LISTS, type RecordListKey } from "@/lib/crm/hrefs";
import { useCompaniesStore } from "@/stores/companies-store";
import { useShortcuts } from "@/components/shortcuts/shortcuts-provider";
import { ExpandSidebarButton } from "@/components/_common/sidebar/sidebar-toggle";
import ChevronLeftIcon from "@/public/assets/images/_common/chevron-left.svg";
import ChevronRightIcon from "@/public/assets/images/_common/chevron-right.svg";
import MenuIcon from "@/public/assets/images/_common/menu.svg";
import SearchIcon from "@/public/assets/images/_common/search.svg";

export default function SectionHeader({
  title,
  viewer,
  action,
  list,
  heading,
}: {
  title: string;
  viewer: Viewer;
  action?: ReactNode;
  list?: RecordListKey;
  heading?: ReactNode;
}) {
  const setSidebarOpen = useCompaniesStore((state) => state.setSidebarOpen);
  const { setPaletteOpen } = useShortcuts();
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
          {list ? (
            <RecordBreadcrumb list={list} title={title} />
          ) : (
            <div className="flex min-w-0 flex-col">{heading ?? <h1 className="truncate">{title}</h1>}</div>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-start gap-2 sm:justify-end">
          {action}
          <Button
            variant="secondary"
            size="icon"
            aria-label="Search and commands"
            aria-keyshortcuts="Meta+/ Control+/"
            title="Search and commands (⌘/)"
            onClick={() => setPaletteOpen(true)}
          >
            <SearchIcon aria-hidden className="size-3.5" />
          </Button>
          <Notifications />
          <Button
            variant="secondary"
            size="none"
            className="caption-style h-[30px] gap-1.5 py-[5px] pr-[7px] pl-[5px] font-normal"
            aria-label={`Open account for ${viewer.name}`}
            data-shortcut="account"
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

function RecordBreadcrumb({ list, title }: { list: RecordListKey; title: string }) {
  const href = useListHref(list);
  const label = RECORD_LISTS[list].label;
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1.5">
        <li className="shrink-0">
          <Link
            href={href}
            data-shortcut="back"
            title={`Back to ${label} (Esc)`}
            className="text-subtle hover:text-foreground flex h-[30px] items-center gap-1 rounded-full text-[14px] leading-5 transition-colors duration-150 max-sm:-ml-1 max-sm:pr-2.5 max-sm:pl-1.5 max-sm:hover:bg-white/6"
          >
            <ChevronLeftIcon aria-hidden className="size-3 sm:hidden" />
            {label}
          </Link>
        </li>
        <li aria-hidden className="text-faint hidden sm:block">
          <ChevronRightIcon className="size-3" />
        </li>
        <li className="min-w-0">
          <h1 aria-current="page" className="truncate max-sm:sr-only">
            {title}
          </h1>
        </li>
      </ol>
    </nav>
  );
}
