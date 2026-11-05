"use client";

import { useState, type ComponentType, type SVGProps } from "react";
import Button from "@/components/_ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/_ui/dropdown-menu";
import Tag from "@/components/_ui/tag";
import { EntityChip, Monogram } from "@/components/beautifui/record-marks";
import { KEYBOARD_ROW_CLASS } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import ArchiveIcon from "@/public/assets/images/mail/archive.svg";
import ClockIcon from "@/public/assets/images/mail/clock.svg";
import FollowUpIcon from "@/public/assets/images/mail/follow-up.svg";
import SparkleIcon from "@/public/assets/images/mail/sparkle.svg";
import MoreIcon from "@/public/assets/images/_common/more.svg";
import PhoneIcon from "@/public/assets/images/_common/phone.svg";
import MicIcon from "@/public/assets/images/_common/mic.svg";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import ChevronRightIcon from "@/public/assets/images/_common/chevron-right.svg";
import ZapIcon from "@/public/assets/images/companies/sidebar/zap.svg";
import { SECTIONS, type ActionData, type ActionItem, type ApprovalItem, type SectionId } from "./mock-data";

type Filter = "all" | SectionId;

type Act = {
  label: string;
  variant: "primary" | "secondary" | "subtle" | "ghost";
  clears?: string;
  snooze?: boolean;
  phoneMore?: boolean;
  shortcut?: string;
};

type Swipe = { id: string; side: "left" | "right" };

const SNOOZE_CHOICES = [
  { label: "Later today", detail: "Thu 17:00" },
  { label: "Tomorrow", detail: "Fri 08:00" },
  { label: "Next week", detail: "Mon 08:00" },
];

export type ListOptions = {
  initialFilter?: Filter;
  initialCleared?: string[];
  toast?: string | null;
  activeRow?: string | null;
  openSnooze?: string | null;
  openMore?: string | null;
  swipes?: Swipe[];
  others?: ApprovalItem[];
};

export default function ActionList({ data, options = {} }: { data: ActionData; options?: ListOptions }) {
  const [filter, setFilter] = useState<Filter>(options.initialFilter ?? "all");
  const [cleared, setCleared] = useState<string[]>(options.initialCleared ?? []);
  const [toast, setToast] = useState<{ message: string; id: string | null } | null>(
    options.toast ? { message: options.toast, id: options.initialCleared?.at(-1) ?? null } : null,
  );

  const live = Object.fromEntries(SECTIONS.map((section) => [section.id, data[section.id].filter((item) => !cleared.includes(item.id))])) as ActionData;
  const total = SECTIONS.reduce((sum, section) => sum + live[section.id].length, 0);
  const showing = SECTIONS.filter((section) => live[section.id].length > 0 && (filter === "all" || filter === section.id));

  function clear(id: string, verb: string) {
    const next = [...cleared, id];
    setCleared(next);
    const left = total - 1;
    setToast({ message: left === 0 ? `${verb}. Nothing left.` : `${verb}. ${left} left.`, id });
  }

  function undo() {
    if (toast?.id) setCleared((current) => current.filter((id) => id !== toast.id));
    setToast(null);
  }

  if (total === 0) {
    return (
      <>
        <EmptyState />
        {toast && <Toast message={toast.message} onUndo={undo} />}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div
        role="toolbar"
        aria-label="Filter Capture"
        className="-mx-4 flex gap-1.5 overflow-x-auto px-4 [mask-image:linear-gradient(to_right,black_85%,transparent)] [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:[mask-image:none]"
      >
        <Chip label="All" count={total} active={filter === "all"} index={1} onClick={() => setFilter("all")} />
        {SECTIONS.filter((section) => live[section.id].length > 0).map((section, index) => (
          <Chip
            key={section.id}
            label={section.label}
            count={live[section.id].length}
            active={filter === section.id}
            index={index + 2}
            onClick={() => setFilter(section.id)}
          />
        ))}
      </div>

      {filter !== "all" && live[filter].length === 0 && (
        <p role="status" className="caption-style text-subtle">
          Nothing left in {SECTIONS.find((section) => section.id === filter)?.label}.{" "}
          <Button variant="link" size="none" className="caption-style" onClick={() => setFilter("all")}>
            Show all
          </Button>
        </p>
      )}

      {showing.map((section) => (
        <section key={section.id} aria-labelledby={`${section.id}-heading`} className="flex flex-col gap-3">
          <h2 id={`${section.id}-heading`} className="eyebrow-style text-subtle flex items-center gap-2 font-normal">
            {section.label}
            <span className="text-soft tracking-normal tabular-nums">{live[section.id].length}</span>
          </h2>
          <ul className="bg-card border-line-strong divide-line-strong flex flex-col divide-y overflow-hidden rounded-2xl border">
            {live[section.id].map((item) => (
              <ItemRow key={item.id} item={item} options={options} onClear={clear} />
            ))}
          </ul>
          {section.id === "approvals" && options.others && options.others.length > 0 && <OthersApprovals items={options.others} />}
        </section>
      ))}

      {toast && <Toast message={toast.message} onUndo={undo} />}
    </div>
  );
}

function Chip({ label, count, active, index, onClick }: { label: string; count: number; active: boolean; index: number; onClick: () => void }) {
  return (
    <Button variant={active ? "secondary" : "ghost"} size="sm" aria-pressed={active} title={`${label} (${index})`} onClick={onClick}>
      {label}
      <span className="text-subtle tabular-nums">{count}</span>
    </Button>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 py-24 text-center sm:py-32">
      <span aria-hidden className="bg-secondary text-subtle mb-1 flex size-10 items-center justify-center rounded-full">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12.5 10 17.5 19 7.5" />
        </svg>
      </span>
      <h2>Nothing waiting</h2>
    </div>
  );
}

function Toast({ message, onUndo }: { message: string; onUndo: () => void }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+5rem)] z-50 flex flex-col items-center gap-2 px-4">
      <div
        role="status"
        className="bg-popover border-line-strong shadow-overlay animate-rise-in pointer-events-auto flex max-w-[min(36rem,100%)] items-center gap-3 rounded-full border py-1.5 pr-1.5 pl-4 text-[13px]"
      >
        <span className="text-foreground min-w-0">{message}</span>
        <Button variant="ghost" size="sm" title="Undo (Z)" onClick={onUndo}>
          Undo
        </Button>
      </div>
    </div>
  );
}

