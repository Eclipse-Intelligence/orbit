"use client";

import type { ReactNode } from "react";
import Button from "@/components/_ui/button";
import { Command as CommandPrimitive } from "cmdk";
import { Command, CommandDialog, CommandFooter, CommandGroup, CommandInput, CommandItem, CommandSeparator, Kbd } from "@/components/_ui/command";
import CopyButton from "@/components/_ui/copy-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import { Radio } from "@/components/_ui/radio";
import Switch from "@/components/_ui/switch";
import { CLIENT_NOTES, DAYS, PARTNERSHIP_NOTES, PEOPLE, type Person, type Screen } from "@/components/docs-mockup/data";
import { AcmePricingBody, DailyBody, Q4Body } from "@/components/docs-mockup/notes";
import {
  Breadcrumb,
  DocsHeader,
  EditorCard,
  EditorToolbar,
  FolderControl,
  InfoRail,
  ListPane,
  NoteListRow,
  ShareButton,
  SortButton,
} from "@/components/docs-mockup/panes";
import { PersonAvatar } from "@/components/docs-mockup/presence";
import { PhoneScreen } from "@/components/docs-mockup/phone";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import ChevronLeftIcon from "@/public/assets/images/_common/chevron-left.svg";
import ChevronRightIcon from "@/public/assets/images/_common/chevron-right.svg";
import PaperclipIcon from "@/public/assets/images/_common/paperclip.svg";
import PlusIcon from "@/public/assets/images/_common/plus.svg";
import SearchIcon from "@/public/assets/images/_common/search.svg";
import ArrowUpIcon from "@/public/assets/images/assistant/arrow-up.svg";
import GlobeIcon from "@/public/assets/images/assistant/globe.svg";
import BuildingIcon from "@/public/assets/images/companies/sidebar/building.svg";
import UsersIcon from "@/public/assets/images/companies/sidebar/users.svg";
import ClockIcon from "@/public/assets/images/companies/detail/clock.svg";
import FolderIcon from "@/public/assets/images/mail/folder.svg";
import DocIcon from "@/public/assets/images/docs/doc.svg";
import HeadingIcon from "@/public/assets/images/docs/heading.svg";
import LockIcon from "@/public/assets/images/docs/lock.svg";
import SunIcon from "@/public/assets/images/docs/sun.svg";
import UndoIcon from "@/public/assets/images/docs/undo.svg";


function Shell({ children }: { children: ReactNode }) {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <DocsHeader />
      <div className="flex min-h-0 flex-1">{children}</div>
    </section>
  );
}

function PartnershipsList({ live = true }: { live?: boolean }) {
  return (
    <ListPane icon={FolderIcon} title="Partnerships" count="6" control={<FolderControl shared />}>
      <ul className="flex flex-col gap-0.5">
        {PARTNERSHIP_NOTES.map((note, index) => (
          <NoteListRow key={note.id} note={live || index > 0 ? note : { ...note, live: undefined, when: "11:20", by: PEOPLE.mark }} active={index === 0} />
        ))}
      </ul>
    </ListPane>
  );
}

function Q4Toolbar({ presence, history, rail }: { presence: Person[]; history?: boolean; rail?: boolean }) {
  return (
    <EditorToolbar
      breadcrumb={<Breadcrumb parent="Partnerships" title="Q4 partner strategy" />}
      presence={presence}
      share={<ShareButton shared />}
      history={history}
      rail={rail}
    />
  );
}

function MainScreen() {
  return (
    <Shell>
      <PartnershipsList />
      <EditorCard toolbar={<Q4Toolbar presence={[PEOPLE.assistant, PEOPLE.priya, PEOPLE.mark]} rail />} rail={<InfoRail />}>
        <Q4Body mode="live" />
      </EditorCard>
    </Shell>
  );
}

function Highlight({ text, match }: { text: string; match: string }) {
  const index = text.toLowerCase().indexOf(match.toLowerCase());
  if (index === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <span className="text-foreground font-semibold">{text.slice(index, index + match.length)}</span>
      {text.slice(index + match.length)}
    </>
  );
}

