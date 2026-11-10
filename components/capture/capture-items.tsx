"use client";

import { createContext, useContext, useId, useState, type ComponentType, type SVGProps } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/_ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import Tag from "@/components/_ui/tag";
import { Textarea } from "@/components/_ui/textarea";
import { EntityChip, Monogram, tagBase } from "@/components/beautifui/record-marks";
import CaptureRow, { type MenuItem, type RowAction } from "@/components/capture/capture-row";
import { FilePicker } from "@/components/capture/file-picker";
import { useComposer } from "@/components/mail/compose-dock";
import WorkspaceTile from "@/components/workspaces/workspace-tile";
import { formatMeetingWhen } from "@/lib/companies";
import type { OthersApproval, WaitingApproval, WaitingTask } from "@/lib/crm/action-needed";
import type { MetPerson } from "@/lib/crm/calendar";
import { agoLabel, dayLabel, dueLabel, REPLY_AMBER_WORKING_DAYS, sinceLabel } from "@/lib/crm/capture-format";
import type { CaptureAction } from "@/lib/crm/capture-actions";
import type { UnfiledImport } from "@/lib/crm/conversations";
import type { FollowUpSuggestion } from "@/lib/crm/follow-ups";
import { companyHref, contactHref } from "@/lib/crm/hrefs";
import { onWorkingDay, taskSnoozeChoices, type SnoozeChoice } from "@/lib/crm/task-snooze";
import { tasksHref } from "@/lib/crm/task-views";
import type { UnknownEmail } from "@/lib/mail/filing";
import { laterDetail, laterOptions } from "@/lib/mail/later";
import { threadHref, type WorkspaceChoiceRef } from "@/lib/mail/view";
import type { WaitingNudge, WaitingReminder, WaitingReply } from "@/lib/mail/waiting";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import ChevronRightIcon from "@/public/assets/images/_common/chevron-right.svg";
import MicIcon from "@/public/assets/images/_common/mic.svg";
import PhoneIcon from "@/public/assets/images/_common/phone.svg";
import CheckIcon from "@/public/assets/images/assistant/check.svg";
import CrossIcon from "@/public/assets/images/companies/detail/x.svg";
import ZapIcon from "@/public/assets/images/companies/sidebar/zap.svg";
import FollowUpIcon from "@/public/assets/images/mail/follow-up.svg";
import SparkleIcon from "@/public/assets/images/mail/sparkle.svg";

type Clear = (verb: string, action: CaptureAction) => void;

export const ClearContext = createContext<(id: string, verb: string, action: CaptureAction) => void>(() => undefined);

function useClear(id: string): Clear {
  const clear = useContext(ClearContext);
  return (verb, action) => clear(id, verb, action);
}

const REPLY_SNOOZE = new Set(["later", "tomorrow", "next-week"]);
const SOURCE: Record<"teams" | "granola", string> = {
  teams: "Teams",
  granola: "Granola",
};

function IconMark({ icon: Icon }: { icon: ComponentType<SVGProps<SVGSVGElement>> }) {
  return (
    <span aria-hidden className="bg-secondary text-subtle mt-px flex size-6 shrink-0 items-center justify-center rounded-full">
      <Icon className="size-3" />
    </span>
  );
}

function PersonMark({ name }: { name: string }) {
  return <Monogram name={name} className="mt-px size-6 rounded-full text-[11px]" />;
}

function DraftLine({ text, ready = true }: { text: string; ready?: boolean }) {
  return (
    <span className="ui-style text-soft flex min-w-0 items-center gap-1.5">
      {ready && <SparkleIcon role="img" aria-label="Orbit has a draft ready" className="text-primary-foreground size-3 shrink-0" />}
      <span className="truncate">{text.replace(/\s*\n+\s*/g, " ")}</span>
    </span>
  );
}

function names(people: { name: string | null; address: string }[]) {
  return people.map((person) => person.name || person.address).join(", ");
}

function replyChoices(): SnoozeChoice[] {
  return laterOptions(Date.now()).filter((option) => REPLY_SNOOZE.has(option.id));
}

