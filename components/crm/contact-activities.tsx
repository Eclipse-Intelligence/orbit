"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Button, { buttonVariants } from "@/components/_ui/button";
import HoldButton from "@/components/_ui/hold-button";
import { Input } from "@/components/_ui/input";
import { addActivityAction, archiveActivityAction, type RecordActionState } from "@/app/(crm)/records";
import CallInsightPanel from "@/components/crm/call-insight";
import DetailSection from "@/components/companies/detail/detail-section";
import { useShortcut } from "@/components/shortcuts/shortcuts-provider";
import ActivityPad from "@/components/crm/activity-pad";
import ContactEmail from "@/components/crm/contact-email";
import PaperclipIcon from "@/public/assets/images/_common/paperclip.svg";
import {
  activityByline,
  activityDetails,
  activityDirection,
  activitySource,
  activityTime,
  activityTitle,
  activityWhen,
  callDuration,
  countKinds,
  granolaUrl,
  groupByDay,
  timelineKind,
  type TimelineFilter,
  type TimelineKind,
} from "@/lib/crm/timeline";
import { cn } from "@/lib/utils";
import type { Recipient } from "@/lib/crm/personalise";
import type { Activity, CallInsight } from "@/lib/crm/types";
import SparkleIcon from "@/public/assets/images/mail/sparkle.svg";
import CallIcon from "@/public/assets/images/crm/activity/call.svg";
import EmailIcon from "@/public/assets/images/crm/activity/email.svg";
import MeetingIcon from "@/public/assets/images/crm/activity/meeting.svg";
import NoteIcon from "@/public/assets/images/crm/activity/note.svg";
import { textareaClass } from "@/components/_ui/field-styles";

const KINDS = [
  { id: "note", label: "Note" },
  { id: "call", label: "Call" },
  { id: "email", label: "Email" },
] as const;

type ActivityKind = (typeof KINDS)[number]["id"];

type SaveActivity = (
  kind: "note" | "call",
  title: string,
  body: string,
) => Promise<RecordActionState & { activity?: Activity }>;

const FILTERS: { id: TimelineFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "call", label: "Calls" },
  { id: "email", label: "Emails" },
  { id: "meeting", label: "Meetings" },
  { id: "note", label: "Notes" },
];

const MARKS: Record<TimelineKind, { icon: typeof NoteIcon; tone: string }> = {
  call: {
    icon: CallIcon,
    tone: "bg-(--tag-green-bg) text-(--tag-green-text) shadow-[inset_0_0_0_1px_var(--tag-green-border)]",
  },
  email: {
    icon: EmailIcon,
    tone: "bg-(--tag-blue-bg) text-(--tag-blue-text) shadow-[inset_0_0_0_1px_var(--tag-blue-border)]",
  },
  meeting: {
    icon: MeetingIcon,
    tone: "bg-(--tag-purple-bg) text-(--tag-purple-text) shadow-[inset_0_0_0_1px_var(--tag-purple-border)]",
  },
  note: {
    icon: NoteIcon,
    tone: "bg-(--tag-amber-bg) text-(--tag-amber-text) shadow-[inset_0_0_0_1px_var(--tag-amber-border)]",
  },
};

const OTHER_MARK = {
  icon: NoteIcon,
  tone: "bg-(--tag-neutral-bg) text-(--tag-neutral-text) shadow-[inset_0_0_0_1px_var(--tag-neutral-border)]",
};

export function QuietTabs<T extends string>({
  label,
  items,
  value,
  onChange,
}: {
  label: string;
  items: { id: T; label: string; count?: number; shortcut?: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="-mx-1 flex min-w-0 items-center gap-0.5 overflow-x-auto px-1 [scrollbar-width:none]"
    >
      {items.map((item) => (
        <Button
          key={item.id}
          variant="ghost"
          size="none"
          type="button"
          aria-pressed={value === item.id}
          data-shortcut={item.shortcut}
          className={cn(
            "h-8 gap-1 px-2.5 text-[13px] font-normal",
            value === item.id &&
              "text-foreground bg-white/[0.07] hover:bg-white/[0.07]",
          )}
          onClick={() => onChange(item.id)}
        >
          {item.label}
          {item.count !== undefined && (
            <span className="text-subtle tabular-nums">{item.count}</span>
          )}
        </Button>
      ))}
    </div>
  );
}

export function useActivityDraft(save: SaveActivity) {
  const router = useRouter();
  const saving = useRef(false);
  const [kind, setKindState] = useState<ActivityKind>("note");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [added, setAdded] = useState<Activity[]>([]);

  function setKind(next: ActivityKind) {
    setKindState(next);
    setError(null);
  }

  function withAdded(activities: Activity[]) {
    return [
      ...added.filter(
        (item) => !activities.some((activity) => activity.id === item.id),
      ),
      ...activities,
    ];
  }

  async function add(nextKind: "note" | "call") {
    if (saving.current || pending) return;
    saving.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await save(nextKind, title, body);
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.activity) {
        const activity = result.activity;
        setAdded((current) => [activity, ...current]);
      }
      setTitle("");
      setBody("");
      router.refresh();
    } finally {
      saving.current = false;
      setPending(false);
    }
  }

  function push(activity: Activity) {
    setAdded((current) => [activity, ...current]);
  }

  return {
    kind,
    setKind,
    push,
    title,
    setTitle,
    body,
    setBody,
    error,
    pending,
    add,
    withAdded,
  };
}