function PickerOption({
  icon,
  title,
  detail,
  active,
  match,
  warn,
}: {
  icon: ReactNode;
  title: ReactNode;
  detail: ReactNode;
  active?: boolean;
  match?: string;
  warn?: boolean;
}) {
  return (
    <li role="option" aria-selected={active}>
      <span className={cn("flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2", active ? "bg-white/[0.07]" : "hover:bg-white/5")}>
        <span className="text-subtle mt-[3px] flex size-3.5 shrink-0 items-center justify-center">{icon}</span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-soft truncate text-[13.5px] leading-5">{typeof title === "string" && match ? <Highlight text={title} match={match} /> : title}</span>
          <span className={cn("caption-style flex items-center gap-1 truncate", warn ? "text-(--tag-amber-text)/80" : "text-subtle")}>{detail}</span>
        </span>
        {active && (
          <Kbd aria-hidden className="mt-0.5">
            ↵
          </Kbd>
        )}
      </span>
    </li>
  );
}

export function LinkPicker({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "bg-popover border-line-strong shadow-overlay animate-rise-in absolute top-[calc(100%+10px)] left-[-3.5rem] z-30 block w-[25rem] overflow-hidden rounded-xl border font-normal",
        className,
      )}
    >
      <span className="flex items-center justify-between px-3.5 pt-3 pb-1.5">
        <span className="eyebrow-style text-subtle text-[11px] font-medium">Link to a note</span>
        <span className="caption-style text-faint">4 matches</span>
      </span>
      <ul role="listbox" aria-label="Link to a note" className="flex flex-col p-1 pt-0">
        <PickerOption
          active
          icon={<DocIcon className="size-3.5" />}
          title="Acme renewal timeline"
          match="Acme renewal"
          detail={
            <>
              Partnerships <span aria-hidden>·</span> Priya, 2 days ago
            </>
          }
        />
        <PickerOption
          icon={<DocIcon className="size-3.5" />}
          title="Acme renewal call prep"
          match="Acme renewal"
          warn
          detail={
            <>
              <LockIcon aria-hidden className="size-3" /> Clients, private. Teammates will see the title only
            </>
          }
        />
        <PickerOption
          icon={<HeadingIcon className="size-3.5" />}
          title={
            <>
              Acme pricing notes <span className="text-faint">›</span> <span className="text-foreground font-semibold">Renewal</span> call
            </>
          }
          detail="Heading in Acme pricing notes"
        />
        <PickerOption
          icon={<SunIcon className="size-3.5" />}
          title="Mon 27 Oct"
          detail={<>&ldquo;Acme renewal call booked for 14 Nov&rdquo;</>}
        />
      </ul>
      <span className="border-line-strong block border-t p-1">
        <span className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 hover:bg-white/5">
          <PlusIcon aria-hidden className="text-subtle size-3.5" />
          <span className="text-soft min-w-0 flex-1 truncate text-[13.5px] leading-5">
            Create <span className="text-foreground">&ldquo;Acme renewal&rdquo;</span> in Partnerships
          </span>
          <span aria-hidden className="flex items-center gap-0.5">
            <Kbd>⇧</Kbd>
            <Kbd>↵</Kbd>
          </span>
        </span>
      </span>
    </span>
  );
}

function LinkPickerScreen() {
  return (
    <Shell>
      <PartnershipsList />
      <EditorCard toolbar={<Q4Toolbar presence={[PEOPLE.assistant, PEOPLE.priya, PEOPLE.mark]} rail />} rail={<InfoRail />}>
        <Q4Body mode="linking" picker={<LinkPicker />} />
      </EditorCard>
    </Shell>
  );
}

