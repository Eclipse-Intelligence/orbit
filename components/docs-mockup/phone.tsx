"use client";

import type { ComponentType, ReactNode, SVGProps } from "react";
import Button from "@/components/_ui/button";
import SectionHeader from "@/components/crm/section-header";
import { DAYS, FOLDERS, MOCK_VIEWER, PARTNERSHIP_NOTES, PEOPLE, TAGS, type TagNode } from "@/components/docs-mockup/data";
import { Q4Body } from "@/components/docs-mockup/notes";
import { NoteListRow, ShareButton, SharedGlyph } from "@/components/docs-mockup/panes";
import { PersonAvatar, PresenceStack } from "@/components/docs-mockup/presence";
import { cn } from "@/lib/utils";
import ChevronLeftIcon from "@/public/assets/images/_common/chevron-left.svg";
import ChevronRightIcon from "@/public/assets/images/_common/chevron-right.svg";
import MoreIcon from "@/public/assets/images/_common/more.svg";
import PlusIcon from "@/public/assets/images/_common/plus.svg";
import SearchIcon from "@/public/assets/images/_common/search.svg";
import FolderIcon from "@/public/assets/images/mail/folder.svg";
import CheckSquareIcon from "@/public/assets/images/docs/check-square.svg";
import DocIcon from "@/public/assets/images/docs/doc.svg";
import HashIcon from "@/public/assets/images/docs/hash.svg";
import HeadingIcon from "@/public/assets/images/docs/heading.svg";
import LockIcon from "@/public/assets/images/docs/lock.svg";
import SunIcon from "@/public/assets/images/docs/sun.svg";

function PhoneHeader({ children }: { children: ReactNode }) {
  return (
    <header className="border-border shrink-0 border-b">
      <div className="flex items-center gap-2 px-3 py-2.5">{children}</div>
    </header>
  );
}

function Row({
  icon: Icon,
  label,
  trailing,
  depth = 0,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  trailing?: ReactNode;
  depth?: number;
}) {
  return (
    <li>
      <a
        href="#"
        className="flex h-11 items-center gap-3 rounded-xl pr-2 transition-colors duration-150 active:bg-white/[0.05]"
        style={{ paddingLeft: `${0.75 + depth * 1.25}rem` }}
      >
        <Icon aria-hidden className="text-subtle size-4 shrink-0" />
        <span className="text-foreground min-w-0 flex-1 truncate text-[15px]">{label}</span>
        {trailing}
        <ChevronRightIcon aria-hidden className="text-faint size-3 shrink-0" />
      </a>
    </li>
  );
}

function TagTree({ tags, depth }: { tags: TagNode[]; depth: number }) {
  return tags.map((tag) => (
    <TagLeaf key={tag.name} tag={tag} depth={depth} />
  ));
}

function TagLeaf({ tag, depth }: { tag: TagNode; depth: number }) {
  return (
    <>
      <Row icon={HashIcon} label={tag.name} depth={depth} trailing={<span className="caption-style text-subtle tabular-nums">{tag.count}</span>} />
      {tag.open && tag.children && <TagTree tags={tag.children} depth={depth + 1} />}
    </>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h2 className="eyebrow-style text-subtle px-3 pb-1 text-[11px] font-medium">{title}</h2>
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}

function FoldersScreen() {
  const today = DAYS[0];
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader
        title="Docs"
        viewer={MOCK_VIEWER}
        action={
          <Button variant="primary" size="icon" aria-label="New note">
            <PlusIcon aria-hidden className="size-3.5" />
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-28">
        <div className="relative">
          <SearchIcon aria-hidden className="text-subtle pointer-events-none absolute top-1/2 left-3.5 size-3.5 -translate-y-1/2" />
          <input
            type="search"
            aria-label="Search docs"
            placeholder="Search docs"
            className="placeholder:text-subtle text-foreground h-10 w-full rounded-xl bg-white/[0.04] pr-3 pl-10 outline-none"
          />
        </div>
        <a href="#" className="mt-3 flex flex-col gap-2 rounded-2xl bg-white/[0.035] p-4 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]">
          <span className="flex items-center gap-2">
            <SunIcon aria-hidden className="text-(--tag-amber-text) size-4" />
            <span className="eyebrow-style text-subtle text-[11px]">Today</span>
            <span className="caption-style text-subtle ml-auto flex items-center gap-1">
              <LockIcon aria-hidden className="size-3" />
              {today.entries} entries
            </span>
          </span>
          <span className="text-foreground text-[17px] leading-6 font-semibold tracking-[-0.01em]">Wednesday 29 October</span>
          <span className="text-subtle truncate text-[14px] leading-5">Small win: Acme&apos;s ops lead said the pilot &ldquo;saved her a whole Monday&rdquo;.</span>
        </a>
        <div className="mt-5 flex flex-col gap-5">
          <Group title="Folders">
            {FOLDERS.map((folder) => (
              <Row
                key={folder.id}
                icon={FolderIcon}
                label={folder.name}
                trailing={
                  <span className="flex items-center gap-2">
                    {folder.shared && (folder.owner ? <PersonAvatar person={folder.owner} size="xs" /> : <SharedGlyph />)}
                    <span className="caption-style text-subtle tabular-nums">{folder.count}</span>
                  </span>
                }
              />
            ))}
          </Group>
          <Group title="Tags">
            <TagTree tags={TAGS} depth={0} />
          </Group>
        </div>
      </div>
    </section>
  );
}

function ListScreen() {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PhoneHeader>
        <Button variant="secondary" size="icon" aria-label="Back to Docs">
          <ChevronLeftIcon aria-hidden className="size-3.5" />
        </Button>
        <h1 className="min-w-0 flex-1 truncate">Partnerships</h1>
        <ShareButton shared compact />
        <Button variant="primary" size="icon" aria-label="New note in Partnerships">
          <PlusIcon aria-hidden className="size-3.5" />
        </Button>
      </PhoneHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pt-1.5 pb-28">
        <p className="caption-style text-subtle flex items-center gap-1.5 px-4 pt-1 pb-2">
          <SharedGlyph />
          Shared with workspace <span aria-hidden>·</span> 6 notes
        </p>
        <ul className="flex flex-col gap-0.5">
          {PARTNERSHIP_NOTES.map((note) => (
            <NoteListRow key={note.id} note={note} compact />
          ))}
        </ul>
      </div>
    </section>
  );
}

