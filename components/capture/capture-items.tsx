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
import type { OthersApproval, SnoozeChoice, WaitingApproval, WaitingTask } from "@/lib/crm/action-needed";
import type { MetPerson } from "@/lib/crm/calendar";
import { agoLabel, dayLabel, dueLabel, REPLY_AMBER_WORKING_DAYS, sinceLabel } from "@/lib/crm/capture-format";
import type { CaptureAction } from "@/lib/crm/capture-actions";
import type { UnfiledImport } from "@/lib/crm/conversations";
import type { FollowUpSuggestion } from "@/lib/crm/follow-ups";
import { companyHref, contactHref } from "@/lib/crm/hrefs";
import { tasksHref } from "@/lib/crm/task-views";
import type { UnknownEmail } from "@/lib/mail/filing";
import { laterOptions } from "@/lib/mail/later";
import { threadHref, type WorkspaceChoiceRef } from "@/lib/mail/view";
import type { WaitingNudge, WaitingReply } from "@/lib/mail/waiting";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import ChevronRightIcon from "@/public/assets/images/_common/chevron-right.svg";
import MicIcon from "@/public/assets/images/_common/mic.svg";
import PhoneIcon from "@/public/assets/images/_common/phone.svg";
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

function replyChoices(): SnoozeChoice[] {
  return laterOptions(Date.now()).filter((option) => REPLY_SNOOZE.has(option.id));
}

function useSnoozePicker() {
  const { pickLater } = useComposer();
  return (choices: SnoozeChoice[], description: string, pick: (choice: SnoozeChoice) => void) =>
    pickLater({
      title: "Snooze until",
      description,
      options: choices,
      now: Date.now(),
      onPick: (at, detail) => pick({ id: "custom", label: detail, detail, at }),
    });
}

