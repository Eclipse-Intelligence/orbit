"use client";

import type { ComponentType, SVGProps } from "react";
import Button from "@/components/_ui/button";
import HoldButton from "@/components/_ui/hold-button";
import Switch from "@/components/_ui/switch";
import { RecordTag } from "@/components/beautifui/record-marks";
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
import PlusIcon from "@/public/assets/images/_common/plus.svg";
import { FIELDS, TAG_RULES, type AiField } from "./mock-data";

type NavItem = { label: string; icon: ComponentType<SVGProps<SVGSVGElement>>; active?: boolean };

const GROUPS: { label: string; workspace?: boolean; items: NavItem[] }[] = [
  { label: "You", items: [{ label: "General", icon: SlidersIcon }, { label: "Learning", icon: LightbulbIcon }] },
  {
    label: "Connections",
    items: [
      { label: "Integrations", icon: PlugIcon },
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
      { label: "AI fields", icon: SparkleIcon, active: true },
      { label: "Templates and signatures", icon: FileTextIcon },
      { label: "Knowledge", icon: BookIcon },
    ],
  },
  { label: "Developers", items: [{ label: "API and webhooks", icon: CodeIcon }] },
];

const ACTIVE_RING =
  "bg-sidebar-primary text-foreground shadow-[0px_0px_0px_1px_rgba(0,0,0,0.4),inset_0px_1px_0px_0px_rgba(255,255,255,0.1),inset_0px_0px_0px_1px_rgba(255,255,255,0.06)]";

const TYPE_LABELS: Record<AiField["type"], string> = { yesno: "Yes or no", number: "Number", text: "Short text", pick: "Pick from list" };

function Coverage({ done, total, filling }: { done: number; total: number; filling: boolean }) {
  return (
    <span aria-hidden className="bg-white/8 block h-1 w-full max-w-[12rem] overflow-hidden rounded-full">
      <span className={cn("block h-full rounded-full", filling ? "bg-primary" : "bg-success")} style={{ width: `${Math.round((done / total) * 100)}%` }} />
    </span>
  );
}

function FieldRow({ field }: { field: AiField }) {
  const filling = field.status === "filling";
  return (
    <li className="border-border flex flex-col gap-2.5 border-t py-3 first:border-t-0 first:pt-0">
      <div className="flex items-start justify-between gap-3">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-foreground text-[13.5px] leading-5">
            {field.label}
            <span className="text-subtle"> · {TYPE_LABELS[field.type]}</span>
          </span>
          <span className="caption-style text-subtle leading-[1.4]">{field.question}</span>
          {field.options && <span className="caption-style text-subtle leading-[1.4]">{field.options.join(", ")}</span>}
        </span>
        <span className="caption-style text-subtle flex shrink-0 items-center gap-2">
          <span aria-hidden>Keep up to date</span>
          <Switch checked={field.status !== "paused"} label={`Keep ${field.label} up to date`} onChange={() => undefined} />
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <Coverage done={filling ? field.filled ?? 0 : field.answered} total={field.total} filling={filling} />
        <span className="caption-style text-soft">
          {filling ? `Filling: ${field.filled} of ${field.total} checked, ${field.answered} answered` : `${field.answered} of ${field.total} answered`}
          <span className="text-subtle">
            {" "}
            · {field.scope} · {field.refresh}, last run {field.lastRun}
          </span>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <Button variant="secondary" size="sm">
          Edit
        </Button>
        <Button variant="ghost" size="sm" disabled={filling}>
          Check all again
        </Button>
        <span className="ml-auto">
          <HoldButton onConfirm={() => undefined}>
            Hold to delete<span className="sr-only"> {field.label}</span>
          </HoldButton>
        </span>
      </div>
    </li>
  );
}

function FitRow() {
  return (
    <li className="border-border flex items-start justify-between gap-3 border-t py-3">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-foreground text-[13.5px] leading-5">
          Fit<span className="text-subtle"> · Score 0 to 4 · Built in</span>
        </span>
        <span className="caption-style text-subtle leading-[1.4]">How well each company matches your ideal customer. Set up in Integrations, Web checks.</span>
      </span>
      <Button variant="ghost" size="sm">
        Open
      </Button>
    </li>
  );
}

export default function SettingsMock({ viewer, workspace }: { viewer: Viewer; workspace: { id: string; name: string } }) {
  const items = GROUPS.flatMap((group) => group.items);
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader title="Settings" viewer={viewer} />
      <nav aria-label="Settings sections" className="border-border shrink-0 border-b lg:hidden">
        <ul className="flex gap-1 overflow-x-auto px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" ref={(list) => {
          const active = list?.querySelector<HTMLElement>("[aria-current='page']");
          if (list && active) list.scrollLeft = active.offsetLeft - 48;
        }}>
          {items.map((item) => (
            <li key={item.label} className="shrink-0">
              <a
                href="#"
                aria-current={item.active ? "page" : undefined}
                className={cn(
                  "text-subtle flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] leading-none whitespace-nowrap",
                  item.active && "bg-muted text-foreground",
                )}
              >
                <item.icon aria-hidden className="size-3.5 shrink-0" />
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
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
          <SettingsPage
            title="AI fields"
            description="Questions answered for every company from the web, shown as columns on Companies."
            action={
              <Button variant="primary" size="sm">
                <PlusIcon aria-hidden className="size-3" />
                Add AI field
              </Button>
            }
          >
            <SettingsCard title="Fields" description="Checked by Parallel. This month: $2.41 so far. Next refresh 3 Dec.">
              <ul className="flex flex-col">
                {FIELDS.map((field) => (
                  <FieldRow key={field.key} field={field} />
                ))}
                <FitRow />
              </ul>
            </SettingsCard>
            <SettingsCard
              title="Tag rules"
              description="Your tag rules in Integrations, Web checks still tag new companies. Show one as a column to see Yes, No or Unknown for every company, with sources. The rule keeps tagging."
            >
              <ul className="flex flex-col">
                {TAG_RULES.map((rule) => (
                  <li key={rule.label} className="border-border flex items-start justify-between gap-3 border-t py-2.5 first:border-t-0 first:pt-0">
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="flex items-center gap-2">
                        <RecordTag label={rule.label} />
                        <span className="caption-style text-subtle">{rule.tagged} tagged</span>
                      </span>
                      <span className="caption-style text-subtle leading-[1.4]">{rule.question}</span>
                    </span>
                    <Button variant="secondary" size="sm">
                      Show as column
                    </Button>
                  </li>
                ))}
              </ul>
            </SettingsCard>
          </SettingsPage>
        </div>
      </div>
    </section>
  );
}
