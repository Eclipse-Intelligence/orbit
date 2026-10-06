"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import { addContactActivityAction } from "@/app/(crm)/records";
import ContactEmail from "@/components/crm/contact-email";
import { formatDate } from "@/lib/companies";
import type { Activity } from "@/lib/crm/types";

const KINDS = [
  { id: "note", label: "Note" },
  { id: "call", label: "Call" },
  { id: "email", label: "Email" },
] as const;

type Kind = (typeof KINDS)[number]["id"];

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

export default function ContactActivities({
  contactId,
  email,
  mailboxConnected,
  profileNote,
  activities,
}: {
  contactId: string;
  email: string | null;
  mailboxConnected: boolean;
  profileNote: string | null;
  activities: Activity[];
}) {
  const router = useRouter();
  const saving = useRef(false);
  const [kind, setKind] = useState<Kind>("note");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [added, setAdded] = useState<Activity[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);

  const listed = [
    ...added.filter(
      (item) => !activities.some((activity) => activity.id === item.id),
    ),
    ...activities,
  ];
  const savedNote = profileNote?.trim() ?? "";
  const showProfileNote =
    savedNote !== "" &&
    !listed.some(
      (activity) =>
        activity.type === "note" && activity.body?.trim() === savedNote,
    );

  async function add(nextKind: "note" | "call") {
    if (saving.current || pending) return;
    saving.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await addContactActivityAction(
        contactId,
        nextKind,
        title,
        body,
      );
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

  return (
    <section className="border-line-strong flex flex-col gap-3 border-t pt-4">
      <h2>Activities</h2>
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
            onClick={() => {
              setKind(item.id);
              setError(null);
            }}
          >
            {item.label}
          </Button>
        ))}
      </div>
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      {kind === "note" && (
        <div className="flex flex-col gap-2">
          <label className="sr-only" htmlFor={`activity-note-${contactId}`}>
            Note
          </label>
          <textarea
            id={`activity-note-${contactId}`}
            value={body}
            onChange={(event) => setBody(event.target.value)}
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
            onClick={() => add("note")}
          >
            {pending ? "Saving…" : "Add note"}
          </Button>
        </div>
      )}
      {kind === "call" && (
        <div className="flex flex-col gap-2">
          <label className="sr-only" htmlFor={`activity-call-${contactId}`}>
            Call summary
          </label>
          <Input
            id={`activity-call-${contactId}`}
            value={title}
            autoComplete="off"
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
            placeholder="What was the call about?"
            maxLength={200}
          />
          <label
            className="sr-only"
            htmlFor={`activity-call-body-${contactId}`}
          >
            Call details
          </label>
          <textarea
            id={`activity-call-body-${contactId}`}
            value={body}
            onChange={(event) => setBody(event.target.value)}
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
            onClick={() => add("call")}
          >
            {pending ? "Saving…" : "Add call"}
          </Button>
        </div>
      )}
      {kind === "email" && (
        <ContactEmail
          contactId={contactId}
          email={email}
          mailboxConnected={mailboxConnected}
        />
      )}
      {listed.length === 0 && !showProfileNote ? (
        <p className="caption-style text-subtle">No activity yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {showProfileNote && (
            <li className="flex flex-col gap-1">
              <span className="text-[14px] leading-5">Note</span>
              <p className="text-[14px] leading-5 whitespace-pre-wrap">
                {savedNote}
              </p>
              <span className="caption-style text-subtle">
                Saved on the contact
              </span>
            </li>
          )}
          {listed.map((activity) => (
            <ActivityItem
              key={activity.id}
              activity={activity}
              open={openId === activity.id}
              onToggle={() =>
                setOpenId(openId === activity.id ? null : activity.id)
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ActivityItem({
  activity,
  open,
  onToggle,
}: {
  activity: Activity;
  open: boolean;
  onToggle: () => void;
}) {
  const label = activityLabel(activity);
  const heading = activity.title ? `${label} · ${activity.title}` : label;
  const when = formatDate(activity.occurredAt);

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
            <span className="caption-style text-subtle">{when}</span>
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
      <span className="caption-style text-subtle">{when}</span>
    </li>
  );
}

function activityLabel(activity: Activity) {
  if (activity.type === "email" && activity.metadata.source === "microsoft") {
    return activity.metadata.direction === "outbound" ? "Sent" : "Received";
  }
  return LABELS[activity.type] ?? activity.type;
}
