"use client";

import type { ComponentType, SVGProps } from "react";
import Button from "@/components/_ui/button";
import HoldButton from "@/components/_ui/hold-button";
import SectionHeader from "@/components/crm/section-header";
import { SettingsCard, SettingsPage } from "@/components/crm/settings-ui";
import type { Viewer } from "@/components/crm/viewer";
import WorkspaceTile from "@/components/workspaces/workspace-tile";
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
import ExternalIcon from "@/public/assets/images/booking/external.svg";
import { ECLIPSE, RIDGEON, type MockWorkspace } from "./mock-data";

type NavItem = { label: string; icon: ComponentType<SVGProps<SVGSVGElement>>; active?: boolean };

const GROUPS: { label: string; workspace?: boolean; items: NavItem[] }[] = [
  { label: "You", items: [{ label: "General", icon: SlidersIcon }, { label: "Learning", icon: LightbulbIcon }] },
  {
    label: "Connections",
    items: [
      { label: "Integrations", icon: PlugIcon, active: true },
      { label: "Calendars", icon: CalendarIcon },
      { label: "Booking page", icon: LinkIcon },
    ],
  },
  {
    label: "Workspace",
    workspace: true,
    items: [
      { label: "Team", icon: UsersIcon },
      { label: "Brand", icon: BrandIcon },
      { label: "Activity log", icon: ListIcon },
      { label: "Pipeline", icon: BarChartIcon },
      { label: "Tags and lifecycles", icon: TagIcon },
      { label: "AI fields", icon: SparkleIcon },
      { label: "Templates and signatures", icon: FileTextIcon },
      { label: "Knowledge", icon: BookIcon },
    ],
  },
  { label: "Developers", items: [{ label: "API and webhooks", icon: CodeIcon }] },
];

const ACTIVE_RING =
  "bg-sidebar-primary text-foreground shadow-[0px_0px_0px_1px_rgba(0,0,0,0.4),inset_0px_1px_0px_0px_rgba(255,255,255,0.1),inset_0px_0px_0px_1px_rgba(255,255,255,0.06)]";

type Browser = { name: string; workspaces: MockWorkspace[]; connected: string; used: string; on: boolean };

const BROWSERS: Browser[] = [
  { name: "Chrome on MacBook Pro", workspaces: [ECLIPSE, RIDGEON], connected: "6 Nov 2026", used: "Used today at 08:14", on: true },
  { name: "Chrome on Mac mini", workspaces: [ECLIPSE], connected: "21 Oct 2026", used: "Last used 2 Nov", on: false },
];

function BrowserRow({ browser }: { browser: Browser }) {
  return (
    <li className="border-border flex flex-wrap items-center justify-between gap-3 border-t py-3 first:border-t-0 first:pt-0 last:pb-0">
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-[14px] leading-5">{browser.name}</span>
        <span className="caption-style text-subtle flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="flex items-center gap-1.5">
            <span aria-hidden className={cn("size-1.5 rounded-full", browser.on ? "bg-success" : "bg-faint")} />
            {browser.used}
          </span>
          <span>· Connected {browser.connected}</span>
        </span>
        <span className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {browser.workspaces.map((workspace) => (
            <span key={workspace.id} className="caption-style text-soft flex items-center gap-1.5 rounded-md bg-white/[0.04] py-0.5 pr-2 pl-0.5">
              <WorkspaceTile id={workspace.id} name={workspace.name} className="size-4 rounded-[4px] text-[9px]" />
              {workspace.name}
            </span>
          ))}
        </span>
      </span>
      <span className="flex items-center gap-1">
        <Button variant="ghost" size="sm">
          Workspaces
        </Button>
        <HoldButton onConfirm={() => undefined}>
          Hold to revoke<span className="sr-only"> {browser.name}</span>
        </HoldButton>
      </span>
    </li>
  );
}

export default function SettingsMock({ viewer, workspace }: { viewer: Viewer; workspace: { id: string; name: string } }) {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader title="Settings" viewer={viewer} />
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Settings sections" className="border-border hidden w-[15em] shrink-0 border-r lg:block">
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
                  {group.items.map((item) => (
                    <li key={item.label}>
                      <a
                        href="#"
                        aria-current={item.active ? "page" : undefined}
                        className={cn("text-sidebar-foreground flex h-[30px] items-center gap-2 rounded-lg px-2 text-[14px] leading-none", item.active && ACTIVE_RING)}
                      >
                        <item.icon aria-hidden className="size-3.5 shrink-0" />
                        {item.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-auto px-4 pt-6 pb-20 sm:px-6 lg:px-10 lg:pt-8">
          <SettingsPage title="Integrations" description="The services Orbit reads from and writes to, and where to manage each one.">
            <SettingsCard
              id="linkedin-capture"
              title="LinkedIn capture"
              description="A Chrome extension that saves people and companies from LinkedIn and Sales Navigator, and logs conversations when you press Log. Each browser is connected as you."
              action={
                <Button variant="secondary" size="sm">
                  Get the extension
                  <ExternalIcon aria-hidden className="size-3" />
                </Button>
              }
            >
              <ul aria-label="Connected browsers" className="flex flex-col">
                {BROWSERS.map((browser) => (
                  <BrowserRow key={browser.name} browser={browser} />
                ))}
              </ul>
              <p className="caption-style text-subtle leading-[1.4]">
                To connect another browser, install the extension and press Connect. Revoking signs that browser out straight away.
              </p>
            </SettingsCard>
            <SettingsCard
              id="recall"
              title="Recall"
              description="The assistant can search and read your Recall when you ask. Nothing is copied into Orbit."
            >
              <span className="caption-style text-subtle flex items-center gap-1.5">
                <span aria-hidden className="bg-success size-1.5 shrink-0 rounded-full" />
                Connected · key ending 4f2a
              </span>
            </SettingsCard>
          </SettingsPage>
        </div>
      </div>
    </section>
  );
}