function IconMark({ icon: Icon, className }: { icon: ComponentType<SVGProps<SVGSVGElement>>; className?: string }) {
  return (
    <span aria-hidden className={cn("bg-secondary text-subtle mt-px flex size-6 shrink-0 items-center justify-center rounded-full", className)}>
      <Icon className="size-3" />
    </span>
  );
}

function PersonMark({ name }: { name: string }) {
  return <Monogram name={name} className="mt-px size-6 rounded-full text-[11px]" />;
}

function DoneCircle({ overdue, title, onClick }: { overdue: boolean; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Mark “${title}” done`}
      title="Mark done (E)"
      className={cn(
        "group/done mt-px flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-white transition-colors duration-150",
        overdue ? "bg-danger hover:bg-success" : "bg-secondary text-subtle hover:bg-success hover:text-white",
      )}
    >
      <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="hidden group-hover/done:block">
        <path d="M5 12.5 10 17.5 19 7.5" />
      </svg>
      <span className="group-hover/done:hidden">
        {overdue ? (
          <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M6 6 18 18M18 6 6 18" />
          </svg>
        ) : (
          <span className="block size-1.5 rounded-full bg-current" />
        )}
      </span>
    </button>
  );
}

function describe(item: ActionItem, onClear: (id: string, verb: string) => void) {
  const done = (verb: string) => () => onClear(item.id, verb);
  switch (item.kind) {
    case "approval":
      return {
        mark: <IconMark icon={ZapIcon} />,
        title: item.title,
        when: item.when,
        meta: [item.workflow, item.company].filter(Boolean).join(" · "),
        detail: <p className="ui-style text-soft line-clamp-2">{item.details}</p>,
        acts: [
          { label: "Reject", variant: "subtle", clears: "Rejected", shortcut: "R" },
          { label: "Approve", variant: "primary", clears: "Approved", shortcut: "A" },
        ] satisfies Act[],
        done,
      };
    case "followup":
      return {
        mark: <IconMark icon={item.source === "email" ? FollowUpIcon : item.source === "teams" ? PhoneIcon : MicIcon} />,
        title: item.source === "email" ? `Re: ${item.title}` : item.title,
        when: item.when,
        meta: item.source === "email" ? `To ${item.to} · ${item.line}` : `${item.source === "teams" ? "Teams" : "Granola"} · ${item.line}`,
        detail: (
          <span className="ui-style text-soft flex min-w-0 items-center gap-1.5">
            <SparkleIcon aria-hidden className="text-primary-foreground size-3 shrink-0" />
            <span className="truncate">{item.draft}</span>
          </span>
        ),
        acts: [
          { label: "Review and send", variant: "secondary", clears: "Sent", shortcut: "Enter" },
          { label: "Not needed", variant: "ghost", clears: "Dismissed", shortcut: "E" },
        ] satisfies Act[],
        done,
      };
    case "reply":
      return {
        mark: <PersonMark name={item.from} />,
        title: item.subject,
        when: item.when,
        meta: [item.from, item.company].filter(Boolean).join(" · "),
        badge: (
          <Tag size="sm" tone={item.waiting.startsWith("2") ? "neutral" : "amber"} className="text-[12px]">
            Waiting {item.waiting}
          </Tag>
        ),
        detail: (
          <span className="ui-style text-soft flex min-w-0 items-center gap-1.5">
            {item.ready && <SparkleIcon aria-label="Reply ready" className="text-primary-foreground size-3 shrink-0" />}
            <span className="truncate">{item.snippet}</span>
          </span>
        ),
        acts: [
          { label: "Reply", variant: "secondary", shortcut: "R" },
          { label: "Done", variant: "ghost", clears: "Done", shortcut: "E" },
          { label: "Snooze", variant: "ghost", snooze: true, phoneMore: true, shortcut: "H" },
        ] satisfies Act[],
        done,
      };
    case "task":
      return {
        mark: <DoneCircle overdue={item.overdue} title={item.title} onClick={done("Task done")} />,
        title: item.title,
        when: null,
        meta: null,
        chips: (
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Tag size="sm" tone={item.overdue ? "red" : "amber"} className="text-[12px]">
              {item.due}
            </Tag>
            {item.company && <EntityChip name={item.company} />}
          </span>
        ),
        acts: [
          { label: "Done", variant: "secondary", clears: "Task done", shortcut: "E" },
          { label: "Snooze", variant: "ghost", snooze: true, shortcut: "H" },
          { label: "Open", variant: "ghost", phoneMore: true, shortcut: "Enter" },
        ] satisfies Act[],
        done,
      };
    case "email":
      return {
        mark: <PersonMark name={item.name} />,
        title: item.name,
        when: item.when,
        meta: `${item.email} · To ${item.to}`,
        detail: (
          <span className="ui-style flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0">{item.subject}</span>
            <span className="text-subtle truncate">{item.snippet}</span>
          </span>
        ),
        acts: [
          { label: "Create contact & file", variant: "secondary", clears: "Filed", shortcut: "A" },
          { label: "File to…", variant: "secondary", phoneMore: true, shortcut: "F" },
          { label: "Ignore", variant: "ghost", clears: "Ignored", shortcut: "I" },
        ] satisfies Act[],
        done,
      };
    case "meeting":
      return {
        mark: <IconMark icon={item.source === "teams" ? PhoneIcon : MicIcon} />,
        title: item.title,
        when: item.when,
        meta: `${item.source === "teams" ? "Teams" : "Granola"} · ${item.line}`,
        acts: [
          { label: "File to…", variant: "secondary", shortcut: "F" },
          { label: "Ignore", variant: "ghost", clears: "Ignored", shortcut: "I" },
        ] satisfies Act[],
        done,
      };
    case "person":
      return {
        mark: <PersonMark name={item.name} />,
        title: item.name,
        when: null,
        meta: `${item.email} · ${item.line}`,
        acts: [
          { label: "Create contact", variant: "secondary", clears: "Contact created", shortcut: "A" },
          { label: "Hide", variant: "ghost", clears: "Hidden", shortcut: "I" },
        ] satisfies Act[],
        done,
      };
  }
}

function ItemRow({ item, options, onClear }: { item: ActionItem; options: ListOptions; onClear: (id: string, verb: string) => void }) {
  const row = describe(item, onClear);
  const acts: Act[] = row.acts;
  const active = options.activeRow === item.id;
  const swipe = options.swipes?.find((entry) => entry.id === item.id) ?? null;
  const more = acts.filter((act) => act.phoneMore);

  const body = (
    <div
      data-kb-active={active || undefined}
      className={cn(
        KEYBOARD_ROW_CLASS,
        "bg-card relative flex flex-col gap-2.5 px-4 py-3 sm:flex-row sm:items-start sm:gap-4",
        swipe && (swipe.side === "left" ? "max-sm:-translate-x-[38%]" : "max-sm:translate-x-[32%]"),
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        {row.mark}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <button type="button" className="min-w-0 cursor-pointer text-left text-[14px] leading-5 break-words sm:truncate hover:underline hover:decoration-white/30 hover:underline-offset-2">
              {row.title}
            </button>
            {"badge" in row && row.badge && <span className="shrink-0 self-center">{row.badge}</span>}
            {row.when && <span className="caption-style text-subtle ml-auto shrink-0 tabular-nums">{row.when}</span>}
          </span>
          {row.meta && <span className="caption-style text-subtle truncate leading-[1.4]">{row.meta}</span>}
          {"chips" in row && row.chips}
          {"detail" in row && row.detail}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 max-sm:pl-[34px]">
        {acts.map((act) => (
          <ActButton
            key={act.label}
            act={act}
            active={active}
            phoneHidden={Boolean(act.phoneMore)}
            snoozeOpen={act.snooze && options.openSnooze === item.id}
            onClear={() => act.clears && row.done(act.clears)()}
          />
        ))}
        {more.length > 0 && (
          <DropdownMenu modal={false} defaultOpen={options.openMore === item.id}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="More actions" className="ml-auto sm:hidden">
                <MoreIcon aria-hidden className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[13rem]">
              {more.map((act) =>
                act.snooze ? (
                  <SnoozeItems key={act.label} />
                ) : (
                  <DropdownMenuItem key={act.label} className="max-sm:py-2.5">
                    {act.label}
                  </DropdownMenuItem>
                ),
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );

  if (!swipe) return <li data-list-row="">{body}</li>;
  return (
    <li data-list-row="" className="relative overflow-hidden">
      <span
        aria-hidden
        className={cn(
          "absolute inset-0 flex items-center px-5 text-[13px] font-medium text-white",
          swipe.side === "left" ? "justify-end bg-[color-mix(in_srgb,var(--success)_78%,black)]" : "bg-primary justify-start",
        )}
      >
        <span className={cn("flex items-center gap-2", swipe.side === "left" && "flex-row-reverse")}>
          {swipe.side === "left" ? <ArchiveIcon className="size-[18px]" /> : <ClockIcon className="size-[18px]" />}
          {swipe.side === "left" ? clearLabel(acts) : "Snooze"}
        </span>
      </span>
      {body}
    </li>
  );
}

function clearLabel(acts: Act[]) {
  return acts.find((act) => act.clears && act.variant !== "primary" && act.label !== "Reject")?.label ?? "Done";
}

function SnoozeItems() {
  return (
    <>
      <DropdownMenuSeparator className="first:hidden" />
      <DropdownMenuLabel>Snooze until</DropdownMenuLabel>
      {SNOOZE_CHOICES.map((choice) => (
        <DropdownMenuItem key={choice.label} className="max-sm:py-2.5">
          {choice.label}
          <span className="text-subtle ml-auto pl-4 tabular-nums">{choice.detail}</span>
        </DropdownMenuItem>
      ))}
    </>
  );
}

function ActButton({
  act,
  active,
  phoneHidden,
  snoozeOpen,
  onClear,
}: {
  act: Act;
  active: boolean;
  phoneHidden: boolean;
  snoozeOpen?: boolean;
  onClear: () => void;
}) {
  const className = cn(phoneHidden && "max-sm:hidden");
  const shortcut = active && act.shortcut ? [act.shortcut === "Enter" ? "↵" : act.shortcut] : undefined;
  if (act.snooze) {
    return (
      <DropdownMenu modal={false} defaultOpen={snoozeOpen}>
        <DropdownMenuTrigger asChild>
          <Button variant={act.variant} size="sm" className={className} shortcut={shortcut}>
            <ClockIcon aria-hidden className="size-3" />
            {act.label}
            <ChevronDownIcon aria-hidden className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[13rem]">
          <SnoozeItems />
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  return (
    <Button variant={act.variant} size="sm" className={className} shortcut={shortcut} onClick={onClear}>
      {act.label}
    </Button>
  );
}

function OthersApprovals({ items }: { items: ApprovalItem[] }) {
  return (
    <div className="flex flex-col gap-2 pt-1">
      <h3 className="caption-style text-subtle font-normal">Waiting on others</h3>
      <ul className="border-line-strong divide-line-strong flex flex-col divide-y overflow-hidden rounded-2xl border border-dashed">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-2.5 px-4 py-2.5">
            <Monogram name={item.owner ?? "?"} className="size-6 rounded-full text-[11px]" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-soft truncate text-[14px] leading-5">{item.title}</span>
              <span className="caption-style text-subtle truncate">
                {item.owner} · {item.workflow} · waiting {item.when}
              </span>
            </span>
            <Button variant="ghost" size="sm">
              Open
              <ChevronRightIcon aria-hidden className="size-3" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