function OpenRow({
  icon,
  title,
  match,
  where,
  when,
  shortcut,
  value,
  snippet,
}: {
  icon: ReactNode;
  title: ReactNode;
  match?: string;
  where?: ReactNode;
  when?: string;
  shortcut?: string[];
  value: string;
  snippet?: ReactNode;
}) {
  return (
    <CommandItem value={value} className={cn(snippet && "h-auto py-2")}>
      <span className="text-subtle flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate">{typeof title === "string" && match ? <Highlight text={title} match={match} /> : title}</span>
        {snippet && <span className="caption-style text-subtle truncate">{snippet}</span>}
      </span>
      {where && <span className="caption-style text-subtle flex shrink-0 items-center gap-1.5">{where}</span>}
      {when && <span className="caption-style text-faint w-14 shrink-0 text-right tabular-nums">{when}</span>}
      {shortcut && (
        <span aria-hidden className="ml-auto flex shrink-0 items-center gap-1">
          {shortcut.map((key) => (
            <Kbd key={key}>{key}</Kbd>
          ))}
        </span>
      )}
    </CommandItem>
  );
}

function Mark({ children }: { children: ReactNode }) {
  return <span className="text-foreground">{children}</span>;
}

function QuickOpen({ query }: { query: string }) {
  const doc = <DocIcon aria-hidden className="size-3.5" />;
  const shared = <UsersIcon aria-hidden className="size-3 text-(--tag-blue-text)/80" />;
  const lock = <LockIcon aria-hidden className="size-3" />;
  return (
    <CommandDialog open title="Open a note" description="Find a note by title or text, or create one." className="max-w-[640px]">
      <Command shouldFilter={false} value={query ? "acme-pricing" : "q4"}>
        <CommandInput
          value={query}
          onValueChange={() => undefined}
          placeholder="Open a note, or type to create one"
          trailing={
            <span aria-hidden className="caption-style text-faint flex items-center gap-1.5">
              Docs
              <Kbd>⌘K</Kbd>
            </span>
          }
        />
        <CommandPrimitive.List className="max-h-[min(34rem,70dvh)] overflow-y-auto p-1.5">
          {query ? (
            <>
              <CommandGroup heading="Notes">
                <OpenRow value="acme-pricing" icon={doc} title="Acme pricing notes" match="acme" where={<>{shared} Clients</>} when="Yesterday" />
                <OpenRow value="acme-onboarding" icon={doc} title="Acme onboarding checklist" match="acme" where={<>{lock} Clients</>} when="Mon" />
                <OpenRow value="acme-renewal" icon={doc} title="Acme renewal timeline" match="acme" where={<>{shared} Partnerships</>} when="27 Oct" />
              </CommandGroup>
              <CommandGroup heading="Mentions Acme">
                <OpenRow
                  value="q4"
                  icon={doc}
                  title="Q4 partner strategy"
                  snippet={
                    <>
                      <Mark>Acme</Mark> signed the reseller pilot in September: 4 deals sourced, £86k in pipeline.
                    </>
                  }
                  where={<>{shared} Partnerships</>}
                />
                <OpenRow
                  value="today"
                  icon={<SunIcon aria-hidden className="size-3.5" />}
                  title="Wed 29 Oct"
                  snippet={
                    <>
                      Small win: <Mark>Acme</Mark>&apos;s ops lead said the pilot &ldquo;saved her a whole Monday&rdquo;.
                    </>
                  }
                  where={<>{lock} Daily</>}
                />
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading="Actions">
                <OpenRow value="new" icon={<PlusIcon aria-hidden className="size-3.5" />} title={<>New note &ldquo;acme&rdquo;</>} shortcut={["⌘", "↵"]} />
                <OpenRow value="search" icon={<SearchIcon aria-hidden className="size-3.5" />} title={<>Search all docs for &ldquo;acme&rdquo;</>} shortcut={["⌘", "⇧", "F"]} />
                <OpenRow value="company" icon={<BuildingIcon aria-hidden className="size-3.5" />} title="Open Acme in Companies" />
              </CommandGroup>
            </>
          ) : (
            <>
              <CommandGroup heading="Recent">
                <OpenRow value="q4" icon={doc} title="Q4 partner strategy" where={<>{shared} Partnerships</>} when="Now" />
                <OpenRow value="today" icon={<SunIcon aria-hidden className="size-3.5" />} title="Wed 29 Oct" where={<>{lock} Daily</>} when="16:48" />
                <OpenRow value="acme-pricing" icon={doc} title="Acme pricing notes" where={<>{shared} Clients</>} when="Yesterday" />
                <OpenRow value="northwind" icon={doc} title="Northwind MSA redlines" where={<>{shared} Partnerships</>} when="Yesterday" />
                <OpenRow value="cold-email" icon={doc} title="Cold email teardown: Kestrel" where={<><PersonAvatar person={PEOPLE.priya} size="xs" /> Outbound playbooks</>} when="Mon" />
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading="Actions">
                <OpenRow value="new" icon={<PlusIcon aria-hidden className="size-3.5" />} title="New note" shortcut={["⌘", "N"]} />
                <OpenRow value="daily" icon={<SunIcon aria-hidden className="size-3.5" />} title="Today's daily note" shortcut={["G", "D"]} />
                <OpenRow value="search" icon={<SearchIcon aria-hidden className="size-3.5" />} title="Search all docs" shortcut={["⌘", "⇧", "F"]} />
              </CommandGroup>
            </>
          )}
        </CommandPrimitive.List>
        <CommandFooter>
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            Move
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>Enter</Kbd>
            Open
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>⌘</Kbd>
            <Kbd>Enter</Kbd>
            Create
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <Kbd>Esc</Kbd>
            Close
          </span>
        </CommandFooter>
      </Command>
    </CommandDialog>
  );
}

