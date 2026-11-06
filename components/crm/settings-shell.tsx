"use client";

import {
  useEffect,
  useRef,
  type ComponentType,
  type ReactNode,
  type SVGProps,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import SectionHeader from "@/components/crm/section-header";
import WorkspaceTile from "@/components/workspaces/workspace-tile";
import type { Viewer } from "@/components/crm/viewer";
import { SETTINGS_PATHS } from "@/lib/settings-nav";
import { cn } from "@/lib/utils";
import BarChartIcon from "@/public/assets/images/companies/sidebar/bar-chart.svg";
import BookIcon from "@/public/assets/images/companies/sidebar/book-closed.svg";
import CalendarIcon from "@/public/assets/images/companies/sidebar/calendar.svg";
import BrandIcon from "@/public/assets/images/settings/brand.svg";
import CodeIcon from "@/public/assets/images/settings/code.svg";
import FileTextIcon from "@/public/assets/images/settings/file-text.svg";
import LightbulbIcon from "@/public/assets/images/settings/lightbulb.svg";
import LinkIcon from "@/public/assets/images/settings/link.svg";
import ListIcon from "@/public/assets/images/companies/sidebar/list.svg";
import PlugIcon from "@/public/assets/images/settings/plug.svg";
import SlidersIcon from "@/public/assets/images/settings/sliders.svg";
import TagIcon from "@/public/assets/images/settings/tag.svg";
import UsersIcon from "@/public/assets/images/companies/sidebar/users.svg";
import SparkleIcon from "@/public/assets/images/assistant/sparkle.svg";

type NavItem = {
  href: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
};

const GROUPS: { label: string; workspace?: boolean; items: NavItem[] }[] = [
  {
    label: "You",
    items: [
      { href: SETTINGS_PATHS.general, label: "General", icon: SlidersIcon },
      { href: SETTINGS_PATHS.learning, label: "Learning", icon: LightbulbIcon },
    ],
  },
  {
    label: "Connections",
    items: [
      { href: SETTINGS_PATHS.integrations, label: "Integrations", icon: PlugIcon },
      { href: SETTINGS_PATHS.calendars, label: "Calendars", icon: CalendarIcon },
      { href: SETTINGS_PATHS.bookingPage, label: "Booking page", icon: LinkIcon },
    ],
  },
  {
    label: "Workspace",
    workspace: true,
    items: [
      { href: SETTINGS_PATHS.team, label: "Team", icon: UsersIcon },
      { href: SETTINGS_PATHS.brand, label: "Brand", icon: BrandIcon },
      { href: SETTINGS_PATHS.activity, label: "Activity log", icon: ListIcon },
      { href: SETTINGS_PATHS.pipeline, label: "Pipeline", icon: BarChartIcon },
      { href: SETTINGS_PATHS.tags, label: "Tags and lifecycles", icon: TagIcon },
      { href: SETTINGS_PATHS.aiFields, label: "AI fields", icon: SparkleIcon },
      { href: SETTINGS_PATHS.emailTemplates, label: "Templates and signatures", icon: FileTextIcon },
      { href: SETTINGS_PATHS.knowledge, label: "Knowledge", icon: BookIcon },
    ],
  },
  {
    label: "Developers",
    items: [{ href: SETTINGS_PATHS.api, label: "API and webhooks", icon: CodeIcon }],
  },
];

const NAV: NavItem[] = GROUPS.flatMap((group) => group.items);

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function SettingsShell({
  viewer,
  workspace,
  children,
}: {
  viewer: Viewer;
  workspace: { id: string; name: string };
  children: ReactNode;
}) {
  const pathname = usePathname();
  const tabs = useRef<HTMLUListElement>(null);
  const content = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = tabs.current;
    const active = list?.querySelector<HTMLElement>("[aria-current='page']");
    if (!active || !list || list.scrollWidth <= list.clientWidth) return;
    const left = (element: HTMLElement) => element.getBoundingClientRect().left - list.getBoundingClientRect().left + list.scrollLeft;
    const padding = parseFloat(getComputedStyle(list).paddingLeft);
    const links = [...list.querySelectorAll<HTMLElement>("a")];
    const index = links.indexOf(active);
    const activeEnd = left(active) + active.offsetWidth;
    const furthest = list.scrollWidth - list.clientWidth;
    const preferred = left(links[index - 1] ?? active) - padding;
    const clean = links
      .slice(0, index + 1)
      .map((link) => left(link) - padding)
      .filter((start) => start <= Math.min(preferred, furthest) && activeEnd - start <= list.clientWidth - padding);
    list.scrollLeft = clean.at(-1) ?? left(active) - padding;
  }, [pathname]);

  useEffect(() => {
    if (window.location.hash) return;
    content.current?.scrollTo({ top: 0 });
  }, [pathname]);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader title="Settings" viewer={viewer} />
      <nav
        aria-label="Settings sections"
        className="border-border shrink-0 border-b lg:hidden"
      >
        <ul
          ref={tabs}
          className="flex gap-1 overflow-x-auto px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {NAV.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <li key={item.href} className="shrink-0">
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "text-subtle hover:text-foreground focus-visible:ring-ring/60 flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] leading-none whitespace-nowrap transition-colors duration-150 outline-none focus-visible:ring-2",
                    active && "bg-muted text-foreground",
                  )}
                >
                  <item.icon aria-hidden className="size-3.5 shrink-0" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Settings sections"
          className="border-border hidden w-[15em] shrink-0 border-r lg:block"
        >
          <div className="flex flex-col gap-4 p-3">
          {GROUPS.map((group) => (
          <div key={group.label} className="flex flex-col gap-1">
          <h2 className="eyebrow-style text-subtle flex min-w-0 items-center gap-1.5 px-2 text-[11px]">
            {group.workspace ? (
              <>
                <WorkspaceTile id={workspace.id} name={workspace.name} className="size-3.5 rounded-[4px] text-[8px] tracking-normal" />
                <span className="truncate">{workspace.name}</span>
              </>
            ) : (
              group.label
            )}
          </h2>
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "text-sidebar-foreground hover:text-foreground focus-visible:ring-ring/60 flex h-[30px] items-center gap-2 rounded-lg px-2 text-[14px] leading-none transition-colors duration-150 outline-none focus-visible:ring-2",
                      active &&
                        "bg-sidebar-primary text-foreground shadow-[0px_0px_0px_1px_rgba(0,0,0,0.4),inset_0px_1px_0px_0px_rgba(255,255,255,0.1),inset_0px_0px_0px_1px_rgba(255,255,255,0.06)]",
                    )}
                  >
                    <item.icon aria-hidden className="size-3.5 shrink-0" />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
          </div>
          ))}
          </div>
        </nav>
        <div
          ref={content}
          className="min-h-0 min-w-0 flex-1 overflow-auto px-4 pt-6 pb-20 sm:px-6 lg:px-10 lg:pt-8"
        >
          {children}
        </div>
      </div>
    </section>
  );
}