function NoteHeader() {
  return (
    <PhoneHeader>
      <Button variant="secondary" size="sm" aria-label="Back to Partnerships" className="h-[30px] gap-1 pr-3 pl-2">
        <ChevronLeftIcon aria-hidden className="size-3.5" />
        Partnerships
      </Button>
      <span className="flex-1" />
      <PresenceStack people={[PEOPLE.assistant, PEOPLE.priya, PEOPLE.mark]} />
      <ShareButton shared compact />
      <Button variant="secondary" size="icon" aria-label="More">
        <MoreIcon aria-hidden className="size-3.5" />
      </Button>
    </PhoneHeader>
  );
}

function NoteScreen() {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <NoteHeader />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-5 pb-32">
        <Q4Body mode="phone" />
      </div>
    </section>
  );
}

function PickerScreen() {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <NoteHeader />
      <div className="min-h-0 flex-1 overflow-hidden px-5 pt-5">
        <Q4Body mode="phone-linking" />
      </div>
      <div className="bg-popover border-line-strong fixed inset-x-0 bottom-0 z-50 rounded-t-2xl border-t pb-[env(safe-area-inset-bottom)] shadow-[0_-16px_40px_rgba(0,0,0,0.5)]">
        <div className="flex items-center justify-between px-4 pt-3 pb-1">
          <span className="eyebrow-style text-subtle text-[11px] font-medium">Link to a note</span>
          <span className="caption-style text-faint">4 matches</span>
        </div>
        <ul role="listbox" aria-label="Link to a note" className="flex flex-col px-1.5">
          {[
            { icon: DocIcon, title: "Acme renewal timeline", detail: "Partnerships · Priya, 2 days ago", active: true },
            { icon: DocIcon, title: "Acme renewal call prep", detail: "Clients, private. Teammates see the title only", warn: true },
            { icon: HeadingIcon, title: "Acme pricing notes › Renewal call", detail: "Heading" },
          ].map((option) => (
            <li key={option.title} role="option" aria-selected={option.active}>
              <span className={cn("flex min-h-12 items-center gap-3 rounded-xl px-3 py-2", option.active && "bg-white/[0.07]")}>
                <option.icon aria-hidden className="text-subtle size-4 shrink-0" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-foreground truncate text-[15px] leading-5">{option.title}</span>
                  <span className={cn("caption-style truncate", option.warn ? "text-(--tag-amber-text)/80" : "text-subtle")}>{option.detail}</span>
                </span>
              </span>
            </li>
          ))}
          <li role="option" aria-selected={false}>
            <span className="flex min-h-12 items-center gap-3 rounded-xl px-3 py-2">
              <PlusIcon aria-hidden className="text-subtle size-4 shrink-0" />
              <span className="text-soft truncate text-[15px] leading-5">
                Create <span className="text-foreground">&ldquo;Acme renewal&rdquo;</span>
              </span>
            </span>
          </li>
        </ul>
        <div role="toolbar" aria-label="Formatting" className="border-line-strong mt-1.5 flex items-center gap-1 border-t px-2 py-1.5">
          {[
            { label: "Link a note", text: "[[" },
            { label: "Tag", text: "#" },
            { label: "Mention a record", text: "@" },
          ].map((item) => (
            <Button key={item.label} variant="ghost" size="icon" aria-label={item.label} className={cn("size-10 text-[15px] font-medium", item.text === "[[" && "text-foreground bg-white/[0.07]")}>
              {item.text}
            </Button>
          ))}
          <Button variant="ghost" size="icon" aria-label="Checkbox" className="size-10">
            <CheckSquareIcon aria-hidden className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Heading" className="size-10">
            <HeadingIcon aria-hidden className="size-4" />
          </Button>
          <span className="flex-1" />
          <Button variant="secondary" size="sm" className="h-8 px-3">
            Done
          </Button>
        </div>
      </div>
    </section>
  );
}

export function PhoneScreen({ screen }: { screen: string }) {
  if (screen === "phone-list") return <ListScreen />;
  if (screen === "phone-note") return <NoteScreen />;
  if (screen === "phone-picker") return <PickerScreen />;
  return <FoldersScreen />;
}