function useSnoozePicker() {
  const { pickLater } = useComposer();
  return (choices: SnoozeChoice[], description: string, pick: (choice: SnoozeChoice) => void, adjust: (at: Date) => Date = (at) => at) =>
    pickLater({
      title: "Snooze until",
      description,
      options: choices,
      now: Date.now(),
      onPick: (at) => {
        const chosen = adjust(new Date(at));
        const detail = laterDetail(chosen, Date.now());
        pick({ id: "custom", label: detail, detail, at: chosen.toISOString() });
      },
    });
}

function RejectButton({ onReject, hint }: { onReject: (note: string) => void; hint: string[] | undefined }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const id = useId();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="subtle" size="sm" data-row-key="r" shortcut={hint}>
          Reject
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(320px,calc(100vw-2rem))]">
        <form
          className="flex flex-col gap-2 p-3"
          data-shortcut-scope=""
          onSubmit={(event) => {
            event.preventDefault();
            setOpen(false);
            onReject(note.trim());
          }}
        >
          <label htmlFor={id} className="caption-style text-subtle">
            Note (optional)
          </label>
          <Textarea id={id} rows={3} value={note} maxLength={1000} autoFocus onChange={(event) => setNote(event.target.value)} />
          <span className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="subtle" size="sm" type="submit" data-shortcut-submit="">
              Reject
            </Button>
          </span>
        </form>
      </PopoverContent>
    </Popover>
  );
}

export function ApprovalItem({ item, now, clearId }: { item: WaitingApproval; now: number; clearId: string }) {
  const onClear = useClear(clearId);
  return (
    <CaptureRow
      rowId={clearId}
      mark={<IconMark icon={ZapIcon} />}
      title={item.title}
      titleHref={item.email?.href ?? `/workflows?approve=${item.id}#approval-${item.id}`}
      when={agoLabel(item.createdAt, now)}
      meta={[item.workflowName, item.companyName].filter(Boolean).join(" · ")}
      detail={item.details ? <p className="ui-style text-soft line-clamp-2 whitespace-pre-line">{item.details}</p> : null}
      actions={[
        {
          id: "reject",
          label: "Reject",
          variant: "subtle",
          hint: "R",
          render: (hint) => (
            <RejectButton
              hint={hint}
              onReject={(note) =>
                onClear("Rejected", {
                  kind: "reject",
                  runId: item.id,
                  note: note || null,
                })
              }
            />
          ),
        },
        {
          id: "approve",
          label: "Approve",
          variant: "primary",
          key: "a",
          hint: "A",
          run: () => onClear("Approved", { kind: "approve", runId: item.id }),
        },
      ]}
    />
  );
}

