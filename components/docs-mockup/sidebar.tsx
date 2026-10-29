"use client";

import type { ComponentType, ReactNode, SVGProps } from "react";
import { usePathname } from "next/navigation";
import Button from "@/components/_ui/button";
import { ScrollArea } from "@/components/_ui/scroll-area";
import { Sheet, SheetCloseButton, SheetContent, SheetDescription, SheetTitle } from "@/components/_ui/sheet";
import SidebarNavItem from "@/components/_common/sidebar/sidebar-nav-item";
import SidebarResizer from "@/components/_common/sidebar/sidebar-resizer";
import SidebarSection from "@/components/_common/sidebar/sidebar-section";
import SidebarShortcuts from "@/components/_common/sidebar/sidebar-shortcuts";
import { CollapseSidebarButton } from "@/components/_common/sidebar/sidebar-toggle";
import { FOLDERS, TAGS, type Folder, type TagNode } from "@/components/docs-mockup/data";
import { PersonAvatar } from "@/components/docs-mockup/presence";
import { useCompaniesStore } from "@/stores/companies-store";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import Logo from "@/public/assets/images/_common/logo.svg";
import PlusIcon from "@/public/assets/images/_common/plus.svg";
import BookClosedIcon from "@/public/assets/images/companies/sidebar/book-closed.svg";
import BuildingIcon from "@/public/assets/images/companies/sidebar/building.svg";
import CalendarIcon from "@/public/assets/images/companies/sidebar/calendar.svg";
import ClipboardIcon from "@/public/assets/images/companies/sidebar/clipboard.svg";
import FileSignatureIcon from "@/public/assets/images/companies/sidebar/file-signature.svg";
import ListIcon from "@/public/assets/images/companies/sidebar/list.svg";
import MailIcon from "@/public/assets/images/companies/sidebar/mail.svg";
import MessageIcon from "@/public/assets/images/companies/sidebar/message-question.svg";
import TargetIcon from "@/public/assets/images/companies/sidebar/target-05.svg";
import UsersIcon from "@/public/assets/images/companies/sidebar/users.svg";
import ZapIcon from "@/public/assets/images/companies/sidebar/zap.svg";
import AlertIcon from "@/public/assets/images/companies/sidebar/alert-triangle.svg";
import InboxIcon from "@/public/assets/images/mail/inbox.svg";
import FolderIcon from "@/public/assets/images/mail/folder.svg";
import DocIcon from "@/public/assets/images/docs/doc.svg";
import HashIcon from "@/public/assets/images/docs/hash.svg";
import SunIcon from "@/public/assets/images/docs/sun.svg";

export type SidebarFocus = { kind: "daily" } | { kind: "folder"; id: string } | { kind: "tag"; name: string } | { kind: "none" };

function TreeRow({
  icon: Icon,
  label,
  depth = 0,
  active = false,
  open,
  trailing,
  iconClassName,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: ReactNode;
  depth?: number;
  active?: boolean;
  open?: boolean;
  trailing?: ReactNode;
  iconClassName?: string;
}) {
  return (
    <li className="relative">
      <Button
        variant="nav"
        size="md"
        data-active={active}
        aria-current={active ? "page" : undefined}
        aria-expanded={open}
        className="group h-7 gap-1.5 py-0 text-[13.5px] data-[active=true]:h-7"
        style={depth ? { paddingLeft: `${0.5 + depth * 0.875}rem` } : undefined}
      >
        <Icon
          aria-hidden
          className={cn("text-subtle group-hover:text-icon group-data-[active=true]:text-icon size-3.5 shrink-0 transition-colors duration-150", iconClassName)}
        />
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        {open !== undefined && (
          <ChevronDownIcon aria-hidden className={cn("text-faint size-3 shrink-0 transition-transform duration-150", !open && "-rotate-90")} />
        )}
        {trailing}
      </Button>
    </li>
  );
}

