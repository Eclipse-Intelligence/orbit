"use client";

import type { ComponentType, ReactNode, SVGProps } from "react";
import Button from "@/components/_ui/button";
import { Kbd } from "@/components/_ui/command";
import SectionHeader from "@/components/crm/section-header";
import { Monogram } from "@/components/beautifui/record-marks";
import { MOCK_VIEWER, PEOPLE, type NoteRow, type Person } from "@/components/docs-mockup/data";
import { PersonAvatar, PresenceStack } from "@/components/docs-mockup/presence";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import ChevronRightIcon from "@/public/assets/images/_common/chevron-right.svg";
import MoreIcon from "@/public/assets/images/_common/more.svg";
import PlusIcon from "@/public/assets/images/_common/plus.svg";
import SearchIcon from "@/public/assets/images/_common/search.svg";
import UsersIcon from "@/public/assets/images/companies/sidebar/users.svg";
import BuildingIcon from "@/public/assets/images/companies/sidebar/building.svg";
import ClipboardIcon from "@/public/assets/images/companies/sidebar/clipboard.svg";
import FolderIcon from "@/public/assets/images/mail/folder.svg";
import DocIcon from "@/public/assets/images/docs/doc.svg";
import HistoryIcon from "@/public/assets/images/docs/history.svg";
import LockIcon from "@/public/assets/images/docs/lock.svg";
import PanelRightIcon from "@/public/assets/images/docs/panel-right.svg";
import SunIcon from "@/public/assets/images/docs/sun.svg";

export function DocsSearch({ value }: { value?: string }) {
  return (
    <form role="search" className="relative w-full max-w-[26rem]" onSubmit={(event) => event.preventDefault()}>
      <label htmlFor="docs-search" className="sr-only">
        Search docs
      </label>
      <SearchIcon aria-hidden className="text-subtle pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2" />
      <input
        id="docs-search"
        type="search"
        defaultValue={value}
        placeholder="Search docs"
        autoComplete="off"
        className="placeholder:text-subtle text-foreground ease-power3-out h-8 w-full rounded-xl bg-white/[0.04] pr-20 pl-9 text-[14px] transition-colors duration-150 outline-none focus:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-ring/40"
      />
      <span aria-hidden className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-0.5">
        <Kbd>⌘</Kbd>
        <Kbd>⇧</Kbd>
        <Kbd>F</Kbd>
      </span>
    </form>
  );
}

export function DocsHeader() {
  return (
    <SectionHeader
      title="Docs"
      viewer={MOCK_VIEWER}
      heading={
        <div className="flex min-w-0 items-center gap-5">
          <h1 className="shrink-0">Docs</h1>
          <div className="hidden min-w-0 flex-1 lg:flex">
            <DocsSearch />
          </div>
        </div>
      }
      action={
        <Button variant="primary" shortcut={["⌘", "N"]} aria-label="New note" className="max-sm:size-[30px] max-sm:p-0">
          <PlusIcon aria-hidden className="size-3 sm:hidden" />
          <span className="max-sm:sr-only">New note</span>
        </Button>
      }
    />
  );
}

export function ShareButton({ shared, compact, className }: { shared: boolean; compact?: boolean; className?: string }) {
  const Icon = shared ? UsersIcon : LockIcon;
  const label = shared ? "Shared" : "Private";
  return (
    <Button
      variant="secondary"
      size={compact ? "icon" : "sm"}
      aria-label={shared ? "Shared with workspace. Change sharing" : "Private. Change sharing"}
      title={shared ? "Shared with everyone at Eclipse" : "Only you can see this"}
      className={cn("data-[state=open]:bg-muted", className)}
    >
      <Icon aria-hidden className={cn("size-3.5", shared ? "text-(--tag-blue-text)" : "text-subtle")} />
      {!compact && label}
    </Button>
  );
}

