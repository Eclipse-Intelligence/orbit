"use client";

import { useEffect, useId, useMemo, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode, type SVGProps } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { DueDatePicker } from "@/components/_ui/date-picker";
import { DurationMenu, ReminderTimePrompt } from "@/components/crm/task-timing";
import { Input } from "@/components/_ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import AssigneePicker, { MemberAvatar, type AssignableMember } from "@/components/crm/assignee-picker";
import { listGroups } from "@/components/crm/clickup";
import { addPadTaskAction, detectTaskRecordsAction, searchLinksForTaskAction, searchTaskLinksAction } from "@/app/(crm)/task-pad";
import type { ClickUpPicker } from "@/lib/crm/clickup";
import { REMINDER_OPTIONS } from "@/lib/crm/reminder-options";
import { DEFAULT_TASK_DURATION, localInstant } from "@/lib/crm/task-time";
import type { PadAiParse, PadReadBody, PadDetection, PadOption, PadRecord, PadSearchKind } from "@/lib/crm/task-pad";
import { requestReminderPermission } from "@/lib/reminder-alerts";
import {
  backspaceKeeps,
  mergeMarks,
  keptAfterTyping,
  keptReading,
  padReading,
  readingToSave,
  nameMarks,
  padConfirmLine,
  padFits,
  padNeedsConfirm,
  padRelease,
  chipOverrides,
  padDueHasTime,
  padRepeatDue,
  padSaveIds,
  ownerSetsTime,
  dayOnlyHint,
  londonParts,
  parseTaskText,
  reminderClock,
  resolvePadLinks,
  stripMention,
  docQueryAt,
  withoutDocQuery,
  type DocQuery,
  type KeptReading,
  type PadMark,
} from "@/lib/task-pad";
import { RepeatIcon, RepeatPicker, type RepeatDraft } from "@/components/crm/task-repeat";
import { dayKey } from "@/lib/crm/working-days";
import { endWords, repeatInputOf, repeatPhrase, repeatPresets, sameRule } from "@/lib/task-repeat";
import { DocPickHeader, DocPickNotice, DocPickOptions, DocPickPopover, useDocPicks } from "@/components/crm/task-doc-picker";
import type { DocPick } from "@/lib/docs/client-types";
import { formatDateLabel, formatDateTimeLabel } from "@/lib/date-input";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import CheckIcon from "@/public/assets/images/assistant/check.svg";
import XIcon from "@/public/assets/images/companies/detail/x.svg";
import BuildingIcon from "@/public/assets/images/companies/sidebar/building.svg";
import ClipboardIcon from "@/public/assets/images/companies/sidebar/clipboard.svg";
import ListIcon from "@/public/assets/images/companies/sidebar/list.svg";
import MailIcon from "@/public/assets/images/mail/mail-open.svg";
import ClockIcon from "@/public/assets/images/tasks/clock.svg";
import UserCircleIcon from "@/public/assets/images/tasks/user-circle.svg";
import UserIcon from "@/public/assets/images/tasks/user.svg";
import DocIcon from "@/public/assets/images/docs/doc.svg";

type Mention = { start: number; end: number; query: string };
type Suggestion = { kind: "company" | "contact"; option: PadOption };
type Override<T> = { set: boolean; value: T; side?: boolean };
type PadContact = PadRecord & { company: PadRecord | null };
type Variant = "card" | "inline";
type Icon = ComponentType<SVGProps<SVGSVGElement>>;

const AI_READ_PATH = "/api/tasks/read";
const padAi: { available: boolean | null } = { available: null };

function readKey(value: string) {
  const now = londonParts(new Date());
  return `${now.year}-${now.month}-${now.day}T${now.hour}|${value}`;
}

const unset = <T,>(): Override<T> => ({ set: false, value: undefined as T });

const FOLLOWS_DATE = ["weekly", "monthly-day", "monthly-fourth", "monthly-week"];

function notBefore(instant: number) {
  return new Date(Math.max(instant, Date.now()));
}

const NOTHING: PadDetection = {
  company: null,
  contact: null,
  opportunity: null,
  contactTitle: null,
  companyDomain: null,
  matchedBy: null,
  word: null,
  ask: null,
};

const CHIP_BASE =
  "inline-flex h-7 max-w-[16rem] min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-[12.5px] leading-none whitespace-nowrap outline-none transition-[background-color,color,box-shadow] duration-150 ease-power3-out focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-3 [&_svg]:shrink-0";
const CHIP_EMPTY = "text-subtle shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)] hover:bg-white/[0.03] hover:text-soft";
const CHIP_ON = "bg-white/[0.07] text-foreground [&_svg]:text-subtle";
const CHIP_ASK =
  "bg-[var(--tag-amber-bg)] text-[var(--tag-amber-text)] shadow-[inset_0_0_0_1px_var(--tag-amber-border)] [&_svg]:text-[var(--tag-amber-text)]";
const CHIP_PHONE = "max-md:h-[34px] max-md:px-[13px] max-md:text-[14px] max-md:[&_svg]:size-3.5";

function chipClass(state: "empty" | "on" | "ask", variant: Variant) {
  return cn(CHIP_BASE, state === "on" ? CHIP_ON : state === "ask" ? CHIP_ASK : CHIP_EMPTY, variant === "card" ? CHIP_PHONE : "h-[26px] px-[9px] text-[12px]", state !== "empty" && "max-md:-order-1");
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "")).toUpperCase();
}

