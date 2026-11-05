"use client";

import { useEffect, useRef, type ComponentType, type ReactNode, type SVGProps } from "react";
import Link from "next/link";
import Button from "@/components/_ui/button";
import { Checkbox } from "@/components/_ui/checkbox";
import Field from "@/components/_ui/field";
import { Input } from "@/components/_ui/input";
import { NativeSelect } from "@/components/_ui/native-select";
import Switch from "@/components/_ui/switch";
import Tag from "@/components/_ui/tag";
import { Textarea } from "@/components/_ui/textarea";
import SectionHeader from "@/components/crm/section-header";
import { SettingsCard, SettingsDisclosure, SettingsPage } from "@/components/crm/settings-ui";
import { cn } from "@/lib/utils";
import ChevronRightIcon from "@/public/assets/images/_common/chevron-right.svg";
import BarChartIcon from "@/public/assets/images/companies/sidebar/bar-chart.svg";
import BookIcon from "@/public/assets/images/companies/sidebar/book-closed.svg";
import CalendarIcon from "@/public/assets/images/companies/sidebar/calendar.svg";
import ListIcon from "@/public/assets/images/companies/sidebar/list.svg";
import UsersIcon from "@/public/assets/images/companies/sidebar/users.svg";
import BrandIcon from "@/public/assets/images/settings/brand.svg";
import CodeIcon from "@/public/assets/images/settings/code.svg";
import FileTextIcon from "@/public/assets/images/settings/file-text.svg";
import LightbulbIcon from "@/public/assets/images/settings/lightbulb.svg";
import LinkIcon from "@/public/assets/images/settings/link.svg";
import PlugIcon from "@/public/assets/images/settings/plug.svg";
import SlidersIcon from "@/public/assets/images/settings/sliders.svg";
import TagIcon from "@/public/assets/images/settings/tag.svg";
import { VIEWER, type MockWorkspace } from "./mock-data";
import { WorkspaceTile } from "./mock-shell";

type NavItem = { id: string; label: string; icon: ComponentType<SVGProps<SVGSVGElement>> };

function groups(workspace: MockWorkspace): { label: ReactNode; items: NavItem[] }[] {
  return [
    {
      label: "You",
      items: [
        { id: "general", label: "General", icon: SlidersIcon },
        { id: "learning", label: "Learning", icon: LightbulbIcon },
      ],
    },
    {
      label: "Connections",
      items: [
        { id: "integrations", label: "Integrations", icon: PlugIcon },
        { id: "calendars", label: "Calendars", icon: CalendarIcon },
        { id: "booking", label: "Booking page", icon: LinkIcon },
      ],
    },
    {
      label: (
        <span className="flex items-center gap-1.5">
          <WorkspaceTile workspace={workspace} className="size-3.5 rounded-[4px] text-[8px] tracking-normal" />
          {workspace.name}
        </span>
      ),
      items: [
        { id: "team", label: "Team", icon: UsersIcon },
        { id: "brand", label: "Brand", icon: BrandIcon },
        { id: "activity", label: "Activity log", icon: ListIcon },
        { id: "pipeline", label: "Pipeline", icon: BarChartIcon },
        { id: "tags", label: "Tags and lifecycles", icon: TagIcon },
        { id: "templates", label: "Templates and signatures", icon: FileTextIcon },
        { id: "knowledge", label: "Knowledge", icon: BookIcon },
      ],
    },
    {
      label: "Developers",
      items: [{ id: "api", label: "API and webhooks", icon: CodeIcon }],
    },
  ];
}

