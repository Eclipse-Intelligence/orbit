"use client";

import { useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Button, { buttonVariants } from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import { addActivityAction, type RecordActionState } from "@/app/(crm)/records";
import CallInsightPanel from "@/components/crm/call-insight";
import ContactEmail from "@/components/crm/contact-email";
import { formatDate } from "@/lib/companies";
import { cn } from "@/lib/utils";
import type { Activity, CallInsight } from "@/lib/crm/types";

const KINDS = [
  { id: "note", label: "Note" },
  { id: "call", label: "Call" },
  { id: "email", label: "Email" },
] as const;

export type ActivityKind = (typeof KINDS)[number]["id"];

type SaveActivity = (
  kind: "note" | "call",
  title: string,
  body: string,
) => Promise<RecordActionState & { activity?: Activity }>;

const LABELS: Record<string, string> = {
  email: "Email",
  meeting: "Meeting",
  call: "Call",
  note: "Note",
  research: "Research",
  linkedin: "LinkedIn",
  agent_update: "Agent update",
  other: "Other",
};

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

  return {
    kind,
    setKind,
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

export type ActivityDraft = ReturnType<typeof useActivityDraft>;

export function ActivityComposer({
  idPrefix,
  draft,
  about,
  email,
}: {
  idPrefix: string;
  draft: ActivityDraft;
  about?: ReactNode;
  email: ReactNode;
}) {
  const { kind, title, body, pending } = draft;
  return (
    <>
      <div
        className="flex flex-wrap gap-1"
        role="group"
        aria-label="Activity type"
      >
        {KINDS.map((item) => (
          <Button
            key={item.id}
            variant={kind === item.id ? "primary" : "subtle"}
            size="sm"
            type="button"
            aria-pressed={kind === item.id}
            onClick={() => draft.setKind(item.id)}
          >
            {item.label}
          </Button>
        ))}
      </div>
      {about}
      {draft.error && (
        <p role="alert" className="caption-style text-danger">
          {draft.error}
        </p>
      )}
      {kind === "note" && (
        <div className="flex flex-col gap-2">
          <label className="sr-only" htmlFor={`activity-note-${idPrefix}`}>
            Note
          </label>
          <textarea
            id={`activity-note-${idPrefix}`}
            value={body}
            onChange={(event) => draft.setBody(event.target.value)}
            placeholder="Write a note"
            maxLength={10000}
            className="border-line-strong bg-secondary min-h-20 w-full rounded-lg border px-3 py-2 text-[14px] leading-5 outline-none"
          />
          <Button
            variant="secondary"
            size="sm"
            type="button"
            className="self-start"
            disabled={pending || body.trim() === ""}
            onClick={() => draft.add("note")}
          >
            {pending ? "Saving…" : "Add note"}
          </Button>
        </div>
      )}
      {kind === "call" && (
        <div className="flex flex-col gap-2">
          <label className="sr-only" htmlFor={`activity-call-${idPrefix}`}>
            Call summary
          </label>
          <Input
            id={`activity-call-${idPrefix}`}
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
            className="border-line-strong bg-secondary min-h-20 w-full rounded-lg border px-3 py-2 text-[14px] leading-5 outline-none"
          />
          <Button
            variant="secondary"
            size="sm"
            type="button"
            className="self-start"
            disabled={pending || (title.trim() === "" && body.trim() === "")}
            onClick={() => draft.add("call")}
          >
            {pending ? "Saving…" : "Add call"}
          </Button>
        </div>
      )}
      {kind === "email" && email}
    </>
  );
}

export function ActivityTimeline({
  activities,
  insights,
  showContact,
  lead,
  empty,
}: {
  activities: Activity[];
  insights?: Record<string, CallInsight>;
  showContact?: boolean;
  lead?: ReactNode;
  empty: string;
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (activities.length === 0 && !lead) {
    return <p className="caption-style text-subtle">{empty}</p>;
  }

  return (
    <ul className="flex flex-col gap-3">
      {lead}
      {activities.map((activity) => (
        <ActivityItem
          key={activity.id}
          activity={activity}
          insight={insights?.[activity.id] ?? null}
          showContact={showContact}
          open={openId === activity.id}
          onToggle={() =>
            setOpenId(openId === activity.id ? null : activity.id)
          }
        />
      ))}
    </ul>
  );
}

export default function ContactActivities({
  contactId,
  email,
  mailboxConnected,
  profileNote,
  activities,
  insights,
  className,
}: {
  contactId: string;
  email: string | null;
  mailboxConnected: boolean;
  profileNote: string | null;
  activities: Activity[];
  insights?: Record<string, CallInsight>;
  className?: string;
}) {
  const draft = useActivityDraft((kind, title, body) =>
    addActivityAction({ contactId }, kind, title, body),
  );

  const listed = draft.withAdded(activities);
  const savedNote = profileNote?.trim() ?? "";
  const showProfileNote =
    savedNote !== "" &&
    !listed.some(
      (activity) =>
        activity.type === "note" && activity.body?.trim() === savedNote,
    );

  return (
    <section
      className={cn(
        "border-line-strong flex flex-col gap-3 border-t pt-4",
        className,
      )}
    >
      <h2>Activities</h2>
      <ActivityComposer
        idPrefix={contactId}
        draft={draft}
        email={
          <ContactEmail
            contactId={contactId}
            email={email}
            mailboxConnected={mailboxConnected}
          />
        }
      />
      <ActivityTimeline
        activities={listed}
        insights={insights}
        empty="No activity yet."
        lead={
          showProfileNote && (
            <li className="flex flex-col gap-1">
              <span className="text-[14px] leading-5">Note</span>
              <p className="text-[14px] leading-5 whitespace-pre-wrap">
                {savedNote}
              </p>
              <span className="caption-style text-subtle">
                Saved on the contact
              </span>
            </li>
          )
        }
      />
    </section>
  );
}

function ActivityItem({
  activity,
  insight,
  showContact,
  open,
  onToggle,
}: {
  activity: Activity;
  insight: CallInsight | null;
  showContact?: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const label = activityLabel(activity);
  const heading = activity.title ? `${label} · ${activity.title}` : label;
  const when = formatDate(activity.occurredAt);
  const meta =
    showContact && activity.contactName
      ? `${activity.contactName} · ${when}`
      : when;

  if (activity.type === "email" && activity.body) {
    const panelId = `activity-email-${activity.id}`;
    return (
      <li className="flex flex-col gap-1">
        <Button
          variant="item"
          size="sm"
          type="button"
          className="h-auto py-2 leading-5"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
        >
          <span className="flex w-full flex-col gap-1">
            <span>{heading}</span>
            <span className="caption-style text-subtle">{meta}</span>
          </span>
        </Button>
        {open && (
          <p
            id={panelId}
            className="px-2 text-[14px] leading-5 whitespace-pre-wrap"
          >
            {activity.body}
          </p>
        )}
      </li>
    );
  }

  return (
    <li className="flex flex-col gap-1">
      <span className="text-[14px] leading-5">{heading}</span>
      {activity.body && (
        <p className="text-[14px] leading-5 whitespace-pre-wrap">
          {activity.body}
        </p>
      )}
      <span className="caption-style text-subtle">{meta}</span>
      {granolaUrl(activity) && (
        <a
          href={granolaUrl(activity)!}
          target="_blank"
          rel="noreferrer"
          className={cn(buttonVariants({ variant: "link", size: "none" }), "caption-style self-start")}
        >
          Open in Granola
        </a>
      )}
      {(activity.type === "call" || activity.type === "meeting") && (
        <CallInsightPanel activityId={activity.id} insight={insight} />
      )}
    </li>
  );
}

function granolaUrl(activity: Activity) {
  const url = activity.metadata.externalUrl;
  if (activity.metadata.source !== "granola" || typeof url !== "string") return null;
  return /^https:\/\//.test(url) ? url : null;
}

function activityLabel(activity: Activity) {
  if (activity.type === "email" && activity.metadata.source === "microsoft") {
    return activity.metadata.direction === "outbound" ? "Sent" : "Received";
  }
  return LABELS[activity.type] ?? activity.type;
}