type ActivityDraft = ReturnType<typeof useActivityDraft>;

export function ActivityComposer({
  idPrefix,
  draft,
  about,
  email,
  pad,
}: {
  idPrefix: string;
  draft: ActivityDraft;
  about?: ReactNode;
  email: ReactNode;
  pad?: ReactNode;
}) {
  const { kind, title, body, pending } = draft;
  const root = useRef<HTMLDivElement>(null);

  function compose(next: ActivityKind) {
    draft.setKind(next);
    window.requestAnimationFrame(() => {
      root.current?.scrollIntoView({ block: "nearest" });
      root.current?.querySelector<HTMLElement>("[data-compose-focus]")?.focus();
    });
  }

  useShortcut("compose-note", () => compose("note"));
  useShortcut("compose-call", () => compose("call"));
  useShortcut("compose-email", () => compose("email"));
  useShortcut("create-activity", () => compose("note"));

  return (
    <div
      ref={root}
      data-shortcut-scope=""
      className="border-line-strong bg-card flex flex-col gap-2.5 rounded-xl border p-2.5"
    >
      {pad ? (
        <QuietTabs
          label="Activity type"
          items={[
            { id: "note", label: "Log activity" },
            { id: "email", label: "Send email" },
          ]}
          value={kind === "email" ? "email" : "note"}
          onChange={compose}
        />
      ) : (
        <QuietTabs
          label="Activity type"
          items={KINDS.map((item) => ({ id: item.id, label: item.label }))}
          value={kind}
          onChange={draft.setKind}
        />
      )}
      {pad && kind !== "email" ? pad : null}
      {(!pad || kind === "email") && about}
      {draft.error && (
        <p role="alert" className="caption-style text-danger">
          {draft.error}
        </p>
      )}
      {!pad && kind === "note" && (
        <div className="flex flex-col gap-2">
          <label className="sr-only" htmlFor={`activity-note-${idPrefix}`}>
            Note
          </label>
          <textarea
            id={`activity-note-${idPrefix}`}
            data-compose-focus=""
            value={body}
            onChange={(event) => draft.setBody(event.target.value)}
            placeholder="Write a note"
            maxLength={10000}
            className={cn(textareaClass, "min-h-20")}
          />
          <Button
            variant="secondary"
            size="sm"
            type="button"
            className="self-start"
            disabled={pending || body.trim() === ""}
            data-shortcut-submit=""
            title="Add note (⌘ Enter)"
            onClick={() => draft.add("note")}
          >
            {pending ? "Saving…" : "Add note"}
          </Button>
        </div>
      )}
      {!pad && kind === "call" && (
        <div className="flex flex-col gap-2">
          <label className="sr-only" htmlFor={`activity-call-${idPrefix}`}>
            Call summary
          </label>
          <Input
            id={`activity-call-${idPrefix}`}
            data-compose-focus=""
            value={title}
            autoComplete="off"
            onChange={(event) => draft.setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
            placeholder="What was the call about?"
            maxLength={200}
          />
          <label className="sr-only" htmlFor={`activity-call-body-${idPrefix}`}>
            Call details
          </label>
          <textarea
            id={`activity-call-body-${idPrefix}`}
            value={body}
            onChange={(event) => draft.setBody(event.target.value)}
            placeholder="Details"
            maxLength={10000}
            className={cn(textareaClass, "min-h-20")}
          />
          <Button
            variant="secondary"
            size="sm"
            type="button"
            className="self-start"
            disabled={pending || (title.trim() === "" && body.trim() === "")}
            data-shortcut-submit=""
            title="Add call (⌘ Enter)"
            onClick={() => draft.add("call")}
          >
            {pending ? "Saving…" : "Add call"}
          </Button>
        </div>
      )}
      {kind === "email" && email}
    </div>
  );
}

export function ActivityTimeline({
  activities: given,
  insights,
  showContact,
  viewerId,
  viewerRole,
  filters,
  empty,
}: {
  activities: Activity[];
  insights?: Record<string, CallInsight>;
  showContact?: boolean;
  viewerId?: string | null;
  viewerRole?: string | null;
  filters?: ReactNode;
  empty: string;
}) {
  const baseId = useId();
  const [now] = useState(() => Date.now());
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [removed, setRemoved] = useState<string[]>([]);
  const activities = removed.length ? given.filter((activity) => !removed.includes(activity.id)) : given;
  const manager = viewerRole === "owner" || viewerRole === "admin";
  const counts = countKinds(activities);
  const active = counts[filter] > 0 ? filter : "all";
  const shown =
    active === "all"
      ? activities
      : activities.filter((activity) => timelineKind(activity) === active);
  const groups = groupByDay(shown, now);

  return (
    <div className="flex flex-col gap-3">
      {activities.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <QuietTabs
            label="Filter activity by type"
            items={FILTERS.filter(
              (item) => item.id === "all" || counts[item.id] > 0,
            ).map((item) => ({
              id: item.id,
              label: item.label,
              count: counts[item.id],
              shortcut: item.id === "all" ? "timeline-filter" : undefined,
            }))}
            value={active}
            onChange={setFilter}
          />
          {filters}
        </div>
      )}
      {groups.length === 0 ? (
        <p className="caption-style text-subtle">{empty}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {groups.map((group) => {
            const headingId = `${baseId}-day-${group.key}`;
            return (
              <section key={group.key} aria-labelledby={headingId}>
                <h3
                  id={headingId}
                  className="caption-style text-subtle bg-background sticky top-0 z-10 px-2 pt-3 pb-1.5 font-medium"
                >
                  {group.label}
                </h3>
                <ul className="flex flex-col">
                  {group.items.map((activity) => (
                    <ActivityRow
                      key={activity.id}
                      panelId={`${baseId}-panel-${activity.id}`}
                      activity={activity}
                      insight={insights?.[activity.id] ?? null}
                      showContact={showContact}
                      viewerId={viewerId}
                      deletable={manager || (Boolean(viewerId) && activity.actorUserId === viewerId)}
                      onDeleted={() => setRemoved((current) => [...current, activity.id])}
                      now={now}
                      open={open[activity.id] ?? false}
                      onToggle={() =>
                        setOpen((current) => ({
                          ...current,
                          [activity.id]: !current[activity.id],
                        }))
                      }
                    />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function ContactActivities({
  contactId,
  email,
  recipient,
  mailboxConnected,
  viewerId,
  viewerRole,
  activities,
  insights,
  className,
}: {
  contactId: string;
  email: string | null;
  recipient: Recipient;
  mailboxConnected: boolean;
  viewerId?: string | null;
  viewerRole?: string | null;
  activities: Activity[];
  insights?: Record<string, CallInsight>;
  className?: string;
}) {
  const draft = useActivityDraft((kind, title, body) =>
    addActivityAction({ contactId }, kind, title, body),
  );

  return (
    <DetailSection title="Activity" className={cn("shadow-none", className)}>
      <ActivityComposer
        idPrefix={contactId}
        draft={draft}
        pad={<ActivityPad fixedContact={{ id: contactId, name: recipient.name || "This contact" }} onAdded={draft.push} />}
        email={
          <ContactEmail
            contactId={contactId}
            email={email}
            recipient={recipient}
            mailboxConnected={mailboxConnected}
          />
        }
      />
      <ActivityTimeline
        activities={draft.withAdded(activities)}
        insights={insights}
        viewerId={viewerId}
        viewerRole={viewerRole}
        empty="No activity yet."
      />
    </DetailSection>
  );
}

function activityMeta(
  activity: Activity,
  byline: string | null,
  contact: string | null,
) {
  const direction = activityDirection(activity);
  const received = direction === "Received";
  const parts = [
    received ? byline : contact,
    direction && !received
      ? direction === "Sent" && byline
        ? `Sent ${byline}`
        : direction
      : null,
    callDuration(activity),
    activitySource(activity),
    received || direction === "Sent" ? null : byline,
  ].filter(Boolean) as string[];
  const line = parts.join(" · ");
  return line ? line.charAt(0).toUpperCase() + line.slice(1) : "";
}

function emailParty(activity: Activity) {
  const value =
    activity.metadata.direction === "outbound"
      ? activity.metadata.to
      : activity.metadata.from;
  const list = (Array.isArray(value) ? value : [value]).filter(
    (item): item is string => typeof item === "string" && item.trim() !== "",
  );
  if (list.length === 0) return null;
  const sender = activity.metadata.direction === "outbound" && typeof activity.metadata.from === "string" ? activity.metadata.from : null;
  if (sender) return `From ${sender} to ${list.join(", ")}`;
  return `${activity.metadata.direction === "outbound" ? "To" : "From"} ${list.join(", ")}`;
}

function emailAttachments(activity: Activity) {
  const value = activity.metadata.attachments;
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string" ? (item as { name: string }).name : null))
    .filter((name): name is string => Boolean(name));
}

function DeleteActivity({ activityId, onDeleted }: { activityId: string; onDeleted: () => void }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setPending(true);
    setError(null);
    const result = await archiveActivityAction(activityId);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onDeleted();
    router.refresh();
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <HoldButton disabled={pending} onConfirm={() => void remove()}>
        {pending ? "Deleting…" : "Hold to delete"}
      </HoldButton>
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function ActivityRow({
  panelId,
  activity,
  insight,
  showContact,
  viewerId,
  deletable,
  onDeleted,
  now,
  open,
  onToggle,
}: {
  panelId: string;
  activity: Activity;
  insight: CallInsight | null;
  showContact?: boolean;
  viewerId?: string | null;
  deletable: boolean;
  onDeleted: () => void;
  now: number;
  open: boolean;
  onToggle: () => void;
}) {
  const kind = timelineKind(activity);
  const mark = kind ? MARKS[kind] : OTHER_MARK;
  const Icon = mark.icon;
  const title = activityTitle(activity);
  const byline = activityByline(activity, viewerId);
  const contact = showContact ? (activity.contactName ?? null) : null;
  const meta = activityMeta(activity, byline, contact);
  const summarised = insight?.status === "ready" && Boolean(insight.summary);
  const details = activityDetails(activity);
  const granola = granolaUrl(activity);
  const party = activity.type === "email" ? emailParty(activity) : null;
  const attached = activity.type === "email" ? emailAttachments(activity) : [];
  const insightful = activity.type === "call" || activity.type === "meeting";
  const emptyPanel =
    !details.body && !details.attendees && !granola && !party && !insightful;

  return (
    <li id={`activity-${activity.id}`} className="flex scroll-mt-10 flex-col">
      <Button
        variant="item"
        size="none"
        type="button"
        className={cn("group gap-3 px-2 py-2", open && "bg-white/[0.03]")}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
      >
        <span
          className={cn(
            "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full",
            mark.tone,
          )}
        >
          <Icon aria-hidden className="size-3.5" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 text-[14px] leading-5",
                open ? "break-words" : "truncate",
              )}
            >
              {title}
            </span>
            {summarised && (
              <SparkleIcon
                aria-label="Has a summary"
                className="text-primary-foreground size-3 shrink-0 self-center"
              />
            )}
            <time
              dateTime={activity.occurredAt}
              title={activityWhen(activity.occurredAt, now)}
              className="caption-style text-subtle shrink-0 tabular-nums"
              suppressHydrationWarning
            >
              {activityTime(activity.occurredAt)}
            </time>
          </span>
          {meta && (
            <span className="caption-style text-subtle truncate leading-4">
              {meta}
            </span>
          )}
        </span>
      </Button>
      <div
        id={panelId}
        hidden={!open}
        className="flex flex-col gap-3 pr-2 pt-1 pb-3 pl-12"
      >
        {party && <span className="caption-style text-subtle">{party}</span>}
        {attached.length > 0 && (
          <span className="caption-style text-subtle flex flex-wrap items-center gap-1.5">
            <PaperclipIcon aria-hidden className="size-3" />
            {attached.join(", ")}
          </span>
        )}
        {details.attendees && (
          <div className="flex flex-col gap-1">
            <span className="caption-style text-subtle">Attendees</span>
            <p className="text-[14px] leading-5">{details.attendees}</p>
          </div>
        )}
        {details.body && (
          <p className="text-[14px] leading-5 break-words whitespace-pre-wrap">
            {details.body}
          </p>
        )}
        {granola && (
          <a
            href={granola}
            target="_blank"
            rel="noreferrer"
            className={cn(
              buttonVariants({ variant: "link", size: "none" }),
              "caption-style self-start",
            )}
          >
            Open in Granola
          </a>
        )}
        {insightful && (
          <CallInsightPanel activityId={activity.id} insight={insight} />
        )}
        {emptyPanel && (
          <p className="caption-style text-subtle">No details recorded.</p>
        )}
        {deletable && open && <DeleteActivity activityId={activity.id} onDeleted={onDeleted} />}
      </div>
    </li>
  );
}