function SettingsShellMock({ workspace, active, children }: { workspace: MockWorkspace; active: string; children: ReactNode }) {
  const tabs = useRef<HTMLUListElement>(null);
  const sections = groups(workspace);
  const nav = sections.flatMap((group) => group.items);

  useEffect(() => {
    const list = tabs.current;
    const current = list?.querySelector<HTMLElement>("[aria-current='page']");
    if (!current || !list || list.scrollWidth <= list.clientWidth) return;
    const offset = current.getBoundingClientRect().left - list.getBoundingClientRect().left + list.scrollLeft;
    list.scrollLeft = offset - (list.clientWidth - current.offsetWidth) / 2;
  }, []);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader title="Settings" viewer={VIEWER} />
      <nav aria-label="Settings sections" className="border-border shrink-0 border-b lg:hidden">
        <ul ref={tabs} className="flex gap-1 overflow-x-auto px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {nav.map((item) => (
            <li key={item.id} className="shrink-0">
              <Link
                href={`#${item.id}`}
                aria-current={item.id === active ? "page" : undefined}
                className={cn(
                  "text-subtle hover:text-foreground focus-visible:ring-ring/60 flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] leading-none whitespace-nowrap transition-colors duration-150 outline-none focus-visible:ring-2",
                  item.id === active && "bg-muted text-foreground",
                )}
              >
                <item.icon aria-hidden className="size-3.5 shrink-0" />
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Settings sections" className="border-border hidden w-[15em] shrink-0 border-r lg:block">
          <div className="flex flex-col gap-4 p-3">
            {sections.map((group, index) => (
              <div key={index} className="flex flex-col gap-1">
                <h2 className="eyebrow-style text-subtle px-2 text-[11px]">{group.label}</h2>
                <ul className="flex flex-col gap-0.5">
                  {group.items.map((item) => (
                    <li key={item.id}>
                      <Link
                        href={`#${item.id}`}
                        aria-current={item.id === active ? "page" : undefined}
                        className={cn(
                          "text-sidebar-foreground hover:text-foreground focus-visible:ring-ring/60 flex h-[30px] items-center gap-2 rounded-lg px-2 text-[14px] leading-none transition-colors duration-150 outline-none focus-visible:ring-2",
                          item.id === active &&
                            "bg-sidebar-primary text-foreground shadow-[0px_0px_0px_1px_rgba(0,0,0,0.4),inset_0px_1px_0px_0px_rgba(255,255,255,0.1),inset_0px_0px_0px_1px_rgba(255,255,255,0.06)]",
                        )}
                      >
                        <item.icon aria-hidden className="size-3.5 shrink-0" />
                        {item.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </nav>
        <div data-settings-scroll="" className="min-h-0 min-w-0 flex-1 overflow-auto px-4 pt-6 pb-20 sm:px-6 lg:px-10 lg:pt-8">
          {children}
        </div>
      </div>
    </section>
  );
}

const BRAND_COPY = {
  ridgeon: {
    website: "ridgeon.me",
    sell: "Positioning and messaging for B2B companies. A two-week sprint to find the story, then a monthly retainer so sales and marketing keep telling it the same way.",
    who: "UK B2B firms of 50 to 500 staff, just after a raise, a new CEO or a move into a new market. The buyer is the CMO or founder, and the head of sales has a say.",
    tone: "Plain, warm and senior. Short paragraphs, one ask per email. No agency jargon and no \"hope you're well\".",
    proof: "4 client results the assistant may quote",
    playbook: "How first emails to prospects are researched and written. Edited 2 Nov.",
    knowledge: "6 documents and links",
  },
  eclipse: {
    website: "geteclipse.co",
    sell: "Eclipse, a content and intelligence platform. B2B teams and agencies plan, write and publish cited content, and see where they show up in AI answers.",
    who: "First, founder-led UK content and SEO agencies of 5 to 30 staff adding AI visibility work. Second, UK B2B firms of 50 to 500 staff with a named content owner.",
    tone: "Direct and specific. Lead with one thing they don't know, keep it under 120 words, sign off as Mark.",
    proof: "12 client results the assistant may quote",
    playbook: "How first emails to prospects are researched and written. Edited 28 Oct.",
    knowledge: "41 documents and links",
  },
};

export function BrandMock({ workspace, focusTools = false }: { workspace: MockWorkspace; focusTools?: boolean }) {
  const copy = BRAND_COPY[workspace.id];
  const inEclipse = workspace.id === "eclipse";

  useEffect(() => {
    if (!focusTools) return;
    document.getElementById("eclipse-tools")?.scrollIntoView({ block: "center" });
  }, [focusTools]);

  return (
    <SettingsShellMock workspace={workspace} active="brand">
      <SettingsPage title="Brand" description={`What the assistant knows about ${workspace.name} when it writes, researches and drafts cold email.`}>
        <SettingsCard
          id="brand-profile"
          title="Brand profile"
          description={`Used by the assistant in ${workspace.name} only. About you, signatures and AI accounts are yours and stay the same in every workspace.`}
        >
          <form className="flex flex-col gap-4" noValidate>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <Field label="Website" htmlFor="brand-website" className="flex-1">
                <Input id="brand-website" type="url" inputMode="url" defaultValue={copy.website} spellCheck={false} />
              </Field>
              <Button variant="secondary" size="sm" className="h-9 self-start sm:self-auto">
                Draft from website
              </Button>
            </div>
            <Field label="What you sell" htmlFor="brand-sell" hint="Your offer, in a sentence or two. The assistant never pitches it back to a prospect who sells the same.">
              <Textarea id="brand-sell" rows={3} defaultValue={copy.sell} className="field-sizing-content" />
            </Field>
            <Field label="Who it's for" htmlFor="brand-who" hint="Your ideal customer: size, sector, trigger and who signs.">
              <Textarea id="brand-who" rows={3} defaultValue={copy.who} className="field-sizing-content" />
            </Field>
            <Field label="How you write" htmlFor="brand-tone" hint="Tone for email in this workspace. Adds to How you write in General.">
              <Textarea id="brand-tone" rows={2} defaultValue={copy.tone} className="field-sizing-content" />
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" size="sm" type="submit">
                Save brand profile
              </Button>
            </div>
          </form>
        </SettingsCard>

        <SettingsCard id="brand-material" title="Proof, playbook and Knowledge" description={`${workspace.name}'s own. Nothing here is shared with your other workspace.`}>
          <ul className="-my-1 flex flex-col">
            {[
              { title: "Proof list", caption: copy.proof, action: "Open" },
              { title: "Cold email playbook", caption: copy.playbook, action: "Edit" },
              { title: "Knowledge", caption: copy.knowledge, action: "Open" },
            ].map((row) => (
              <li key={row.title} className="border-border flex items-center gap-3 border-b py-3 last:border-b-0">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[14px] leading-5">{row.title}</span>
                  <span className="caption-style text-subtle">{row.caption}</span>
                </span>
                <Button variant="secondary" size="sm" href={`#${row.title}`} aria-label={`${row.action} ${row.title}`}>
                  {row.action}
                  <ChevronRightIcon aria-hidden className="text-subtle size-3" />
                </Button>
              </li>
            ))}
          </ul>
        </SettingsCard>

        <SettingsCard
          id="eclipse-tools"
          title="Eclipse tools"
          description={
            inEclipse
              ? "Lets the assistant read Eclipse articles, docs and product facts. On in this workspace only."
              : "Eclipse articles, docs and product facts. Only for the Eclipse workspace, so the assistant never pitches Eclipse here."
          }
          action={
            <span className="flex items-center gap-2">
              <span className="caption-style text-subtle">{inEclipse ? "On" : "Off"}</span>
              <Switch checked={inEclipse} onChange={() => undefined} disabled={!inEclipse} label="Eclipse tools" />
            </span>
          }
        />
      </SettingsPage>
    </SettingsShellMock>
  );
}

const MEMBERS = [
  { id: "mark", name: "Mark Ridgeon", email: "mark@ridgeon.me", joined: "Wed 5 Nov", role: "owner" as const },
  { id: "hannah", name: "Hannah Cole", email: "hannah@ridgeon.me", joined: "Wed 5 Nov", role: "member" as const },
];

export function TeamMock({ workspace }: { workspace: MockWorkspace }) {
  return (
    <SettingsShellMock workspace={workspace} active="team">
      <SettingsPage title="Team" description={`Who's in ${workspace.name}, what they can do, and inviting someone new.`}>
        <SettingsCard
          id="people"
          title={`People in ${workspace.name}`}
          description={`They see and work on ${workspace.name}'s companies, contacts, deals, boards and activity, and nothing from Eclipse. Each person connects their own email, calendar and AI account.`}
        >
          <ul className="flex flex-col">
            {MEMBERS.map((member) => (
              <li key={member.id} className="border-border flex flex-wrap items-center gap-3 border-b py-3 last:border-b-0">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[14px] leading-5">
                    {member.name}
                    {member.id === "mark" && <span className="text-subtle"> (you)</span>}
                  </span>
                  <span className="caption-style text-subtle truncate">
                    {member.email} · Joined {member.joined}
                  </span>
                </span>
                {member.role === "owner" ? (
                  <Tag tone="purple">Owner</Tag>
                ) : (
                  <>
                    <NativeSelect aria-label={`${member.name}'s role`} defaultValue="member" className="h-8 w-auto">
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                    </NativeSelect>
                    <Button variant="ghost" size="sm" className="text-danger">
                      Remove
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </SettingsCard>

        <SettingsCard id="invite" title="Invite someone" description={`They get a link to join ${workspace.name} only. Your other workspace stays hidden from them.`}>
          <form className="flex flex-col gap-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input type="email" aria-label="Email address" placeholder="name@company.com" className="sm:flex-1" />
              <NativeSelect aria-label="Role" defaultValue="member" className="sm:w-36">
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </NativeSelect>
              <Button variant="primary" size="sm" type="submit" className="h-9">
                Invite
              </Button>
            </div>
            <label className="caption-style text-subtle flex items-center gap-2">
              <Checkbox defaultChecked />
              Email the invite from mark@ridgeon.me
            </label>
          </form>
          <div className="flex flex-col gap-1">
            <span className="caption-style text-subtle">Waiting to join</span>
            <ul className="flex flex-col">
              <li className="border-border flex flex-wrap items-center gap-3 border-b py-2.5 last:border-b-0">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[14px] leading-5">ben@northfold.co</span>
                  <span className="caption-style text-subtle">Member · Expires Wed 12 Nov</span>
                </span>
                <Button variant="ghost" size="sm">
                  New link
                </Button>
                <Button variant="ghost" size="sm" className="text-danger">
                  Cancel
                </Button>
              </li>
            </ul>
          </div>
          <SettingsDisclosure title="What each role can do" summary="Members, admins and the owner.">
            <p className="caption-style text-subtle">Same roles as every workspace.</p>
          </SettingsDisclosure>
        </SettingsCard>
      </SettingsPage>
    </SettingsShellMock>
  );
}