function SharedMark({ folder }: { folder: Folder }) {
  if (!folder.shared) return null;
  if (folder.owner) {
    return (
      <span className="flex shrink-0 items-center" title={`Shared by ${folder.owner.name}`}>
        <span className="sr-only">Shared by {folder.owner.name}</span>
        <PersonAvatar person={folder.owner} size="xs" />
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center" title="Shared with workspace">
      <span className="sr-only">Shared with workspace</span>
      <UsersIcon aria-hidden className="text-faint size-3.5" />
    </span>
  );
}

function TagRows({ tags, depth, focus }: { tags: TagNode[]; depth: number; focus: SidebarFocus }) {
  return tags.map((tag) => (
    <TagBranch key={tag.name} tag={tag} depth={depth} focus={focus} path={tag.name} />
  ));
}

function TagBranch({ tag, depth, focus, path }: { tag: TagNode; depth: number; focus: SidebarFocus; path: string }) {
  return (
    <>
      <TreeRow
        icon={HashIcon}
        label={tag.name}
        depth={depth}
        active={focus.kind === "tag" && focus.name === path}
        open={tag.children ? Boolean(tag.open) : undefined}
      />
      {tag.open &&
        tag.children?.map((child) => (
          <TagBranch key={child.name} tag={child} depth={depth + 1} focus={focus} path={`${path}/${child.name}`} />
        ))}
    </>
  );
}

function DocsTree({ focus }: { focus: SidebarFocus }) {
  return (
    <SidebarSection className="border-sidebar-border border-b">
      <SidebarNavItem
        href="/docs-mockup/main"
        icon={DocIcon}
        label="Docs"
        accessory={
          <Button variant="ghost" size="icon-sm" aria-label="New note" title="New note (⌘N)" className="size-5 rounded-md">
            <PlusIcon aria-hidden className="size-3" />
          </Button>
        }
      />
      <li>
        <ul aria-label="Docs" className="border-sidebar-border mb-1 ml-[15px] flex flex-col border-l pl-1.5">
          <TreeRow
            icon={SunIcon}
            label="Daily notes"
            active={focus.kind === "daily"}
            trailing={<span className="caption-style text-subtle shrink-0 tabular-nums">29</span>}
          />
          {FOLDERS.map((folder) => (
            <TreeRow
              key={folder.id}
              icon={FolderIcon}
              label={folder.name}
              active={focus.kind === "folder" && focus.id === folder.id}
              trailing={<SharedMark folder={folder} />}
            />
          ))}
          <li aria-hidden className="h-1.5" />
          <li className="flex h-6 items-center px-2">
            <span className="eyebrow-style text-faint text-[11px]">Tags</span>
          </li>
          <TagRows tags={TAGS} depth={0} focus={focus} />
        </ul>
      </li>
    </SidebarSection>
  );
}

function Content({ focus }: { focus: SidebarFocus }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-sidebar-border bg-sidebar-accent flex shrink-0 items-center gap-2 border-b p-3">
        <Logo aria-hidden className="size-8 shrink-0 overflow-visible" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="lead-style block truncate font-medium tracking-[-0.01em]">Orbit</span>
          <span className="caption-style text-subtle block truncate">Eclipse</span>
        </div>
        <CollapseSidebarButton />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <nav aria-label="Primary">
          <SidebarSection className="border-sidebar-border border-b">
            <SidebarNavItem href="/mail" icon={InboxIcon} label="Mail" count={8} />
            <SidebarNavItem href="/" icon={BuildingIcon} label="Companies" count={214} />
            <SidebarNavItem href="/contacts" icon={BookClosedIcon} label="Contacts" />
            <SidebarNavItem href="/capture" icon={MailIcon} label="Capture" />
            <SidebarNavItem href="/calendar" icon={CalendarIcon} label="Calendar" />
            <SidebarNavItem
              href="/opportunities"
              icon={ClipboardIcon}
              label="Opportunities"
              accessory={
                <Button variant="ghost" size="icon-sm" aria-label="Show boards" aria-expanded={false} className="size-5 rounded-md">
                  <ChevronDownIcon aria-hidden className="size-3 -rotate-90" />
                </Button>
              }
            />
            <SidebarNavItem href="/proposals" icon={FileSignatureIcon} label="Proposals" />
            <SidebarNavItem href="/activities" icon={ListIcon} label="Activities" />
            <SidebarNavItem href="/tasks" icon={TargetIcon} label="Tasks" count={6} />
            <SidebarNavItem href="/workflows" icon={ZapIcon} label="Workflows" />
            <SidebarNavItem href="/quiet" icon={AlertIcon} label="Quiet" />
          </SidebarSection>
          <DocsTree focus={focus} />
        </nav>
      </ScrollArea>
      <SidebarSection className="border-sidebar-border shrink-0 border-t">
        <SidebarNavItem href="/settings" icon={MessageIcon} label="Settings" />
        <SidebarShortcuts />
        <Button variant="nav" size="md" className="text-subtle h-[30px] justify-start">
          Account
        </Button>
      </SidebarSection>
    </div>
  );
}

export default function DocsMockupSidebar() {
  const sidebarOpen = useCompaniesStore((state) => state.sidebarOpen);
  const setSidebarOpen = useCompaniesStore((state) => state.setSidebarOpen);
  const focus = focusFor(usePathname());
  return (
    <>
      <aside className="relative hidden w-(--sidebar-width) shrink-0 border-r border-sidebar-border bg-sidebar sidebar-collapsed:lg:hidden lg:flex lg:flex-col">
        <Content focus={focus} />
        <SidebarResizer />
      </aside>
      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent side="left" className="w-[254px] max-w-[85vw] border-sidebar-border bg-sidebar">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Companies, contacts, opportunities, docs and tasks.</SheetDescription>
          <SheetCloseButton label="Close menu" className="absolute top-3 right-3 z-10 mr-0" />
          <Content focus={focus} />
        </SheetContent>
      </Sheet>
    </>
  );
}

export function focusFor(pathname: string): SidebarFocus {
  const screen = pathname.split("/").pop() ?? "";
  if (screen === "daily") return { kind: "daily" };
  if (screen === "share") return { kind: "folder", id: "clients" };
  if (screen.startsWith("phone")) return { kind: "folder", id: "partnerships" };
  return { kind: "folder", id: "partnerships" };
}