export function OthersApprovals({ items }: { items: OthersApproval[] }) {
  return (
    <div className="flex flex-col gap-2 pt-1">
      <h3 className="caption-style text-subtle font-normal">Waiting on others</h3>
      <ul className="border-line-strong divide-line-strong flex flex-col divide-y overflow-hidden rounded-2xl border border-dashed">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-2.5 px-4 py-2.5">
            <Monogram name={item.ownerName} className="size-6 rounded-full text-[11px]" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-soft truncate text-[14px] leading-5">{item.title}</span>
              <span className="caption-style text-subtle truncate">
                {item.ownerName} · {item.workflowName} · waiting {item.waitingDays} {item.waitingDays === 1 ? "day" : "days"}
              </span>
            </span>
            <Button variant="ghost" size="sm" href={`/workflows/${item.workflowId}`} aria-label={`Open ${item.workflowName}`}>
              Open
              <ChevronRightIcon aria-hidden className="size-3" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function NudgeItem({ item, now, clearId }: { item: WaitingNudge; now: number; clearId: string }) {
  const onClear = useClear(clearId);
  const router = useRouter();
  const people = names(item.to);
  const opened = item.opens > 0 ? `Opened ${item.opens} ${item.opens === 1 ? "time" : "times"}. ` : "";
  const dismiss = () => onClear("Dismissed", { kind: "nudge-dismiss", id: item.id });
  return (
    <CaptureRow
      rowId={clearId}
      mark={<IconMark icon={FollowUpIcon} />}
      title={item.subject?.trim() || "(no subject)"}
      titleHref={threadHref(item.key)}
      when={`Sent ${sinceLabel(item.sentAt, now)}`}
      meta={`${people ? `To ${people} · ` : ""}${opened}No reply yet`}
      detail={<DraftLine text={item.body} />}
      actions={[
        {
          id: "review",
          label: "Review and send",
          variant: "secondary",
          opens: true,
          hint: "↵",
          run: () => router.push(threadHref(item.key, "prepared")),
        },
        {
          id: "dismiss",
          label: "Dismiss",
          variant: "ghost",
          key: "e",
          hint: "E",
          run: dismiss,
        },
      ]}
      swipe={{ left: { label: "Dismiss", run: dismiss } }}
    />
  );
}

export function ReminderItem({ item, now, clearId }: { item: WaitingReminder; now: number; clearId: string }) {
  const onClear = useClear(clearId);
  const router = useRouter();
  const people = names(item.to);
  const done = () => onClear("Done", { kind: "reminder-done", id: item.id });
  return (
    <CaptureRow
      rowId={clearId}
      mark={<IconMark icon={FollowUpIcon} />}
      title={item.subject?.trim() || "(no subject)"}
      titleHref={threadHref(item.key)}
      badge={
        <Tag size="sm" tone="amber" className="text-[12px]">
          {item.checkIn ? "Time to check in" : "No reply yet"}
        </Tag>
      }
      when={agoLabel(item.at, now)}
      meta={people ? `To ${people}` : null}
      actions={[
        {
          id: "reply",
          label: "Reply",
          variant: "secondary",
          key: "r",
          hint: "R",
          opens: true,
          run: () => router.push(threadHref(item.key, "reply")),
        },
        { id: "done", label: "Done", variant: "ghost", key: "e", hint: "E", run: done },
      ]}
      swipe={{ left: { label: "Done", run: done } }}
    />
  );
}

export function CallItem({ item, now, clearId, onSent }: { item: FollowUpSuggestion; now: number; clearId: string; onSent: () => void }) {
  const onClear = useClear(clearId);
  const { openComposer } = useComposer();
  const dismiss = () => onClear("Dismissed", { kind: "call-dismiss", id: item.id });
  return (
    <CaptureRow
      rowId={clearId}
      mark={<IconMark icon={item.source === "teams" ? PhoneIcon : MicIcon} />}
      title={item.title}
      when={dayLabel(item.callAt, now)}
      meta={`${SOURCE[item.source]} · To ${item.to.name ?? item.to.address} · No next step agreed`}
      detail={<DraftLine text={item.body} />}
      actions={[
        {
          id: "review",
          label: "Review and send",
          variant: "secondary",
          opens: true,
          hint: "↵",
          run: () =>
            openComposer({
              to: [item.to],
              subject: item.subject,
              body: item.body,
              onSent,
            }),
        },
        {
          id: "dismiss",
          label: "Dismiss",
          variant: "ghost",
          key: "e",
          hint: "E",
          run: dismiss,
        },
      ]}
      swipe={{ left: { label: "Dismiss", run: dismiss } }}
    />
  );
}

export function ReplyItem({ item, now, clearId }: { item: WaitingReply; now: number; clearId: string }) {
  const onClear = useClear(clearId);
  const router = useRouter();
  const pick = useSnoozePicker();
  const name = item.from.name ?? item.from.email;
  const done = () => onClear("Done", { kind: "reply-done", thread: item.key });
  const snooze = (choice: SnoozeChoice) =>
    onClear(`Snoozed until ${choice.detail}`, {
      kind: "reply-snooze",
      thread: item.key,
      until: choice.at,
    });
  const notNeeded: MenuItem = {
    id: "not-needed",
    label: "Dismiss",
    run: () =>
      onClear("Dismissed", {
        kind: "reply-dismiss",
        thread: item.key,
        at: item.at,
      }),
  };
  return (
    <CaptureRow
      rowId={clearId}
      mark={<PersonMark name={name} />}
      title={item.subject?.trim() || "(no subject)"}
      titleHref={threadHref(item.key)}
      badge={
        <Tag size="sm" tone={item.waitingDays >= REPLY_AMBER_WORKING_DAYS ? "amber" : "neutral"} className="text-[12px]">
          Waiting {item.waitingDays} {item.waitingDays === 1 ? "day" : "days"}
        </Tag>
      }
      when={dayLabel(item.at, now)}
      meta={[name, item.company].filter(Boolean).join(" · ")}
      detail={item.snippet ? <DraftLine text={item.snippet} ready={item.ready} /> : null}
      actions={[
        {
          id: "reply",
          label: "Reply",
          variant: "secondary",
          key: "r",
          hint: "R",
          run: () => router.push(threadHref(item.key, "reply")),
        },
        { id: "done", label: "Done", variant: "ghost", key: "e", hint: "E", run: done },
        {
          id: "snooze",
          label: "Snooze",
          variant: "ghost",
          key: "h",
          hint: "H",
          phoneMore: true,
          snooze: { choices: replyChoices, pick: snooze, extra: [notNeeded] },
        },
      ]}
      swipe={{
        left: { label: "Done", run: done },
        right: () => pick(replyChoices(), "Orbit moves the conversation out of your inbox and brings it back to the top at this time.", snooze),
      }}
    />
  );
}

function DoneCircle({ overdue, title, onClick }: { overdue: boolean; title: string; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={onClick}
      aria-label={`Mark “${title}” done`}
      title="Mark done (E)"
      className={cn(
        "group/done hover:bg-success mt-px text-white hover:text-white",
        overdue ? "bg-danger" : "bg-secondary text-subtle",
      )}
    >
      <CheckIcon aria-hidden className="hidden size-3 group-hover/done:block" />
      <span aria-hidden className="flex group-hover/done:hidden">
        {overdue ? <CrossIcon className="size-3.5" /> : <span className="block size-1.5 rounded-full bg-current" />}
      </span>
    </Button>
  );
}

function taskChoices(item: WaitingTask) {
  return taskSnoozeChoices(item.dueAt, new Date());
}

export function TaskItem({ item, now, clearId }: { item: WaitingTask; now: number; clearId: string }) {
  const onClear = useClear(clearId);
  const router = useRouter();
  const pick = useSnoozePicker();
  const href = item.companyId ? companyHref(item.companyId) : item.contactId ? contactHref(item.contactId) : tasksHref(item.overdue ? "overdue" : "today");
  const done = () => onClear("Task done", { kind: "task-done", id: item.id });
  const snooze = (choice: SnoozeChoice) =>
    onClear(`Snoozed until ${choice.detail}`, {
      kind: "task-snooze",
      id: item.id,
      until: choice.at,
    });
  const record = item.companyName ?? item.contactName;
  return (
    <CaptureRow
      rowId={clearId}
      mark={<DoneCircle overdue={item.overdue} title={item.title} onClick={done} />}
      title={item.title}
      chips={
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Tag size="sm" tone={item.overdue ? "red" : "amber"} className="text-[12px]">
            {dueLabel(item.dueAt, now)}
          </Tag>
          {record && (
            <EntityChip name={record} href={item.companyId ? companyHref(item.companyId) : item.contactId ? contactHref(item.contactId) : undefined} />
          )}
        </span>
      }
      actions={[
        { id: "done", label: "Done", variant: "secondary", key: "e", hint: "E", run: done },
        {
          id: "snooze",
          label: "Snooze",
          variant: "ghost",
          key: "h",
          hint: "H",
          snooze: { choices: () => taskChoices(item), pick: snooze },
        },
        {
          id: "open",
          label: "Open",
          variant: "ghost",
          opens: true,
          hint: "↵",
          phoneMore: true,
          run: () => router.push(href),
        },
      ]}
      swipe={{
        left: { label: "Done", run: done },
        right: () => pick(taskChoices(item), "Moves the due date.", snooze, onWorkingDay),
      }}
    />
  );
}

function MoveMenu({ others, onMove }: { others: WorkspaceChoiceRef[]; onMove: (target: WorkspaceChoiceRef) => void }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm">
          Move to
          <ChevronDownIcon aria-hidden className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[14rem]">
        {others.map((item) => (
          <DropdownMenuItem key={item.id} className="max-sm:py-2.5" onSelect={() => onMove(item)}>
            <WorkspaceTile id={item.id} name={item.name} className="size-4 rounded-[5px] text-[9px]" />
            {item.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function EmailItem({
  item,
  others,
  now,
  filing,
  onFiling,
  clearId,
}: {
  item: UnknownEmail;
  others: WorkspaceChoiceRef[];
  now: number;
  filing: boolean;
  onFiling: (open: boolean) => void;
  clearId: string;
}) {
  const onClear = useClear(clearId);
  const label = item.name || item.email;
  const ignore = () => onClear("Dismissed", { kind: "email-ignore", key: item.key });
  const move = (target: WorkspaceChoiceRef) =>
    onClear(`Moved to ${target.name}`, {
      kind: "email-move",
      key: item.key,
      workspaceId: target.id,
    });
  const actions: RowAction[] = [
    {
      id: "create",
      label: "Create contact & file",
      variant: "secondary",
      key: "a",
      hint: "A",
      run: () => onClear("Filed", { kind: "email-create", key: item.key }),
    },
    {
      id: "file",
      label: "File to…",
      variant: "secondary",
      key: "f",
      hint: "F",
      phoneMore: true,
      run: () => onFiling(true),
    },
  ];
  if (others.length > 0) {
    actions.push({
      id: "move",
      label: "Move to",
      variant: "secondary",
      phoneMore: true,
      render: () => <MoveMenu others={others} onMove={move} />,
    });
  }
  actions.push({
    id: "ignore",
    label: "Dismiss",
    variant: "ghost",
    key: "i",
    hint: "I",
    run: ignore,
  });
  return (
    <CaptureRow
      rowId={clearId}
      mark={<PersonMark name={label} />}
      title={label}
      titleHref={threadHref(item.key)}
      when={dayLabel(item.at, now)}
      meta={
        <>
          {item.email} · <span aria-hidden className="inline-block size-1.5 rounded-full align-middle" style={{ background: tagBase(item.address) }} /> To{" "}
          {item.address}
        </>
      }
      detail={
        <span className="ui-style flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0">{item.subject?.trim() || "(no subject)"}</span>
          {item.snippet && <span className="text-subtle truncate">{item.snippet}</span>}
        </span>
      }
      actions={actions}
      more={others.map((target) => ({
        id: `move-${target.id}`,
        label: `Move to ${target.name}`,
        run: () => move(target),
      }))}
      swipe={{ left: { label: "Dismiss", run: ignore } }}
      below={
        filing ? (
          <FilePicker
            id={item.messageId}
            onPick={async (contact) => {
              onClear("Filed", {
                kind: "email-file",
                key: item.key,
                contactId: contact.id,
              });
              return {};
            }}
            onCancel={() => onFiling(false)}
            onDone={() => onFiling(false)}
          />
        ) : undefined
      }
    />
  );
}

function participants(item: UnfiledImport) {
  return item.participants
    .map((person) => person.name || person.email)
    .filter(Boolean)
    .join(", ");
}

function plainSummary(markdown: string) {
  return markdown
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .trim();
}

function Summary({ id, text }: { id: string; text: string }) {
  const [open, setOpen] = useState(false);
  const summaryId = `capture-summary-${id}`;
  return (
    <span className="flex flex-col items-start gap-1 pt-0.5">
      <span id={summaryId} className={cn("caption-style text-soft leading-[1.5] whitespace-pre-wrap", !open && "line-clamp-3")}>
        {text}
      </span>
      <Button variant="link" size="none" className="caption-style text-subtle" aria-expanded={open} aria-controls={summaryId} onClick={() => setOpen((value) => !value)}>
        {open ? "Show less" : "Show more"}
      </Button>
    </span>
  );
}

export function ImportItem({
  item,
  others,
  now,
  filing,
  onFiling,
  clearId,
}: {
  item: UnfiledImport;
  others: WorkspaceChoiceRef[];
  now: number;
  filing: boolean;
  onFiling: (open: boolean) => void;
  clearId: string;
}) {
  const onClear = useClear(clearId);
  const ignore = () => onClear("Dismissed", { kind: "import-ignore", id: item.id });
  const move = (target: WorkspaceChoiceRef) =>
    onClear(`Moved to ${target.name}`, { kind: "import-move", id: item.id, workspaceId: target.id });
  const people = participants(item);
  const summary = item.sourceSummary ? plainSummary(item.sourceSummary) : "";
  const create = (person: { email: string; name: string | null }) =>
    onClear("Filed", {
      kind: "import-create",
      id: item.id,
      email: person.email,
    });
  const actions: RowAction[] = item.newPeople.map((person, index) => ({
    id: `create-${person.email}`,
    label: `Create ${person.name ?? person.email} & file`,
    variant: "secondary",
    key: index === 0 ? "a" : undefined,
    hint: index === 0 ? "A" : undefined,
    phoneMore: index > 0,
    run: () => create(person),
  }));
  actions.push(
    {
      id: "file",
      label: "File to…",
      variant: "secondary",
      key: "f",
      hint: "F",
      phoneMore: item.newPeople.length > 0,
      run: () => onFiling(true),
    },
  );
  if (others.length > 0) {
    actions.push({
      id: "move",
      label: "Move to",
      variant: "secondary",
      phoneMore: true,
      render: () => <MoveMenu others={others} onMove={move} />,
    });
  }
  actions.push({ id: "ignore", label: "Dismiss", variant: "ghost", key: "i", hint: "I", run: ignore });
  return (
    <CaptureRow
      rowId={clearId}
      mark={<IconMark icon={item.source === "teams" ? PhoneIcon : MicIcon} />}
      title={item.title || (item.kind === "call" ? "Teams call" : "Meeting")}
      when={item.occurredAt ? dayLabel(item.occurredAt, now) : null}
      meta={`${SOURCE[item.source]} · ${people ? `${people}, no contact matched` : "No contact matched"}`}
      detail={summary ? <Summary id={item.id} text={summary} /> : null}
      actions={actions}
      more={others.map((target) => ({
        id: `move-${target.id}`,
        label: `Move to ${target.name}`,
        run: () => move(target),
      }))}
      swipe={{ left: { label: "Dismiss", run: ignore } }}
      below={
        filing ? (
          <FilePicker
            id={item.id}
            onPick={async (contact) => {
              onClear("Filed", {
                kind: "import-file",
                id: item.id,
                contactId: contact.id,
              });
              return {};
            }}
            onCancel={() => onFiling(false)}
            onDone={() => onFiling(false)}
          />
        ) : undefined
      }
    />
  );
}

function meetingLine(label: string, meeting: MetPerson["lastMeeting"]) {
  if (!meeting) return null;
  return `${label} ${formatMeetingWhen(meeting.startsAt)}: ${meeting.subject?.trim() || "Untitled meeting"}`;
}

export function PersonItem({ item, clearId }: { item: MetPerson; clearId: string }) {
  const onClear = useClear(clearId);
  const label = item.name ?? item.email;
  const hide = () => onClear("Dismissed", { kind: "person-hide", email: item.email });
  const meeting = meetingLine("Next", item.nextMeeting) ?? meetingLine("Last", item.lastMeeting);
  return (
    <CaptureRow
      rowId={clearId}
      mark={<PersonMark name={label} />}
      title={label}
      meta={`${item.email} · ${item.meetings} ${item.meetings === 1 ? "meeting" : "meetings"}`}
      detail={meeting ? <span className="ui-style text-soft truncate">{meeting}</span> : null}
      actions={[
        {
          id: "create",
          label: "Create contact",
          variant: "secondary",
          key: "a",
          hint: "A",
          run: () =>
            onClear("Contact created", {
              kind: "person-create",
              email: item.email,
            }),
        },
        { id: "hide", label: "Dismiss", variant: "ghost", key: "i", hint: "I", run: hide },
      ]}
      swipe={{ left: { label: "Dismiss", run: hide } }}
    />
  );
}