function QuickOpenScreen({ query }: { query: string }) {
  return (
    <>
      <Shell>
        <PartnershipsList />
        <EditorCard toolbar={<Q4Toolbar presence={[PEOPLE.assistant, PEOPLE.priya, PEOPLE.mark]} rail />} rail={<InfoRail />}>
          <Q4Body mode="settled" />
        </EditorCard>
      </Shell>
      <QuickOpen query={query} />
    </>
  );
}

function ShareOption({
  checked,
  icon,
  title,
  children,
}: {
  checked: boolean;
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-xl p-3 transition-colors duration-150",
        checked ? "bg-white/[0.05] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]" : "hover:bg-white/[0.03]",
      )}
    >
      <span className="bg-secondary flex size-8 shrink-0 items-center justify-center rounded-lg shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-foreground text-[13.5px] leading-5 font-medium">{title}</span>
        <span className="caption-style text-subtle">{children}</span>
      </span>
      <Radio name="share" checked={checked} readOnly className="mt-2" aria-label={title} />
    </label>
  );
}

function ShareScreen() {
  return (
    <Shell>
      <ListPane
        icon={FolderIcon}
        title="Clients"
        count="9"
        control={
          <>
            <SortButton />
            <Popover open>
              <PopoverTrigger asChild>
                <span className="flex">
                  <ShareButton shared={false} />
                </span>
              </PopoverTrigger>
              <PopoverContent align="start" side="right" sideOffset={10} className="w-[22.5rem] p-0" onOpenAutoFocus={(event) => event.preventDefault()}>
                <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
                  <FolderIcon aria-hidden className="text-subtle size-3.5" />
                  <h3 className="flex-1">Share Clients</h3>
                  <span className="caption-style text-subtle">9 notes</span>
                </div>
                <div className="flex flex-col gap-1 px-2">
                  <ShareOption checked icon={<LockIcon aria-hidden className="text-soft size-3.5" />} title="Private">
                    Only you can see these notes.
                  </ShareOption>
                  <ShareOption checked={false} icon={<UsersIcon aria-hidden className="size-3.5 text-(--tag-blue-text)" />} title="Shared with workspace">
                    Everyone at Eclipse can find, read and edit them, including notes you add later.
                  </ShareOption>
                </div>
                <div className="mx-4 mt-3 flex items-start gap-2.5 rounded-lg bg-white/[0.03] px-3 py-2.5">
                  <UsersIcon aria-hidden className="mt-px size-3.5 shrink-0 text-(--tag-blue-text)/80" />
                  <p className="caption-style text-soft">
                    <span className="text-foreground">Acme pricing notes</span> is already shared on its own. It stays shared either way.
                  </p>
                </div>
                <div className="border-line-strong mt-4 flex items-center gap-2 border-t px-4 py-3">
                  <span className="caption-style text-subtle flex-1">The assistant and your MCP agents follow the same rule.</span>
                  <CopyButton text="https://orbit.eclipse.dev/docs/clients" label="Copy link" />
                </div>
              </PopoverContent>
            </Popover>
          </>
        }
      >
        <ul className="flex flex-col gap-0.5">
          {CLIENT_NOTES.map((note, index) => (
            <NoteListRow key={note.id} note={note} active={index === 0} />
          ))}
        </ul>
      </ListPane>
      <EditorCard
        toolbar={
          <EditorToolbar breadcrumb={<Breadcrumb parent="Clients" title="Acme pricing notes" />} presence={[PEOPLE.mark]} share={<ShareButton shared />} />
        }
      >
        <AcmePricingBody />
      </EditorCard>
    </Shell>
  );
}