function RejectButton({ onReject, hint }: { onReject: (note: string) => void; hint: string[] | undefined }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const id = useId();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="subtle" size="sm" data-row-key="r" title="Reject (R)" shortcut={hint}>
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
      mark={<IconMark icon={ZapIcon} />}
      title={item.title}
      titleHref={item.email?.href ?? `/workflows?approve=${item.id}#approval-${item.id}`}
      when={agoLabel(item.createdAt, now)}
      meta={[item.workflowName, item.companyName].filter(Boolean).join(" · ")}
      detail={item.details ? <p className="ui-style text-soft line-clamp-2 whitespace-pre-line">{item.details}</p> : null}
      actions={[
        {
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
  const names = item.to.map((person) => person.name || person.address).join(", ");
  const opened = item.opens > 0 ? `Opened ${item.opens} ${item.opens === 1 ? "time" : "times"}. ` : "";
  const dismiss = () => onClear("Dismissed", { kind: "nudge-dismiss", id: item.id });
  return (
    <CaptureRow
      mark={<IconMark icon={FollowUpIcon} />}
      title={item.subject?.trim() || "(no subject)"}
      titleHref={threadHref(item.key)}
      when={`Sent ${sinceLabel(item.sentAt, now)}`}
      meta={`${names ? `To ${names} · ` : ""}${opened}Nobody has replied.${opened ? "" : " Orbit has a follow-up ready."}`}
      detail={<DraftLine text={item.body} />}
      actions={[
        {
          label: "Review and send",
          variant: "secondary",
          opens: true,
          hint: "↵",
          run: () => router.push(threadHref(item.key, "prepared")),
        },
        {
          label: "Not needed",
          variant: "ghost",
          key: "e",
          hint: "E",
          run: dismiss,
        },
      ]}
      swipe={{ left: { label: "Not needed", run: dismiss } }}
    />
  );
}

export function CallItem({ item, now, clearId, onSent }: { item: FollowUpSuggestion; now: number; clearId: string; onSent: () => void }) {
  const onClear = useClear(clearId);
  const { openComposer } = useComposer();
  const dismiss = () => onClear("Dismissed", { kind: "call-dismiss", id: item.id });
  return (
    <CaptureRow
      mark={<IconMark icon={item.source === "teams" ? PhoneIcon : MicIcon} />}
      title={item.title}
      when={dayLabel(item.callAt, now)}
      meta={`${SOURCE[item.source]} · No next step was agreed.`}
      detail={<DraftLine text={item.body} />}
      actions={[
        {
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
          label: "Not needed",
          variant: "ghost",
          key: "e",
          hint: "E",
          run: dismiss,
        },
      ]}
      swipe={{ left: { label: "Not needed", run: dismiss } }}
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
    label: "No reply needed",
    run: () =>
      onClear("Dismissed", {
        kind: "reply-dismiss",
        thread: item.key,
        at: item.at,
      }),
  };
  return (
    <CaptureRow
      mark={<PersonMark name={name} />}
      title={item.subject?.trim() || "(no subject)"}
      titleHref={threadHref(item.key)}
      badge={
        <Tag size="sm" tone={item.waitingDays >= REPLY_AMBER_WORKING_DAYS ? "amber" : "neutral"} className="text-[12px]">
          Waiting {item.waitingDays} days
        </Tag>
      }
      when={dayLabel(item.at, now)}
      meta={[name, item.company].filter(Boolean).join(" · ")}
      detail={item.snippet ? <DraftLine text={item.snippet} ready={item.ready} /> : null}
      actions={[
        {
          label: "Reply",
          variant: "secondary",
          key: "r",
          hint: "R",
          run: () => router.push(threadHref(item.key, "reply")),
        },
        { label: "Done", variant: "ghost", key: "e", hint: "E", run: done },
        {
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
      <svg
        aria-hidden
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="hidden group-hover/done:block"
      >
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
        { label: "Done", variant: "secondary", key: "e", hint: "E", run: done },
        {
          label: "Snooze",
          variant: "ghost",
          key: "h",
          hint: "H",
          snooze: { choices: () => item.snooze, pick: snooze },
        },
        {
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
        right: () => pick(item.snooze, "The task's due time moves, on a working day.", snooze),
      }}
    />
  );
}

function MoveMenu({ others, onMove }: { others: WorkspaceChoiceRef[]; onMove: (target: WorkspaceChoiceRef) => void }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm" title="Move to another workspace's Capture">
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
  const ignore = () => onClear("Ignored", { kind: "email-ignore", key: item.key });
  const move = (target: WorkspaceChoiceRef) =>
    onClear(`Moved to ${target.name}`, {
      kind: "email-move",
      key: item.key,
      workspaceId: target.id,
    });
  const actions: RowAction[] = [
    {
      label: "Create contact & file",
      variant: "secondary",
      key: "a",
      hint: "A",
      run: () => onClear("Filed", { kind: "email-create", key: item.key }),
    },
    {
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
      label: "Move to",
      variant: "secondary",
      phoneMore: true,
      render: () => <MoveMenu others={others} onMove={move} />,
    });
  }
  actions.push({
    label: "Ignore",
    variant: "ghost",
    key: "i",
    hint: "I",
    run: ignore,
  });
  return (
    <CaptureRow
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
        label: `Move to ${target.name}`,
        run: () => move(target),
      }))}
      swipe={{ left: { label: "Ignore", run: ignore } }}
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

export function ImportItem({
  item,
  now,
  filing,
  onFiling,
  clearId,
}: {
  item: UnfiledImport;
  now: number;
  filing: boolean;
  onFiling: (open: boolean) => void;
  clearId: string;
}) {
  const onClear = useClear(clearId);
  const ignore = () => onClear("Ignored", { kind: "import-ignore", id: item.id });
  const people = participants(item);
  const create = (person: { email: string; name: string | null }) =>
    onClear("Filed", {
      kind: "import-create",
      id: item.id,
      email: person.email,
    });
  const actions: RowAction[] = item.newPeople.map((person, index) => ({
    label: `Create ${person.name ?? person.email} & file`,
    variant: "secondary",
    key: index === 0 ? "a" : undefined,
    hint: index === 0 ? "A" : undefined,
    phoneMore: index > 0,
    run: () => create(person),
  }));
  actions.push(
    {
      label: "File to…",
      variant: "secondary",
      key: "f",
      hint: "F",
      phoneMore: item.newPeople.length > 0,
      run: () => onFiling(true),
    },
    { label: "Ignore", variant: "ghost", key: "i", hint: "I", run: ignore },
  );
  return (
    <CaptureRow
      mark={<IconMark icon={item.source === "teams" ? PhoneIcon : MicIcon} />}
      title={item.title || (item.kind === "call" ? "Teams call" : "Meeting")}
      when={item.occurredAt ? dayLabel(item.occurredAt, now) : null}
      meta={`${SOURCE[item.source]} · ${people ? `${people}, no contact matched` : "No contact matched"}`}
      actions={actions}
      swipe={{ left: { label: "Ignore", run: ignore } }}
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

export function PersonItem({ item, clearId }: { item: MetPerson; clearId: string }) {
  const onClear = useClear(clearId);
  const label = item.name ?? item.email;
  const hide = () => onClear("Hidden", { kind: "person-hide", email: item.email });
  const meeting = item.nextMeeting
    ? `Next ${formatMeetingWhen(item.nextMeeting.startsAt)}`
    : item.lastMeeting
      ? `Last ${formatMeetingWhen(item.lastMeeting.startsAt)}`
      : "";
  return (
    <CaptureRow
      mark={<PersonMark name={label} />}
      title={label}
      meta={`${item.email} · ${item.meetings} ${item.meetings === 1 ? "meeting" : "meetings"}${meeting ? `. ${meeting}` : ""}`}
      actions={[
        {
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
        { label: "Hide", variant: "ghost", key: "i", hint: "I", run: hide },
      ]}
      swipe={{ left: { label: "Hide", run: hide } }}
    />
  );
}