export function SearchChip({
  kind,
  icon: ChipIcon,
  label,
  value,
  companyId,
  variant,
  onPick,
  onClosed,
  allow,
  taskId,
  suggested,
}: {
  allow?: (option: PadOption) => boolean;
  taskId?: string;
  suggested?: { heading: string; options: PadOption[] };
  kind: PadSearchKind;
  icon: Icon;
  label: string;
  value: PadRecord | null;
  companyId: string | null;
  variant: Variant;
  onPick: (option: PadOption | null) => void;
  onClosed: () => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ key: string; options: PadOption[]; failed?: boolean } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const key = `${kind}|${companyId ?? ""}|${query.trim()}`;
  const current = results?.key === key ? results : null;
  const named = suggested && !query.trim() ? suggested.options.filter((option) => !allow || allow(option)) : [];
  const found = current && !current.failed ? current.options.filter((option) => (!allow || allow(option)) && !named.some((item) => item.id === option.id)) : null;
  const options = found ? [...named, ...found] : named.length > 0 ? named : null;
  const active = options && options.length > 0 ? Math.min(highlight, options.length - 1) : -1;
  const noun = kind === "contact" ? "people" : kind === "company" ? "companies" : "opportunities";

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const [, , text] = key.split("|");
    const timer = window.setTimeout(() => {
      const search = taskId
        ? searchLinksForTaskAction(taskId, kind, text, companyId).then((found) => {
            if (!found.options) throw new Error(found.error);
            return found.options;
          })
        : searchTaskLinksAction(kind, text, companyId);
      search.then(
        (found) => !cancelled && setResults({ key, options: found }),
        () => !cancelled && setResults({ key, options: [], failed: true }),
      );
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, key, kind, companyId, taskId]);

  function optionRow(option: PadOption, index: number) {
    return (
      <li
        key={option.id}
        id={`${id}-option-${index}`}
        role="option"
        aria-selected={option.id === value?.id}
        onMouseEnter={() => setHighlight(index)}
        onClick={() => choose(option)}
        className={cn(
          "flex cursor-pointer flex-col rounded-lg px-2.5 py-1.5 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:justify-center",
          index === active && "bg-white/5",
          index > 0 && index === named.length && "relative mt-2 before:absolute before:inset-x-2.5 before:-top-1 before:h-px before:bg-line-subtle",
        )}
      >
        <span className="ui-style text-foreground truncate">{option.name}</span>
        {option.detail && <span className="caption-style text-subtle truncate">{option.detail}</span>}
      </li>
    );
  }

  function choose(option: PadOption | null) {
    setOpen(false);
    setQuery("");
    setHighlight(0);
    onPick(option);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={value ? `${label}: ${value.name}. Change` : `Link ${label.toLowerCase()}`} className={chipClass(value ? "on" : "empty", variant)}>
          <ChipIcon aria-hidden />
          <span className="truncate">{value?.name ?? label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(19rem,calc(100vw-2rem))] p-1"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onClosed();
        }}
      >
        <div className="p-1">
          <label htmlFor={`${id}-search`} className="sr-only">
            Search {noun}
          </label>
          <Input
            id={`${id}-search`}
            role="combobox"
            aria-expanded
            aria-controls={`${id}-list`}
            aria-activedescendant={active >= 0 ? `${id}-option-${active}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            value={query}
            placeholder={`Search ${noun}`}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlight(0);
            }}
            onKeyDown={(event) => {
              if (!options || options.length === 0 || event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setHighlight((active + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
              } else if (event.key === "Enter" && active >= 0) {
                event.preventDefault();
                choose(options[active]);
              }
            }}
            className="h-8 px-2.5 text-[13px] max-md:h-10"
          />
        </div>
        {current?.failed && (
          <p role="alert" className="caption-style text-danger px-2.5 py-2">
            Couldn&apos;t search. Try again.
          </p>
        )}
        <ul id={`${id}-list`} role="listbox" aria-label={noun} className="flex max-h-64 flex-col overflow-y-auto">
          {named.length > 0 && (
            <li role="group" aria-labelledby={`${id}-named`} className="flex flex-col">
              <span id={`${id}-named`} role="presentation" className="caption-style text-subtle px-2.5 pt-1 pb-0.5">
                {suggested?.heading}
              </span>
              <ul role="none" className="flex flex-col">
                {(options ?? []).slice(0, named.length).map((option, index) => optionRow(option, index))}
              </ul>
            </li>
          )}
          {(options ?? []).slice(named.length).map((option, index) => optionRow(option, index + named.length))}
        </ul>
        {options && options.length === 0 && <p className="caption-style text-subtle px-2.5 py-2">No {noun} match</p>}
        {value && (
          <button
            type="button"
            onClick={() => choose(null)}
            className="ui-style text-subtle hover:text-foreground mt-1 flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-white/5 [@media(pointer:coarse)]:min-h-11"
          >
            <XIcon aria-hidden className="size-3" />
            Don&apos;t link
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

function ReminderChip({
  due,
  title,
  value,
  variant,
  onChange,
  onTime,
  onNeedDue,
  onClosed,
  asking,
  onAsking,
}: {
  due: string | null;
  title: string;
  value: number | null;
  variant: Variant;
  onChange: (value: number | null) => void;
  onTime: (time: string) => void;
  onNeedDue: () => void;
  onClosed: () => void;
  asking: boolean;
  onAsking: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  if (due && !padDueHasTime(due)) {
    const needed = value !== null;
    return (
      <ReminderTimePrompt
        title={title.trim() || "This task"}
        day={due.slice(0, 10)}
        lead={value ?? 0}
        needed={needed}
        open={asking}
        onOpenChange={onAsking}
        onSave={onTime}
        onRemove={needed ? () => onChange(null) : undefined}
        className={chipClass(needed ? "ask" : "empty", variant)}
      />
    );
  }
  const clock = due && value !== null ? reminderClock(due, value) : null;
  const label = clock ? `Remind me at ${clock}. Change` : "Remind me";
  const content = (
    <>
      <ClockIcon aria-hidden />
      <span className="truncate">{clock ?? "Remind me"}</span>
    </>
  );
  if (!due) {
    return (
      <button type="button" aria-label="Remind me. Set a due date first" onClick={onNeedDue} className={chipClass("empty", variant)}>
        {content}
      </button>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={label} className={chipClass(clock ? "on" : "empty", variant)}>
          {content}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(15rem,calc(100vw-2rem))] p-1"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onClosed();
        }}
      >
        <div role="group" aria-label="Reminder" className="flex max-h-72 flex-col overflow-y-auto">
          {[{ minutes: null, label: "No reminder" }, ...REMINDER_OPTIONS].map((option) => (
            <button
              key={option.label}
              type="button"
              aria-pressed={option.minutes === value}
              onClick={() => {
                setOpen(false);
                onChange(option.minutes);
                if (option.minutes !== null) requestReminderPermission();
              }}
              className={cn(
                "ui-style text-soft hover:text-foreground flex cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-white/5 [@media(pointer:coarse)]:min-h-11",
                option.minutes === value && "text-foreground",
              )}
            >
              {option.label}
              {option.minutes === value && <CheckIcon aria-hidden className="text-subtle size-3.5" />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ClickUpButton({
  picker,
  listId,
  onChange,
  onClosed,
}: {
  picker: ClickUpPicker;
  listId: string | null;
  onChange: (listId: string | null) => void;
  onClosed: () => void;
}) {
  const [open, setOpen] = useState(false);
  const current = picker.lists.find((list) => list.id === listId) ?? null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="md"
          aria-label={current ? `ClickUp list: ${current.name}. Change` : "ClickUp list: not added. Change"}
          className="hit min-w-0 gap-1.5 px-2.5 text-[13px]"
        >
          <ListIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">{current ? current.name : "ClickUp list"}</span>
          <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(18rem,calc(100vw-2rem))] p-1.5"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onClosed();
        }}
      >
        <div className="flex max-h-72 flex-col overflow-y-auto">
          {listGroups(picker.lists).map((group) => (
            <div key={group.label} className="flex flex-col">
              <span className="caption-style text-subtle px-2.5 pt-2 pb-1">{group.label}</span>
              {group.lists.map((list) => (
                <button
                  key={list.id}
                  type="button"
                  aria-pressed={list.id === listId}
                  onClick={() => {
                    onChange(list.id);
                    setOpen(false);
                  }}
                  className={cn(
                    "text-soft hover:text-foreground cursor-pointer rounded-lg px-2.5 py-1.5 text-left text-[13.5px] hover:bg-white/5",
                    list.id === listId && "text-foreground bg-white/5",
                  )}
                >
                  {list.name}
                </button>
              ))}
            </div>
          ))}
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className="text-subtle hover:text-foreground mt-1 cursor-pointer rounded-lg px-2.5 py-1.5 text-left text-[13.5px] hover:bg-white/5"
          >
            Don&apos;t add to ClickUp
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function StaticChip({ icon: ChipIcon, label, name, variant }: { icon: Icon; label: string; name: string; variant: Variant }) {
  return (
    <span role="img" aria-label={`${label}: ${name}`} className={cn(chipClass("on", variant), "cursor-default")}>
      <ChipIcon aria-hidden />
      <span aria-hidden className="truncate">
        {name}
      </span>
    </span>
  );
}

export type PadThread = { key: string; subject: string | null };

function ThreadChip({ thread, variant, onRemove }: { thread: PadThread; variant: Variant; onRemove: () => void }) {
  const subject = thread.subject?.trim();
  const label = subject || "Email";
  return (
    <button type="button" aria-label={subject ? `Email: ${subject}. Remove` : "Email. Remove"} onClick={onRemove} className={cn(chipClass("on", variant), "max-w-[18em]")}>
      <MailIcon aria-hidden />
      <span className="truncate">{label}</span>
      <XIcon aria-hidden />
    </button>
  );
}

function DocChip({ doc, variant, onRemove }: { doc: DocPick; variant: Variant; onRemove: () => void }) {
  const title = doc.title.trim() || "Untitled";
  return (
    <button type="button" aria-label={`Doc: ${title}. Remove`} onClick={onRemove} className={cn(chipClass("on", variant), "max-w-[18em]")}>
      <DocIcon aria-hidden />
      <span className="truncate">{title}</span>
      <XIcon aria-hidden />
    </button>
  );
}

export default function TaskPad({
  clickup,
  company: fixedCompany = null,
  className,
  placeholder = "Call Jane Monday 3pm",
  initialContact = null,
  initialCompany = null,
  thread = null,
  autoFocus = false,
  members = [],
  viewerId = null,
  variant = "inline",
  onAdded,
}: {
  clickup: ClickUpPicker | null;
  company?: PadRecord | null;
  className?: string;
  placeholder?: string;
  initialContact?: PadRecord | null;
  initialCompany?: PadRecord | null;
  thread?: PadThread | null;
  autoFocus?: boolean;
  members?: AssignableMember[];
  viewerId?: string | null;
  variant?: Variant;
  onAdded?: (result: { warning?: string }) => void;
}) {
  const router = useRouter();
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [mention, setMention] = useState<Mention | null>(null);
  const muted = useRef<number | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [detected, setDetected] = useState<{ text: string; scope: string | null; value: PadDetection } | null>(null);
  const [ai, setAi] = useState<{ text: string; value: PadAiParse } | null>(null);
  const [readingTexts, setReadingTexts] = useState<{ id: number; text: string }[]>([]);
  const reading = readingTexts.some((entry) => entry.text === text);
  const readIds = useRef(0);
  const aiReads = useRef(new Map<string, { promise: Promise<PadAiParse | null>; controller: AbortController }>());
  const answers = useRef(new Map<string, PadAiParse>());
  const latestRead = useRef<(value: string) => Promise<PadAiParse | null>>(async () => null);
  const [due, setDue] = useState<Override<string | null>>(unset);
  const [reminder, setReminder] = useState<Override<number | null>>(unset);
  const [chosenDuration, setDuration] = useState<number | null>(null);
  const [repeatPick, setRepeatPick] = useState<Override<RepeatDraft | null>>(unset);
  const [repeatOver, setRepeatOver] = useState<RepeatDraft | null>(null);
  const [askingTime, setAskingTime] = useState(false);
  const [addedTime, setAddedTime] = useState<{ date: string; time: string } | null>(null);
  const startCompany = (): Override<PadRecord | null> => (initialCompany ? { set: true, value: initialCompany } : unset());
  const startContact = (): Override<PadContact | null> => (initialContact ? { set: true, value: { ...initialContact, company: null } } : unset());
  const [company, setCompany] = useState<Override<PadRecord | null>>(startCompany);
  const [contact, setContact] = useState<Override<PadContact | null>>(startContact);
  const [opportunity, setOpportunity] = useState<Override<PadRecord | null>>(unset);
  const [list, setList] = useState<Override<string | null>>(unset);
  const [owner, setOwner] = useState<string | null>(viewerId);
  const [unpinned, setUnpinned] = useState<string | null>(null);
  const pinned = thread && unpinned !== thread.key ? thread : null;
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [keptAsText, setKeptAsText] = useState<KeptReading[]>([]);
  const [justKept, setJustKept] = useState(false);
  const [picked, setPicked] = useState<{ id: string; word: string } | null>(null);
  const [askOpen, setAskOpen] = useState(true);
  const [choice, setChoice] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [docs, setDocs] = useState<DocPick[]>([]);
  const [docQuery, setDocQuery] = useState<DocQuery | null>(null);
  const docMuted = useRef<number | null>(null);
  const [docHighlight, setDocHighlight] = useState(0);
  const docFound = useDocPicks(docQuery ? docQuery.query : null, null);

  const [midnight, setMidnight] = useState(0);
  const wallToday = londonParts(new Date());
  const todayKey = dayKey(wallToday.year, wallToday.month, wallToday.day);
  useEffect(() => {
    const wall = londonParts(new Date());
    const wait = ((23 - wall.hour) * 60 + (60 - wall.minute)) * 60_000 + 1_000;
    const timer = window.setTimeout(() => setMidnight(Date.now()), wait);
    return () => window.clearTimeout(timer);
  }, [midnight]);
  const parsed = useMemo(() => parseTaskText(text, notBefore(midnight)), [text, midnight]);
  const aiFits = ai !== null && ai.text === text && parsed.unsure;
  const assignable = Boolean(viewerId) && members.length > 1;
  const assignee = members.find((member) => member.id === owner) ?? null;
  const forTeammate = assignable && ownerSetsTime(viewerId, owner);
  const aiValue = aiFits ? ai.value : null;
  const read = derive(aiValue);
  const { title, chosenDue, chosenReminder, finalDue, finalReminder, duration, needsTime, dateMarks, phrase, key } = read;
  if (keptAsText.length > 0) {
    const stillKept = keptAfterTyping(keptAsText, text, padReading(text, parsed, aiValue, []));
    if (stillKept.length !== keptAsText.length) setKeptAsText(stillKept);
  }
  const fromAi = aiValue !== null && key !== "";
  const aiShown = useRef<{ id: string; at: number } | null>(null);
  const saveKey = useRef<{ typed: string; request: Parameters<typeof addPadTaskAction>[0]; key: string } | null>(null);
  const aiShownId = fromAi ? `${text}\u0000${key}` : null;
  useEffect(() => {
    if (aiShownId === null) aiShown.current = null;
    else if (aiShown.current?.id !== aiShownId) aiShown.current = { id: aiShownId, at: Date.now() };
  }, [aiShownId]);

  function keepAsText() {
    if (!key) return;
    setKeptAsText((current) => (current.some((entry) => entry.key === key) ? current : [...current, keptReading(text, dateMarks)]));
    setDue(unset());
    setReminder(unset());
    setAddedTime(null);
    setJustKept(true);
  }

  const latestKeep = useRef({ phrase, dateMarks, keepAsText });
  useEffect(() => {
    latestKeep.current = { phrase, dateMarks, keepAsText };
  });
  useEffect(() => {
    const field = input.current;
    if (!field) return;
    const onBeforeInput = (event: InputEvent) => {
      if (event.inputType !== "deleteContentBackward" || event.isComposing || !event.cancelable) return;
      const { phrase: current, dateMarks: shownMarks, keepAsText: keep } = latestKeep.current;
      if (!current || !backspaceKeeps(shownMarks, field.selectionStart, field.selectionEnd)) return;
      event.preventDefault();
      keep();
    };
    field.addEventListener("beforeinput", onBeforeInput);
    return () => field.removeEventListener("beforeinput", onBeforeInput);
  }, []);
  const droppedTime = forTeammate && (padDueHasTime(chosenDue) || chosenReminder !== null);
  const anchor = fixedCompany ?? (company.set ? company.value : null);
  const scope = anchor?.id ?? null;
  const seen = text.trim().length >= 3 ? (detected?.value ?? null) : null;
  const shown = resolve(seen);
  const finalContact = shown.contact;
  const finalCompany = shown.company;
  const finalOpportunity = shown.opportunity;
  const ask = shown.ask;
  const finalList = clickup ? (list.set ? list.value : clickup.listId) : null;
  const asking = ask !== null && askOpen;
  const detectedContact = shown.fromText;
  const detectedCompany = !fixedCompany && !company.set && !finalContact && seen?.company && finalCompany?.id === seen.company.id;
  const confirm = seen && detectedContact ? padConfirmLine(seen) : seen && detectedCompany ? padConfirmLine({ ...seen, contact: null, matchedBy: null, word: companyWord(seen) }) : null;
  const docOptions = docFound.docs ? docFound.docs.filter((doc) => !docs.some((picked) => picked.id === doc.id)) : null;
  const docActive = docOptions && docOptions.length > 0 ? Math.min(docHighlight, docOptions.length - 1) : -1;
  const listing = mention !== null && suggestions.length > 0 && docQuery === null;
  const card = variant === "card";
  const docWarn = assignable && owner !== viewerId;

  function derive(value: PadAiParse | null) {
    const keptKeys = keptAsText.map((entry) => entry.key);
    const shown = padReading(text, parsed, value, keptKeys);
    const confirmed = chipOverrides(shown, due, repeatPick.set ? repeatPick.value : null, repeatOver) ? padReading(text, parsed, value, [...keptKeys, shown.key]) : shown;
    const typedRepeat = confirmed.repeat ?? null;
    const repeat = repeatPick.set ? repeatPick.value : typedRepeat;
    const timed = addedTime && confirmed.due === addedTime.date ? `${addedTime.date}T${addedTime.time}` : confirmed.due;
    const pickedDue = due.set ? due.value : timed;
    const chosenDue = repeat ? (padRepeatDue(repeat, pickedDue) ?? pickedDue) : pickedDue;
    const autoReminder = confirmed.remindMinutes;
    const chosenReminder = chosenDue ? (reminder.set ? reminder.value : autoReminder) : null;
    const finalDue = forTeammate && chosenDue ? chosenDue.slice(0, 10) : chosenDue;
    const finalReminder = forTeammate ? null : chosenReminder;
    return {
      typedRepeat,
      typedDue: confirmed.due,
      repeat,
      title: confirmed.title,
      dateMarks: confirmed.marks,
      phrase: confirmed.phrase,
      key: confirmed.key,
      chosenDue,
      chosenReminder,
      finalDue,
      finalReminder,
      duration: chosenDuration ?? (!due.set && padDueHasTime(chosenDue) ? confirmed.durationMinutes : null) ?? DEFAULT_TASK_DURATION,
      needsTime: Boolean(finalDue) && !padDueHasTime(finalDue) && finalReminder !== null,
    };
  }

  function readWithAi(value: string): Promise<PadAiParse | null> {
    const apply = (found: PadAiParse | null) => {
      if (found) setAi((current) => (current?.text === value && current.value === found ? current : { text: value, value: found }));
      return found;
    };
    if (padAi.available === false) return Promise.resolve(null);
    const key = readKey(value);
    const answered = answers.current.get(key);
    if (answered) return Promise.resolve(apply(answered));
    const known = aiReads.current.get(key);
    if (known) return known.promise.then(apply);
    const controller = new AbortController();
    readIds.current += 1;
    const id = readIds.current;
    setReadingTexts((current) => [...current, { id, text: value }]);
    const promise = fetch(AI_READ_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: value }),
      signal: controller.signal,
    })
      .then((response) => (response.ok ? (response.json() as Promise<PadReadBody>) : null))
      .catch(() => null)
      .then((body) => {
        if (aiReads.current.get(key)?.controller === controller) aiReads.current.delete(key);
        setReadingTexts((current) => current.filter((entry) => entry.id !== id));
        if (body?.available === false) padAi.available = false;
        const found = controller.signal.aborted ? null : (body?.value ?? null);
        if (found) answers.current.set(key, found);
        return found;
      });
    aiReads.current.set(key, { promise, controller });
    return promise.then(apply);
  }

  function forgetAiReads() {
    for (const read of aiReads.current.values()) read.controller.abort();
    aiReads.current.clear();
    answers.current.clear();
    setReadingTexts([]);
  }

  function resolve(found: PadDetection | null) {
    return resolvePadLinks({ text, found, fixedCompany, contact, company, opportunity, dismissed });
  }

  function companyWord(found: PadDetection) {
    const name = found.company?.name.trim() ?? "";
    return name && !/\s/.test(name) && nameMarks(text, [name]).length > 0 ? name : null;
  }

  function allowed(option: PadOption) {
    return !fixedCompany || padFits(fixedCompany, option);
  }

  useEffect(() => {
    const node = input.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
  }, [text]);

  useEffect(() => {
    if (text.trim().length < 3) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void detectTaskRecordsAction(text, scope).then(
        (value) => !cancelled && setDetected({ text, scope, value }),
        () => undefined,
      );
    }, 450);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [text, scope]);

  useEffect(() => {
    latestRead.current = readWithAi;
  });

  useEffect(() => {
    const reads = aiReads.current;
    return () => {
      for (const read of reads.values()) read.controller.abort();
      reads.clear();
    };
  }, []);

  useEffect(() => {
    if (!parsed.unsure || text.trim().length < 4 || padAi.available === false) return;
    const timer = window.setTimeout(() => void latestRead.current(text), 700);
    return () => window.clearTimeout(timer);
  }, [text, parsed.unsure]);

  useEffect(() => {
    if (!mention) return;
    let cancelled = false;
    const query = mention.query.trim();
    const timer = window.setTimeout(() => {
      void Promise.all([
        fixedCompany ? Promise.resolve([]) : searchTaskLinksAction("company", query),
        searchTaskLinksAction("contact", query, fixedCompany?.id ?? null),
      ]).then(
        ([companies, people]) => {
          if (cancelled) return;
          setSuggestions([
            ...people.filter((option) => padFits(fixedCompany, option)).slice(0, 5).map((option) => ({ kind: "contact" as const, option })),
            ...companies.slice(0, 5).map((option) => ({ kind: "company" as const, option })),
          ]);
          setHighlight(0);
        },
        () => !cancelled && setSuggestions([]),
      );
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mention, fixedCompany]);

  function refreshMention(value: string, caret: number) {
    const found = stripMention(value, caret);
    if (found && found.start === muted.current) {
      setMention(null);
      return;
    }
    muted.current = null;
    setMention(found);
  }

  function refreshDocQuery(value: string, caret: number) {
    const found = docQueryAt(value, caret);
    if (docMuted.current !== null && value.slice(docMuted.current, docMuted.current + 2) !== "[[") docMuted.current = null;
    if (found && found.start === docMuted.current) {
      setDocQuery(null);
      return;
    }
    setDocQuery((current) => (current && found && current.start === found.start && current.end === found.end && current.query === found.query ? current : found));
    if (!found || found.query !== docQuery?.query) setDocHighlight(0);
  }

  function pickDoc(doc: DocPick) {
    if (docQuery) {
      const next = withoutDocQuery(text, docQuery);
      setText(next.text);
      focusAt(next.caret);
    } else focusAt();
    setDocQuery(null);
    setDocHighlight(0);
    setDocs((current) => (current.some((item) => item.id === doc.id) ? current : [...current, doc]));
  }

  function linkContact(option: PadOption | null) {
    setContact({ set: true, value: option ? { id: option.id, name: option.name, company: option.company } : null });
    if (!option?.company || fixedCompany) return;
    setCompany({ set: true, value: option.company });
    if (finalOpportunity && finalCompany?.id !== option.company.id) setOpportunity({ set: true, value: null, side: true });
  }

  function linkCompany(option: PadOption | null) {
    setCompany({ set: true, value: option ? { id: option.id, name: option.name } : null });
    if (option?.id !== finalCompany?.id) {
      if (finalOpportunity) setOpportunity({ set: true, value: null, side: true });
      if (finalContact?.company && finalContact.company.id !== option?.id) setContact({ set: true, value: null, side: true });
    }
  }

  function linkOpportunity(option: PadOption | null) {
    setOpportunity({ set: true, value: option ? { id: option.id, name: option.name } : null });
    if (!option?.company || fixedCompany) return;
    setCompany({ set: true, value: option.company });
    if (finalContact?.company && finalContact.company.id !== option.company.id) setContact({ set: true, value: null, side: true });
  }

  function forgetSideClears() {
    setContact(padRelease);
    setCompany(padRelease);
    setOpportunity(padRelease);
  }

  function pick(suggestion: Suggestion) {
    if (!mention) return;
    const after = text.slice(mention.end).replace(/^\s+/, "");
    const inserted = `${suggestion.option.name} `;
    const next = `${text.slice(0, mention.start)}${inserted}${after}`;
    const caret = mention.start + inserted.length;
    setText(next);
    setMention(null);
    setSuggestions([]);
    if (suggestion.kind === "company") linkCompany(suggestion.option);
    else linkContact(suggestion.option);
    focusAt(caret);
  }

  function focusAt(caret?: number) {
    window.requestAnimationFrame(() => {
      const node = input.current;
      if (!node) return;
      node.focus();
      if (caret !== undefined) node.setSelectionRange(caret, caret);
    });
  }

  function answer(option: PadOption | null) {
    if (option) {
      linkContact(option);
      if (ask) setPicked({ id: option.id, word: ask.word });
    } else if (ask) setDismissed((current) => [...current, ask.word]);
    setChoice(0);
    focusAt();
  }

  function reset() {
    setText("");
    setMention(null);
    setSuggestions([]);
    setDetected(null);
    setAi(null);
    forgetAiReads();
    setDue(unset());
    setReminder(unset());
    setDuration(null);
    setRepeatPick(unset());
    setRepeatOver(null);
    setAskingTime(false);
    setAddedTime(null);
    setCompany(startCompany());
    setContact(startContact());
    setOpportunity(unset());
    setList(unset());
    setOwner(viewerId);
    setDismissed([]);
    setKeptAsText([]);
    setPicked(null);
    setAskOpen(true);
    setChoice(0);
    setDocs([]);
    setDocQuery(null);
    setDocHighlight(0);
  }

  async function freshDetection() {
    if (text.trim().length < 3) return { value: NOTHING, failed: false };
    if (detected && detected.text === text && detected.scope === scope) return { value: detected.value, failed: false };
    try {
      const value = await detectTaskRecordsAction(text, scope);
      setDetected({ text, scope, value });
      return { value, failed: false };
    } catch {
      return { value: null, failed: true };
    }
  }

  async function submit() {
    if (busy || !title.trim()) return;
    if (needsTime) {
      setAskingTime(true);
      return;
    }
    setBusy(true);
    const saving = readingToSave(read, derive(null), fromAi ? { shownAt: aiShown.current?.id === aiShownId ? aiShown.current.at : null } : null);
    setError(null);
    setWarning(null);
    const fresh = await freshDetection();
    const links = fresh.value ? resolve(fresh.value) : null;
    if (
      links &&
      fresh.value &&
      padNeedsConfirm(
        { contactId: finalContact?.id ?? null, companyId: finalCompany?.id ?? null, ask: ask?.word ?? null },
        {
          contactId: links.contact?.id ?? null,
          companyId: links.company?.id ?? null,
          ask: links.ask?.word ?? null,
          contactByName: links.fromText && fresh.value.matchedBy === "name",
          companyOneWord:
            Boolean(links.company && fresh.value.company && links.company.id === fresh.value.company.id) &&
            !/\s/.test(fresh.value.company?.name.trim() ?? "") &&
            links.company?.id !== links.contact?.company?.id &&
            !(links.opportunity && fresh.value.opportunity?.id === links.opportunity.id && fresh.value.opportunity.companyId === links.company?.id),
        },
      )
    ) {
      setBusy(false);
      focusAt();
      return;
    }
    const savingDue = saving.finalDue;
    const request = {
      title: saving.title,
      dueAt: savingDue && padDueHasTime(savingDue) ? localInstant(savingDue) : savingDue,
      ...(saving.repeat ? { repeat: repeatInputOf(saving.repeat.rule, saving.repeat.ends) } : {}),
      remindMinutes: saving.finalReminder,
      durationMinutes: saving.duration,
      ...padSaveIds(links, { fixedCompany, contact, company, opportunity }),
      clickupListId: finalList,
      ownerId: assignable ? owner : null,
      mailThreadKey: pinned?.key ?? null,
      ...(docs.length > 0 ? { docIds: docs.map((doc) => doc.id) } : {}),
    };
    const typed = JSON.stringify({ ...request, dueAt: null, repeat: null, text, due, repeatPick, addedTime });
    if (saveKey.current?.typed !== typed) saveKey.current = { typed, request, key: crypto.randomUUID() };
    const attempt = saveKey.current;
    const result = await addPadTaskAction({ ...attempt.request, key: attempt.key }).catch(() => null);
    setBusy(false);
    if (!result || result.error) {
      if (result) saveKey.current = null;
      setError(result?.error ?? "Couldn't add the task. Try again.");
      return;
    }
    saveKey.current = null;
    const notes = result.warning ?? undefined;
    reset();
    router.refresh();
    if (onAdded) {
      onAdded({ warning: notes });
      return;
    }
    setWarning(notes ?? null);
    input.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Backspace" && !event.metaKey && !event.altKey && !event.ctrlKey && phrase && !due.set) {
      const field = event.currentTarget;
      if (backspaceKeeps(dateMarks, field.selectionStart, field.selectionEnd)) {
        event.preventDefault();
        keepAsText();
        return;
      }
    }
    if (docQuery) {
      const count = docOptions?.length ?? 0;
      if (event.key === "Enter" && !event.shiftKey && docFound.loading) {
        event.preventDefault();
        return;
      }
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && count > 0) {
        event.preventDefault();
        setDocHighlight((docActive + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && docOptions && docActive >= 0 && !docFound.loading) {
        event.preventDefault();
        pickDoc(docOptions[docActive]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        docMuted.current = docQuery.start;
        setDocQuery(null);
        return;
      }
    }
    if (listing) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setHighlight((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pick(suggestions[highlight]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        muted.current = mention?.start ?? null;
        setMention(null);
        return;
      }
    }
    if (asking && ask) {
      const count = ask.candidates.length + 1;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setChoice((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
        return;
      }
      if (event.key === "Tab" && !event.shiftKey) {
        event.preventDefault();
        answer(ask.candidates[choice] ?? null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  const names = [
    finalContact?.name,
    finalCompany?.name,
    finalOpportunity?.name,
    detectedContact ? seen?.word : null,
    picked && finalContact?.id === picked.id ? picked.word : null,
  ].filter((name): name is string => Boolean(name));
  const marks = mergeMarks([
    ...dateMarks,
    ...parsed.marks.filter((mark) => mark.kind !== "when" && mark.kind !== "reminder"),
    ...nameMarks(text, names),
    ...(ask ? nameMarks(text, [ask.word], "ask") : []),
    ...(docQuery ? [{ start: docQuery.start, end: docQuery.end, kind: "record" as const }] : []),
  ]);
  const pieces: { text: string; kind: PadMark["kind"] | null }[] = [];
  let cursor = 0;
  for (const mark of marks) {
    if (mark.start > cursor) pieces.push({ text: text.slice(cursor, mark.start), kind: null });
    pieces.push({ text: text.slice(mark.start, mark.end), kind: mark.kind });
    cursor = mark.end;
  }
  pieces.push({ text: `${text.slice(cursor)}\u200b`, kind: null });

  const typeClass = card
    ? "text-[17px] leading-6 tracking-[-0.005em] [@media(pointer:coarse)]:text-[16px]"
    : "text-[15px] leading-[22px] [@media(pointer:coarse)]:text-[16px]";

  const person: ReactNode = ask ? (
    <button
      key="person"
      type="button"
      aria-expanded={askOpen}
      aria-controls={`${id}-which`}
      aria-label={`Which ${ask.word}? ${askOpen ? "Hide" : "Show"} the choices`}
      onClick={() => setAskOpen((current) => !current)}
      className={chipClass("ask", variant)}
    >
      <UserIcon aria-hidden />
      <span className="truncate">{ask.word}?</span>
      <ChevronDownIcon aria-hidden className={cn("transition-transform duration-150 ease-power3-out", askOpen && "rotate-180")} />
    </button>
  ) : (
    <SearchChip key="person" kind="contact" icon={UserIcon} label="Person" value={finalContact} companyId={anchor?.id ?? null} allow={allowed} variant={variant} onPick={linkContact} onClosed={() => focusAt()} />
  );

  const repeatAnchor = finalDue ? finalDue.slice(0, 10) : todayKey;
  const repeatAt = finalDue && padDueHasTime(finalDue) ? finalDue.slice(11, 16) : null;
  const repeatPattern = read.repeat ? { startsOn: repeatAnchor, at: repeatAt, rule: read.repeat.rule, ends: read.repeat.ends } : null;
  const repeatWords = repeatPattern ? `${repeatPhrase(repeatPattern)}${"never" in repeatPattern.ends ? "" : `, ${endWords(repeatPattern)}`}` : null;

  function pickRepeat(value: RepeatDraft | null) {
    if (!value) {
      const pickedDue = due;
      const pickedReminder = reminder;
      if (read.typedRepeat) keepAsText();
      if (pickedDue.set) {
        setDue(pickedDue);
        setReminder(pickedReminder);
      }
      setRepeatPick(unset());
      setRepeatOver(null);
      focusAt();
      return;
    }
    setRepeatOver(read.typedRepeat);
    setRepeatPick({ set: true, value });
  }

  function pickDue(value: string | null) {
    setDue({ set: true, value });
    const current = read.repeat;
    if (!repeatPick.set || !current || !value) return;
    const followed = repeatPresets(repeatAnchor).find((preset) => FOLLOWS_DATE.includes(preset.id) && sameRule(preset.rule, current.rule));
    const next = repeatPresets(value.slice(0, 10));
    const fourth = followed?.rule.monthWeek?.n === 4;
    const moved = followed ? (fourth && next.find((preset) => preset.id === "monthly-fourth")) || next.find((preset) => preset.id === (followed.id === "monthly-fourth" ? "monthly-week" : followed.id)) : null;
    if (moved) setRepeatPick({ set: true, value: { rule: moved.rule, ends: current.ends } });
  }

  const repeatTrigger = (
    <Button
      variant="chip"
      size="none"
      aria-label={repeatWords ? `${repeatWords}. Change` : "Repeat"}
      className={repeatWords ? "hit min-w-0 shrink gap-1.5 text-inherit hover:bg-transparent hover:text-inherit h-auto text-left leading-snug whitespace-normal" : chipClass("empty", variant)}
    >
      <RepeatIcon aria-hidden className={cn(repeatWords && "!text-(--tag-purple-text)")} />
      {repeatWords && <span className="min-w-0">{repeatWords}</span>}
    </Button>
  );

  const chips: ReactNode[] = [
    <DueDatePicker
      key="due"
      id={`${id}-due`}
      aria-label={finalDue ? `Due ${padDueHasTime(finalDue) ? formatDateTimeLabel(finalDue) : formatDateLabel(finalDue)}. Change` : "Due date"}
      placeholder="Due"
      value={finalDue ?? ""}
      onChange={(value) => pickDue(value || null)}
      className={cn(
        chipClass(finalDue ? "on" : "empty", variant),
        "w-auto border-0 bg-transparent",
        finalDue && "bg-white/[0.07]",
        "[&>span]:text-inherit",
      )}
    />,
    repeatWords ? (
      <span key="repeat" className={cn(chipClass("on", variant), "h-auto max-w-full cursor-default gap-1 py-1.5 pr-1 whitespace-normal max-md:max-w-[calc(100vw-5.5rem)] max-md:h-auto max-md:pr-1 [@media(pointer:coarse)]:mr-1.5 md:[@media(pointer:coarse)]:my-1.5", card ? "min-h-7 max-md:min-h-[34px]" : "min-h-[26px]")}>
        <RepeatPicker anchor={repeatAnchor} at={repeatAt} value={read.repeat} onChange={pickRepeat} onClosed={() => focusAt()} trigger={repeatTrigger} />
        <Button
          variant="ghost"
          size="none"
          aria-label="Don't repeat"
          onClick={() => pickRepeat(null)}
          className="hit size-5 hover:bg-white/10 active:scale-100 [@media(pointer:coarse)]:ml-3 [@media(pointer:coarse)]:size-6"
        >
          <XIcon aria-hidden />
        </Button>
      </span>
    ) : (
      <RepeatPicker key="repeat" anchor={repeatAnchor} at={repeatAt} value={null} onChange={pickRepeat} onClosed={() => focusAt()} trigger={repeatTrigger} />
    ),
    phrase && !due.set ? (
      <button
        key="keep"
        type="button"
        onClick={() => {
          keepAsText();
          focusAt();
        }}
        aria-label={`Keep as text: ${phrase}`}
        title={read.typedRepeat ? "Keep these words in the title and drop the date and repeat" : "Keep these words in the title and drop the date"}
        className={cn(chipClass("empty", variant), "hit")}
      >
        <span className="truncate">Keep as text</span>
      </button>
    ) : null,
    <DurationMenu key="duration" compact value={duration} onChange={setDuration} className={chipClass(duration === DEFAULT_TASK_DURATION ? "empty" : "on", variant)} />,
    forTeammate ? null : <ReminderChip
      key="reminder"
      due={finalDue}
      title={title}
      value={finalReminder}
      variant={variant}
      asking={askingTime}
      onAsking={(open) => {
        setAskingTime(open);
        if (!open) focusAt();
      }}
      onChange={(value) => setReminder({ set: true, value })}
      onTime={(time) => {
        if (!finalDue) return;
        if (due.set || read.typedDue?.slice(0, 10) !== finalDue.slice(0, 10)) setDue({ set: true, value: `${finalDue.slice(0, 10)}T${time}` });
        else setAddedTime({ date: finalDue.slice(0, 10), time });
        setReminder({ set: true, value: finalReminder ?? 0 });
      }}
      onNeedDue={() => document.getElementById(`${id}-due`)?.click()}
      onClosed={() => focusAt()}
    />,
    person,
    fixedCompany ? (
      <StaticChip key="company" icon={BuildingIcon} label="Company" name={fixedCompany.name} variant={variant} />
    ) : (
      <SearchChip key="company" kind="company" icon={BuildingIcon} label="Company" value={finalCompany} companyId={null} variant={variant} onPick={linkCompany} onClosed={() => focusAt()} />
    ),
    <SearchChip
      key="opportunity"
      kind="opportunity"
      icon={ClipboardIcon}
      label="Opportunity"
      value={finalOpportunity}
      companyId={finalCompany?.id ?? null}
      variant={variant}
      onPick={linkOpportunity}
      onClosed={() => focusAt()}
    />,
    ...docs.map((doc) => (
      <DocChip
        key={`doc-${doc.id}`}
        doc={doc}
        variant={variant}
        onRemove={() => {
          setDocs((current) => current.filter((item) => item.id !== doc.id));
          focusAt();
        }}
      />
    )),
    <DocPickPopover key="doc" taskId={null} warn={docWarn} exclude={docs.map((doc) => doc.id)} onPick={pickDoc} onClosed={() => focusAt()}>
      <button type="button" aria-label="Link a doc" className={chipClass("empty", variant)}>
        <DocIcon aria-hidden />
        <span className="truncate">Doc</span>
      </button>
    </DocPickPopover>,
  ];
  if (pinned) {
    chips.push(
      <ThreadChip
        key="thread"
        thread={pinned}
        variant={variant}
        onRemove={() => {
          setUnpinned(pinned.key);
          focusAt();
        }}
      />,
    );
  }
  if (assignable && viewerId) {
    const someoneElse = owner !== viewerId && assignee;
    chips.push(
      <AssigneePicker
        key="assignee"
        members={members}
        value={owner}
        viewerId={viewerId}
        onPick={setOwner}
        label={`Assignee: ${owner === viewerId ? "you" : (assignee?.name ?? "no one")}. Change`}
        triggerClassName={chipClass(someoneElse ? "on" : "empty", variant)}
        trigger={
          <>
            {someoneElse ? <MemberAvatar member={assignee} viewerId={viewerId} size="xs" /> : <UserCircleIcon aria-hidden />}
            <span className="truncate">{someoneElse ? assignee.name : "Assignee"}</span>
          </>
        }
      />,
    );
  }

  const field = (
    <div className={cn("relative", card ? "px-[18px] pt-4 pb-3 max-md:pt-3" : "px-3.5 pt-3 pb-2.5")}>
      <label htmlFor={`${id}-text`} className="sr-only">
        New task
      </label>
      <div className="relative min-w-0">
        <div aria-hidden className={cn("text-foreground pointer-events-none absolute inset-0 overflow-hidden break-words whitespace-pre-wrap", typeClass)}>
          <div style={{ transform: `translateY(-${scrollTop}px)` }}>
            {pieces.map((piece, index) =>
              piece.kind ? (
                <mark
                  key={index}
                  className={cn(
                    "rounded-[4px] text-inherit",
                    piece.kind === "record"
                      ? "bg-[var(--tag-purple-bg)] text-[var(--tag-purple-text)] shadow-[0_0_0_2px_var(--tag-purple-bg)]"
                      : piece.kind === "ask"
                        ? "bg-[var(--tag-amber-bg)] text-[var(--tag-amber-text)] shadow-[0_0_0_2px_var(--tag-amber-bg)]"
                        : "bg-[var(--tag-blue-bg)] text-[var(--tag-blue-text)] shadow-[0_0_0_2px_var(--tag-blue-bg)]",
                  )}
                >
                  {piece.text}
                </mark>
              ) : (
                <span key={index}>{piece.text}</span>
              ),
            )}
          </div>
        </div>
        <p role="status" className="sr-only">
          {phrase && !due.set ? (read.typedRepeat ? `Repeat read from “${phrase}”.` : `Due date read from “${phrase}”.`) : justKept ? (finalDue ? "Kept as text." : "Kept as text. No date.") : ""}
        </p>
        <textarea
          id={`${id}-text`}
          ref={input}
          rows={1}
          autoFocus={autoFocus}
          value={text}
          data-shortcut="add-record"
          data-mention-open={listing || docQuery ? "" : undefined}
          readOnly={busy}
          aria-busy={busy || undefined}
          placeholder={placeholder}
          enterKeyHint="done"
          onChange={(event) => {
            setText(event.target.value);
            setJustKept(false);
            setError(null);
            forgetSideClears();
            if (!event.target.value.trim()) {
              setDetected(null);
              setAi(null);
              setDue(unset());
              setReminder(unset());
              setRepeatPick(unset());
              setRepeatOver(null);
              setAddedTime(null);
              setCompany(startCompany());
              setContact(startContact());
              setOpportunity(unset());
              setDismissed([]);
              setKeptAsText([]);
              setPicked(null);
              setAskOpen(true);
            }
            setChoice(0);
            refreshMention(event.target.value, event.target.selectionStart ?? event.target.value.length);
            refreshDocQuery(event.target.value, event.target.selectionStart ?? event.target.value.length);
          }}
          onSelect={(event) => {
            refreshMention(event.currentTarget.value, event.currentTarget.selectionStart ?? 0);
            refreshDocQuery(event.currentTarget.value, event.currentTarget.selectionStart ?? 0);
          }}
          onKeyDown={onKeyDown}
          onBlur={() =>
            window.setTimeout(() => {
              setMention(null);
              setDocQuery(null);
            }, 150)
          }
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          className={cn(
            "placeholder:text-subtle caret-foreground selection:bg-primary/40 relative m-0 block max-h-40 w-full resize-none overflow-x-hidden border-0 bg-transparent p-0 text-transparent outline-none",
            typeClass,
          )}
        />
      </div>
      {listing && (
        <ul
          aria-label="Link a contact or company"
          className={cn(
            "bg-popover border-line-strong overflow-hidden rounded-xl border p-1",
            card ? "mt-2 w-full" : "shadow-overlay absolute top-full left-3 z-30 -mt-1 w-[min(22rem,calc(100%-1.5rem))]",
          )}
        >
          {suggestions.map((suggestion, index) => (
            <li key={`${suggestion.kind}-${suggestion.option.id}`}>
              <button
                type="button"
                aria-current={index === highlight || undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(suggestion)}
                className={cn(
                  "flex w-full cursor-pointer flex-col items-start rounded-lg px-2.5 py-1.5 text-left",
                  index === highlight ? "bg-white/[0.07]" : "hover:bg-white/5",
                )}
              >
                <span className="text-foreground truncate text-[13.5px] leading-5">{suggestion.option.name}</span>
                <span className="caption-style text-subtle truncate">
                  {suggestion.kind === "company" ? "Company" : "Contact"}
                  {suggestion.option.detail ? ` · ${suggestion.option.detail}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {docQuery && (
        <div
          aria-label="Link a doc"
          role="group"
          className={cn(
            "bg-popover border-line-strong overflow-hidden rounded-xl border p-1",
            card ? "mt-2 w-full" : "shadow-overlay absolute top-full left-3 z-30 -mt-1 w-[min(24rem,calc(100%-1.5rem))]",
          )}
        >
          <DocPickHeader query={docQuery.query} docs={docOptions} loading={docFound.loading} />
          <DocPickNotice query={docQuery.query} docs={docOptions} failed={docFound.failed} />
          {docOptions && docOptions.length > 0 && (
            <DocPickOptions id={`${id}-docs`} docs={docOptions} query={docQuery.query} active={docActive} warn={docWarn} buttons onHover={setDocHighlight} onPick={pickDoc} />
          )}
        </div>
      )}
    </div>
  );

  const chipRow = (
    <fieldset
      aria-label="Task details"
      disabled={busy}
      className={cn(
        "m-0 flex min-w-0 items-center gap-1.5 border-0 p-0 disabled:opacity-60",
        "flex-wrap max-md:-my-2 max-md:flex-nowrap max-md:overflow-x-auto max-md:overflow-y-hidden max-md:overscroll-x-contain max-md:py-2 max-md:pr-10 max-md:[mask-image:linear-gradient(to_right,black_calc(100%-40px),transparent)] max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden",
        card ? "px-3.5" : "order-1 flex-1 max-md:-ml-3 max-md:pl-3 @max-[36rem]:basis-full",
      )}
    >
      {chips}
    </fieldset>
  );

  const which = ask && askOpen && (
    <div id={`${id}-which`} className={cn("rounded-xl bg-white/[0.03] p-1.5", card ? "mx-3.5 mt-2.5" : "-ml-1")}>
      <div className="caption-style text-subtle flex items-center gap-2 px-2 pt-1 pb-1.5">
        <span id={`${id}-which-label`}>Which {ask.word}?</span>
        <span className="text-faint ml-auto max-md:hidden">Nothing is linked until you pick</span>
      </div>
      <ul aria-labelledby={`${id}-which-label`} className="flex flex-col">
        {[...ask.candidates, null].map((option, index) => (
          <li key={option?.id ?? "none"}>
            <button
              type="button"
              aria-current={index === choice || undefined}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setChoice(index)}
              onClick={() => answer(option)}
              className={cn(
                "group flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-2 py-[7px] text-left [@media(pointer:coarse)]:min-h-11",
                index === choice && "bg-white/5",
              )}
            >
              <span
                aria-hidden
                className="bg-muted text-soft flex size-[26px] shrink-0 items-center justify-center rounded-full text-[10px] font-medium shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]"
              >
                {option ? initials(option.name) : <XIcon className="size-3" />}
              </span>
              {option ? (
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="ui-style text-foreground truncate">{option.name}</span>
                  {option.detail && <span className="caption-style text-subtle truncate">{option.detail}</span>}
                </span>
              ) : (
                <span className="ui-style text-subtle flex-1">Don&apos;t link</span>
              )}
              {option && (
                <kbd
                  aria-hidden
                  className={cn(
                    "inline-flex h-4 min-w-4 items-center justify-center rounded-[4px] bg-white/12 px-1 font-sans text-[10.5px] leading-none font-medium opacity-0 [@media(pointer:coarse)]:hidden",
                    index === choice && "opacity-70",
                  )}
                >
                  Tab
                </kbd>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );

  const announce = (
    <p role="status" className="sr-only">
      {ask ? `Which ${ask.word}? ${ask.candidates.length === 1 ? "1 person" : `${ask.candidates.length} people`} to choose from, or Don't link.` : ""}
    </p>
  );

  const notes = (
    <>
      {confirm && !asking && (
        <p role="status" className={cn("caption-style text-subtle flex items-start gap-2", card ? "px-[18px] pt-2.5" : "px-0.5")}>
          <CheckIcon aria-hidden className="text-success mt-0.5 size-3 shrink-0" />
          <span className="min-w-0">{confirm}</span>
        </p>
      )}
      {which}
      {error && (
        <p role="alert" className={cn("caption-style text-danger", card ? "px-[18px] pt-2.5" : "px-0.5")}>
          {error}
        </p>
      )}
      {droppedTime && !error && (
        <p role="status" className={cn("caption-style text-soft", card ? "px-[18px] pt-2.5" : "px-0.5")}>
          {dayOnlyHint(assignee?.name)}
        </p>
      )}
      {warning && !error && (
        <p role="status" className={cn("caption-style text-soft", card ? "px-[18px] pt-2.5" : "px-0.5")}>
          {warning}
        </p>
      )}
    </>
  );

  const add = (
    <Button
      variant="primary"
      size="md"
      shortcut={["↵"]}
      disabled={busy || !title.trim()}
      onClick={() => void submit()}
      className="hit shrink-0 px-3.5 text-[13px] max-md:text-[14px]"
    >
      Add task
    </Button>
  );

  const status = reading && (
    <span role="status" className="caption-style text-subtle shrink-0">
      Reading…
    </span>
  );

  if (card) {
    return (
      <div className={cn("flex flex-col", className)}>
        {announce}
        {field}
        {chipRow}
        {notes}
        <div className="flex items-center gap-2 p-3 pl-2.5 max-md:pt-3 max-md:pb-2.5">
          {clickup && <ClickUpButton picker={clickup} listId={finalList} onChange={(value) => setList({ set: true, value })} onClosed={() => focusAt()} />}
          {status}
          <span className="flex-1" />
          {add}
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      {announce}
      <div className="bg-surface-panel @container flex flex-col rounded-2xl shadow-[inset_0_0_0_1px_var(--line-subtle)]">
        {field}
        <div className="flex flex-wrap items-center gap-2 pr-2 pb-2 pl-3">
          {chipRow}
          <div className="order-2 ml-auto flex shrink-0 items-center gap-2 @max-[36rem]:order-4">
            {status}
            {clickup && <ClickUpButton picker={clickup} listId={finalList} onChange={(value) => setList({ set: true, value })} onClosed={() => focusAt()} />}
            {add}
          </div>
          {(confirm || which || error || warning || droppedTime) && <div className="order-3 flex basis-full flex-col gap-1.5 pr-1">{notes}</div>}
        </div>
      </div>
    </div>
  );
}