export function SharedGlyph({ label = "Shared with workspace" }: { label?: string }) {
  return (
    <span title={label} className="flex shrink-0 items-center">
      <UsersIcon aria-hidden className="text-(--tag-blue-text)/80 size-3" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function PrivateGlyph() {
  return (
    <span title="Private" className="flex shrink-0 items-center">
      <LockIcon aria-hidden className="text-faint size-3" />
      <span className="sr-only">Private</span>
    </span>
  );
}

export function NoteListRow({ note, active, compact }: { note: NoteRow; active?: boolean; compact?: boolean }) {
  const writing = note.live?.find((person) => person.agent);
  return (
    <li>
      <button
        type="button"
        aria-current={active ? "true" : undefined}
        className={cn(
          "ease-power3-out flex w-full cursor-pointer flex-col gap-1 rounded-xl text-left transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
          compact ? "px-4 py-3" : "px-3 py-2.5",
          active ? "bg-white/[0.07]" : "hover:bg-white/[0.035]",
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn("min-w-0 truncate text-[14px] leading-5 font-medium", active ? "text-foreground" : "text-[#e3e5ea]")}>{note.title}</span>
          {note.shared && <SharedGlyph label="Shared on its own" />}
          {note.privateMark && <PrivateGlyph />}
          <span className={cn("ml-auto shrink-0 text-[12px] tabular-nums", note.when === "Now" ? "text-[#b9b0ff]" : "text-subtle")}>{note.when}</span>
        </span>
        <span className="text-subtle line-clamp-2 text-[13px] leading-[1.45]">{note.snippet}</span>
        {writing ? (
          <span className="flex items-center gap-1.5 pt-0.5">
            <PresenceStack people={note.live ?? []} size="xs" />
            <span className="caption-style text-[#b9b0ff]">{writing.short} is writing</span>
          </span>
        ) : (
          note.tags &&
          note.tags.length > 0 && (
            <span className="caption-style text-faint flex items-center gap-2 pt-0.5">
              {note.tags.map((tag) => (
                <span key={tag}>#{tag}</span>
              ))}
            </span>
          )
        )}
      </button>
    </li>
  );
}

export function ListPane({
  icon: Icon,
  title,
  count,
  control,
  children,
  className,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  count?: string;
  control?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-0 w-full flex-col md:w-[19rem] md:shrink-0 xl:w-[20.5rem]", className)}>
      <div className="flex h-12 shrink-0 items-center gap-2 pr-2 pl-4">
        <Icon aria-hidden className="text-subtle size-3.5 shrink-0" />
        <h2 className="truncate text-[15px] leading-none">{title}</h2>
        {count && <span className="caption-style text-subtle shrink-0 tabular-nums">{count}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1">{control}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-24">{children}</div>
    </div>
  );
}

export function SortButton() {
  return (
    <Button variant="ghost" size="sm" aria-label="Sort by last edited" className="h-[30px] px-2.5">
      Edited
      <ChevronDownIcon aria-hidden className="size-3" />
    </Button>
  );
}

export function ToolButton({ label, active, children }: { label: string; active?: boolean; children: ReactNode }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn(active && "text-foreground bg-white/[0.07]")}
    >
      {children}
    </Button>
  );
}

export function Breadcrumb({ icon: Icon = FolderIcon, parent, title }: { icon?: ComponentType<SVGProps<SVGSVGElement>>; parent: string; title: string }) {
  return (
    <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
      <ol className="flex min-w-0 items-center gap-1.5 text-[13px] leading-none">
        <li className="text-subtle flex shrink-0 items-center gap-1.5">
          <Icon aria-hidden className="size-3.5" />
          {parent}
        </li>
        <li aria-hidden className="text-faint">
          <ChevronRightIcon className="size-3" />
        </li>
        <li aria-current="page" className="text-soft min-w-0 truncate">
          {title}
        </li>
      </ol>
    </nav>
  );
}

export function EditorToolbar({
  breadcrumb,
  presence,
  share,
  history,
  rail,
  extra,
}: {
  breadcrumb: ReactNode;
  presence?: Person[];
  share?: ReactNode;
  history?: boolean;
  rail?: boolean;
  extra?: ReactNode;
}) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 pr-2.5 pl-5">
      {breadcrumb}
      <div className="flex shrink-0 items-center gap-1">
        {presence && (
          <span className="mr-1.5">
            <PresenceStack people={presence} />
          </span>
        )}
        {extra}
        {share}
        <ToolButton label="Version history" active={history}>
          <HistoryIcon aria-hidden className="size-3.5" />
        </ToolButton>
        <ToolButton label="Backlinks and details" active={rail}>
          <PanelRightIcon aria-hidden className="size-3.5" />
        </ToolButton>
        <ToolButton label="More">
          <MoreIcon aria-hidden className="size-3.5" />
        </ToolButton>
      </div>
    </div>
  );
}

export function EditorCard({ toolbar, children, rail, banner }: { toolbar: ReactNode; children: ReactNode; rail?: ReactNode; banner?: ReactNode }) {
  return (
    <div className="hidden min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:my-2 md:mr-2 md:flex md:rounded-2xl md:bg-white/[0.02]">
      {toolbar}
      {banner}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1 overflow-y-auto px-12 pt-7 pb-40">{children}</div>
        {rail && <aside className="flex min-h-0 w-[16.5rem] shrink-0 flex-col overflow-y-auto border-l border-white/[0.05]">{rail}</aside>}
      </div>
    </div>
  );
}

export function RailSection({ title, count, action, children }: { title: string; count?: number; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 px-4 pt-4">
      <div className="flex h-5 items-center gap-2">
        <h3 className="eyebrow-style text-subtle text-[11px] font-medium">{title}</h3>
        {count !== undefined && <span className="caption-style text-faint tabular-nums">{count}</span>}
        <span className="ml-auto">{action}</span>
      </div>
      {children}
    </section>
  );
}