const MONTH_START = 2;
const DAYS_IN_MONTH = 31;
const ENTRY_DAYS = new Set([1, 2, 3, 6, 7, 8, 9, 10, 13, 14, 15, 16, 17, 20, 21, 22, 23, 24, 27, 28, 29]);

function MonthCalendar() {
  const cells = Array.from({ length: MONTH_START + DAYS_IN_MONTH }, (_, index) => (index < MONTH_START ? null : index - MONTH_START + 1));
  return (
    <div className="px-2.5 pt-1 pb-3">
      <div className="flex items-center gap-1 pb-2 pl-1.5">
        <span className="text-foreground flex-1 text-[13px] font-medium">October 2026</span>
        <Button variant="ghost" size="icon-sm" aria-label="Previous month">
          <ChevronLeftIcon aria-hidden className="size-3" />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Next month">
          <ChevronRightIcon aria-hidden className="size-3" />
        </Button>
      </div>
      <div className="grid grid-cols-7 gap-y-0.5 text-center">
        {["M", "T", "W", "T", "F", "S", "S"].map((day, index) => (
          <span key={index} className="caption-style text-faint pb-1 text-[11px]">
            {day}
          </span>
        ))}
        {cells.map((day, index) =>
          day === null ? (
            <span key={index} />
          ) : (
            <button
              key={index}
              type="button"
              aria-label={`${day} October${ENTRY_DAYS.has(day) ? ", has entries" : ""}`}
              aria-current={day === 29 ? "date" : undefined}
              className={cn(
                "relative mx-auto flex size-8 cursor-pointer flex-col items-center justify-center rounded-full text-[12.5px] tabular-nums transition-colors duration-150",
                day === 29 ? "bg-primary text-white" : day > 29 ? "text-faint" : "text-soft hover:bg-white/[0.05]",
              )}
            >
              {day}
              {ENTRY_DAYS.has(day) && day !== 29 && <span aria-hidden className="bg-subtle absolute bottom-[5px] size-[3px] rounded-full" />}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

function DailyScreen() {
  return (
    <Shell>
      <ListPane
        icon={SunIcon}
        title="Daily notes"
        control={
          <span className="caption-style text-subtle mr-2 flex items-center gap-1">
            <LockIcon aria-hidden className="size-3" />
            Only you
          </span>
        }
      >
        <MonthCalendar />
        <div className="mx-2.5 mb-2 h-px bg-white/[0.05]" />
        <ul className="flex flex-col gap-0.5">
          {DAYS.map((day, index) => (
            <li key={day.date}>
              <button
                type="button"
                aria-current={index === 0 ? "true" : undefined}
                className={cn("flex w-full cursor-pointer flex-col gap-1 rounded-xl px-3 py-2.5 text-left transition-colors duration-150", index === 0 ? "bg-white/[0.07]" : "hover:bg-white/[0.035]")}
              >
                <span className="flex items-center gap-2">
                  <span className={cn("text-[14px] leading-5 font-medium", index === 0 ? "text-foreground" : "text-[#e3e5ea]")}>{day.label}</span>
                  <span className="caption-style text-subtle">{day.date}</span>
                  <span className="caption-style text-faint ml-auto tabular-nums">{day.entries} entries</span>
                </span>
                <span className="text-subtle truncate text-[13px] leading-[1.45]">{day.preview}</span>
              </button>
            </li>
          ))}
        </ul>
      </ListPane>
      <EditorCard
        toolbar={
          <EditorToolbar
            breadcrumb={<Breadcrumb icon={SunIcon} parent="Daily notes" title="Wed 29 Oct" />}
            extra={
              <span className="mr-1 flex items-center gap-1">
                <Button variant="ghost" size="icon" aria-label="Previous day" title="Previous day (⌥↑)">
                  <ChevronLeftIcon aria-hidden className="size-3.5" />
                </Button>
                <Button variant="secondary" size="sm" disabled title="Today (G then D)">
                  Today
                </Button>
                <Button variant="ghost" size="icon" aria-label="Next day" title="Next day (⌥↓)" disabled>
                  <ChevronRightIcon aria-hidden className="size-3.5" />
                </Button>
              </span>
            }
          />
        }
      >
        <DailyBody />
      </EditorCard>
    </Shell>
  );
}

type Version = { time: string; who: Person; what: string; asked?: string; active?: boolean; current?: boolean };

const VERSIONS: { day: string; items: Version[] }[] = [
  {
    day: "Today",
    items: [
      { time: "Now", who: PEOPLE.priya, what: "Editing with Mark", current: true },
      { time: "11:42", who: PEOPLE.assistant, what: "Added a risk on the Acme renewal, ticked 1 task", asked: "Asked by Mark", active: true },
      { time: "11:20", who: PEOPLE.mark, what: "Rewrote Where we are" },
      { time: "09:05", who: PEOPLE.claude, what: "Updated pipeline figures from Orbit", asked: "Mark's MCP token" },
    ],
  },
  {
    day: "Yesterday",
    items: [
      { time: "17:48", who: PEOPLE.priya, what: "Added Northwind risk" },
      { time: "16:02", who: PEOPLE.mark, what: "Added Q4 plan" },
    ],
  },
  { day: "14 Oct", items: [{ time: "10:15", who: PEOPLE.mark, what: "Created" }] },
];

function HistoryRail() {
  return (
    <div className="flex flex-col pb-28">
      <div className="flex h-11 shrink-0 items-center gap-2 px-4">
        <h3 className="flex-1">Version history</h3>
        <span className="caption-style text-subtle">14 versions</span>
      </div>
      {VERSIONS.map((group) => (
        <section key={group.day} className="flex flex-col px-2 pb-2">
          <h4 className="eyebrow-style text-faint px-2 pt-2 pb-1.5 text-[11px]">{group.day}</h4>
          <ol className="flex flex-col gap-0.5">
            {group.items.map((version) => (
              <li key={`${group.day}-${version.time}`}>
                <button
                  type="button"
                  aria-current={version.active ? "true" : undefined}
                  className={cn(
                    "flex w-full cursor-pointer items-start gap-2.5 rounded-xl px-2 py-2 text-left transition-colors duration-150",
                    version.active ? "bg-white/[0.07]" : "hover:bg-white/[0.035]",
                  )}
                >
                  <PersonAvatar person={version.who} size="md" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-1.5">
                      <span className={cn("truncate text-[13px] leading-4 font-medium", version.who.agent === "assistant" ? "text-[#c9c2ff]" : "text-foreground")}>
                        {version.who.name}
                      </span>
                      <span className="caption-style text-subtle ml-auto shrink-0 tabular-nums">{version.time}</span>
                    </span>
                    <span className="caption-style text-soft">{version.what}</span>
                    {version.asked && <span className="caption-style text-faint">{version.asked}</span>}
                    {version.current && (
                      <span className="caption-style flex items-center gap-1.5 text-(--tag-green-text)">
                        <span className="bg-success size-1.5 rounded-full" />
                        Live
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      ))}
      <p className="caption-style text-faint px-4 pt-2">Orbit saves a version after each pause in editing, and before every agent edit.</p>
    </div>
  );
}

function HistoryScreen() {
  return (
    <Shell>
      <PartnershipsList live={false} />
      <EditorCard
        toolbar={<Q4Toolbar presence={[PEOPLE.priya, PEOPLE.mark]} history />}
        rail={<HistoryRail />}
        banner={
          <div className="mx-3 mb-1 flex shrink-0 items-center gap-3 rounded-xl bg-white/[0.04] py-2 pr-2 pl-3.5">
            <ClockIcon aria-hidden className="text-subtle size-3.5 shrink-0" />
            <p className="ui-style text-soft min-w-0 flex-1 truncate">
              <span className="text-foreground">11:42 today</span> by Orbit assistant, compared with the version before
            </p>
            <label className="caption-style text-soft flex shrink-0 items-center gap-2">
              Show changes
              <Switch checked onChange={() => undefined} label="Show changes" />
            </label>
            <Button variant="secondary" size="sm">
              <UndoIcon aria-hidden className="size-3.5" />
              Restore
            </Button>
            <Button variant="ghost" size="sm" shortcut={["Esc"]}>
              Back to live
            </Button>
          </div>
        }
      >
        <Q4Body mode="diff" />
      </EditorCard>
    </Shell>
  );
}

function DiffLine({ sign, children }: { sign: "+" | "-" | " "; children: ReactNode }) {
  return (
    <div
      className={cn(
        "grid grid-cols-[1.25rem_1fr] px-2 py-[3px] text-[13px] leading-5",
        sign === "+" && "bg-[color-mix(in_srgb,var(--success)_12%,transparent)] text-[#c9f5d8]",
        sign === "-" && "bg-[color-mix(in_srgb,var(--danger)_11%,transparent)] text-[#fecaca]/90",
        sign === " " && "text-subtle",
      )}
    >
      <span aria-hidden className="text-center opacity-70 select-none">
        {sign === " " ? "" : sign}
      </span>
      <span className="min-w-0">
        <span className="sr-only">{sign === "+" ? "Added: " : sign === "-" ? "Removed: " : ""}</span>
        {children}
      </span>
    </div>
  );
}

function AssistantPanel() {
  return (
    <div className="fixed z-50 inset-x-2 top-16 bottom-2 md:inset-x-auto md:top-auto md:bottom-4 md:left-1/2 md:w-[min(46rem,calc(100vw-2rem))] md:-translate-x-1/2 lg:left-[calc(var(--sidebar-width)+(100vw-var(--sidebar-width))/2)] lg:w-[min(46rem,calc(100vw-var(--sidebar-width)-3rem))]">
      <section
        aria-label="Orbit assistant"
        className="relative flex h-full max-h-full flex-col overflow-hidden rounded-3xl bg-[#1c1c1c]/95 shadow-[0_24px_80px_rgba(0,0,0,0.6)] backdrop-blur-xl md:h-auto md:max-h-[min(44rem,calc(100dvh-6rem))]"
      >
        <header className="flex h-11 shrink-0 items-center gap-1 pt-1 pr-2 pl-5">
          <span className="text-subtle min-w-0 flex-1 truncate text-[13px]">Acme renewal risk</span>
          <Button variant="ghost" size="icon-sm" aria-label="Past chats">
            <ClockIcon aria-hidden className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="New chat">
            <PlusIcon aria-hidden className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Minimise">
            <ChevronDownIcon aria-hidden className="size-3" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3 [mask-image:linear-gradient(to_bottom,transparent,black_1rem,black_calc(100%-1.5rem),transparent)]">
          <div className="flex flex-col gap-5">
            <div className="flex flex-col items-end gap-1.5">
              <div className="text-foreground max-w-[85%] rounded-2xl rounded-br-md bg-white/[0.07] px-3.5 py-2 text-[14px] leading-6">
                Acme&apos;s renewal is in January. Add that as a risk in the Q4 doc and tick off the pricing task, I sent it yesterday.
              </div>
            </div>
            <div className="flex flex-col gap-2.5">
              <p className="text-[14px] leading-6">
                Done as a draft. I found the pricing email you sent to Dana yesterday at 16:10, so the task can be ticked. The risk goes under Risks, with the
                12 December date from your Acme pricing notes.
              </p>
              <div className="flex flex-col gap-2 rounded-2xl bg-white/[0.04] p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <span className="text-foreground min-w-0 text-[13.5px] leading-5 font-medium">Edit Q4 partner strategy</span>
                  <span className="caption-style text-warning shrink-0">Waiting for you</span>
                </div>
                <ul className="text-soft flex flex-col gap-0.5 text-[13px] leading-5">
                  <li className="flex items-center gap-1.5">
                    <UsersIcon aria-hidden className="size-3 text-(--tag-blue-text)/80" />
                    Partnerships, shared with workspace. Priya is in the note now.
                  </li>
                </ul>
                <div className="my-1 overflow-hidden rounded-xl bg-black/25 py-1.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]">
                  <DiffLine sign=" ">## Q4 plan</DiffLine>
                  <DiffLine sign="-">[ ] Share revised pricing with Acme, see [[Acme pricing notes]]</DiffLine>
                  <DiffLine sign="+">[x] Share revised pricing with Acme, see [[Acme pricing notes]]</DiffLine>
                  <DiffLine sign=" ">…</DiffLine>
                  <DiffLine sign=" ">## Risks</DiffLine>
                  <DiffLine sign=" ">Northwind&apos;s legal review could slip into January. Priya owns the chase.</DiffLine>
                  <DiffLine sign="+">
                    Acme&apos;s renewal lands in January, so the pilot results need to be in their hands by 12 December, with the case study signed off.
                  </DiffLine>
                </div>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button variant="primary" size="sm">
                    Confirm
                  </Button>
                  <Button variant="secondary" size="sm">
                    Open in Docs
                  </Button>
                  <Button variant="ghost" size="sm">
                    Cancel
                  </Button>
                  <span className="caption-style text-faint ml-auto">Saved as a version, so you can undo it</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="shrink-0 px-5 pt-1 pb-3">
          <div className="flex flex-col gap-2">
            <p className="text-subtle min-h-6 text-[14px] leading-6">Ask about Orbit… Type @ to tag</p>
            <div className="flex items-center gap-1.5">
              <span className="-ml-2.5 flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12.5px]">
                Sonnet 5.5
                <ChevronDownIcon aria-hidden className="text-subtle size-3" />
              </span>
              <span className="flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12.5px]">
                Medium
                <ChevronDownIcon aria-hidden className="text-subtle size-3" />
              </span>
              <span className="text-subtle flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12.5px]">
                <GlobeIcon aria-hidden className="size-3.5" />
                Web
              </span>
              <span className="text-subtle flex size-7 items-center justify-center">
                <PaperclipIcon aria-hidden className="size-3.5" />
              </span>
              <span className="flex-1" />
              <Button variant="primary" size="icon" aria-label="Send" disabled>
                <ArrowUpIcon aria-hidden className="size-3.5" />
              </Button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function ApprovalScreen() {
  return (
    <>
      <Shell>
        <PartnershipsList live={false} />
        <EditorCard toolbar={<Q4Toolbar presence={[PEOPLE.priya, PEOPLE.mark]} />}>
          <Q4Body mode="before" />
        </EditorCard>
      </Shell>
      <AssistantPanel />
    </>
  );
}

export default function DocsMockup({ screen }: { screen: Screen }) {
  if (screen.startsWith("phone")) return <PhoneScreen screen={screen} />;
  if (screen === "link-picker") return <LinkPickerScreen />;
  if (screen === "quick-open") return <QuickOpenScreen query="" />;
  if (screen === "quick-open-search") return <QuickOpenScreen query="acme" />;
  if (screen === "share") return <ShareScreen />;
  if (screen === "daily") return <DailyScreen />;
  if (screen === "history") return <HistoryScreen />;
  if (screen === "approval") return <ApprovalScreen />;
  return <MainScreen />;
}

