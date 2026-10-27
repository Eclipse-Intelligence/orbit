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
import type { Viewer } from "@/components/crm/viewer";
import { SETTINGS_PATHS } from "@/lib/settings-nav";
import { cn } from "@/lib/utils";
import BarChartIcon from "@/public/assets/images/companies/sidebar/bar-chart.svg";
import BookIcon from "@/public/assets/images/companies/sidebar/book-closed.svg";
import CalendarIcon from "@/public/assets/images/companies/sidebar/calendar.svg";
import CodeIcon from "@/public/assets/images/settings/code.svg";
import FileTextIcon from "@/public/assets/images/settings/file-text.svg";
import LightbulbIcon from "@/public/assets/images/settings/lightbulb.svg";
import LinkIcon from "@/public/assets/images/settings/link.svg";
import PlugIcon from "@/public/assets/images/settings/plug.svg";
import SlidersIcon from "@/public/assets/images/settings/sliders.svg";
import TagIcon from "@/public/assets/images/settings/tag.svg";
import UsersIcon from "@/public/assets/images/companies/sidebar/users.svg";

type NavItem = {
  href: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
};

const GROUPS: { label: string; items: NavItem[] }[] = [
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
    items: [
      { href: SETTINGS_PATHS.team, label: "Team", icon: UsersIcon },
      { href: SETTINGS_PATHS.pipeline, label: "Pipeline", icon: BarChartIcon },
      { href: SETTINGS_PATHS.tags, label: "Tags and lifecycles", icon: TagIcon },
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
  children,
}: {
  viewer: Viewer;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const tabs = useRef<HTMLUListElement>(null);
  const content = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const active = tabs.current?.querySelector<HTMLElement>(
      "[aria-current='page']",
    );
    if (
      !active ||
      !tabs.current ||
      tabs.current.scrollWidth <= tabs.current.clientWidth
    )
      return;
    active.scrollIntoView({ block: "nearest", inline: "center" });
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
          <h2 className="eyebrow-style text-subtle px-2 text-[11px]">{group.label}</h2>
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