function LinkHit({ children }: { children: ReactNode }) {
  return <span className="text-soft underline decoration-[#8b7bff]/70 decoration-1 underline-offset-[3px]">{children}</span>;
}

function Backlink({ icon: Icon = DocIcon, title, where, children }: { icon?: ComponentType<SVGProps<SVGSVGElement>>; title: string; where: ReactNode; children: ReactNode }) {
  return (
    <li>
      <a href="#" className="ease-power3-out flex flex-col gap-1.5 rounded-xl bg-white/[0.03] p-3 transition-colors duration-150 hover:bg-white/[0.05]">
        <span className="flex min-w-0 items-center gap-1.5">
          <Icon aria-hidden className="text-subtle size-3.5 shrink-0" />
          <span className="text-foreground min-w-0 truncate text-[13px] leading-4 font-medium">{title}</span>
        </span>
        <span className="text-subtle text-[12.5px] leading-[1.5]">{children}</span>
        <span className="caption-style text-faint flex items-center gap-1.5">{where}</span>
      </a>
    </li>
  );
}

function RecordRow({ icon, name, detail }: { icon: ReactNode; name: string; detail: string }) {
  return (
    <li>
      <a href="#" className="ease-power3-out -mx-2 flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors duration-150 hover:bg-white/[0.04]">
        {icon}
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-foreground truncate text-[13px] leading-4">{name}</span>
          <span className="caption-style text-subtle truncate">{detail}</span>
        </span>
      </a>
    </li>
  );
}

export function InfoRail() {
  return (
    <div className="flex flex-col gap-2 pb-28">
      <RailSection title="Backlinks" count={3}>
        <ul className="flex flex-col gap-2">
          <Backlink
            title="Acme pricing notes"
            where={
              <>
                Clients <span aria-hidden>·</span> Yesterday
              </>
            }
          >
            Anchor the renewal to the pilot and the plan in <LinkHit>Q4 partner strategy</LinkHit>.
          </Backlink>
          <Backlink
            title="Co-marketing calendar"
            where={
              <>
                Partnerships <span aria-hidden>·</span> Mon
              </>
            }
          >
            Dates follow the <LinkHit>Q4 partner strategy</LinkHit>, so the webinar moves if Northwind slips.
          </Backlink>
          <Backlink
            icon={SunIcon}
            title="Mon 27 Oct"
            where={
              <>
                <LockIcon aria-hidden className="size-3" /> Daily note, only you see this
              </>
            }
          >
            Rewrote the <LinkHit>Q4 partner strategy</LinkHit> on the train. Better.
          </Backlink>
        </ul>
        <button
          type="button"
          className="caption-style text-subtle hover:text-foreground flex items-center gap-1.5 self-start rounded-md py-1 transition-colors duration-150"
        >
          2 unlinked mentions
          <ChevronRightIcon aria-hidden className="size-3" />
        </button>
      </RailSection>
      <RailSection title="In this note">
        <ul className="flex flex-col">
          <RecordRow icon={<Monogram name="Acme" className="size-6 rounded-lg text-[11px]" />} name="Acme" detail="Customer · Mark Ridgeon" />
          <RecordRow
            icon={<PersonAvatar person={PEOPLE.lena} size="md" />}
            name="Lena Ortiz"
            detail="Partner marketing, Northwind"
          />
          <RecordRow
            icon={
              <span className="bg-secondary text-subtle flex size-6 shrink-0 items-center justify-center rounded-lg">
                <ClipboardIcon aria-hidden className="size-3.5" />
              </span>
            }
            name="Helix joint offer"
            detail="Proposal · £24,000"
          />
        </ul>
      </RailSection>
      <RailSection title="Tags">
        <div className="flex flex-wrap gap-1.5">
          {["partners/q4", "clients/acme"].map((tag) => (
            <a key={tag} href="#" className="text-soft hover:text-foreground rounded-md bg-white/[0.05] px-2 py-1 text-[12.5px] leading-none transition-colors duration-150">
              <span className="text-faint">#</span>
              {tag}
            </a>
          ))}
        </div>
      </RailSection>
    </div>
  );
}

export function NoteMeta({ children }: { children: ReactNode }) {
  return <div className="text-subtle mt-3 mb-7 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-5">{children}</div>;
}

export function Dot() {
  return (
    <span aria-hidden className="text-faint">
      ·
    </span>
  );
}

export function FolderControl({ shared }: { shared: boolean }) {
  return (
    <>
      <SortButton />
      <ShareButton shared={shared} compact />
    </>
  );
}

export { BuildingIcon, FolderIcon, SunIcon, DocIcon, LockIcon, UsersIcon, HistoryIcon };
