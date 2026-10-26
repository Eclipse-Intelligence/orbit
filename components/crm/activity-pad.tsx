"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { DateTimePicker } from "@/components/_ui/date-picker";
import MentionInput, { type InputMark } from "@/components/assistant/mention-input";
import { useDictation } from "@/components/crm/use-dictation";
import { activitySuggestionsAction, logPadActivityAction, tidyActivityAction } from "@/app/(crm)/activity-pad";
import { parseActivityText, type PadActivityType } from "@/lib/activity-pad";
import type { ActivitySuggestion, ActivityTidy } from "@/lib/crm/activity-pad";
import type { Activity } from "@/lib/crm/types";
import { formatDateLabel, formatDateTimeLabel } from "@/lib/date-input";
import { encodeMentions, liveMentions, type Mention } from "@/lib/mentions";
import { londonParts } from "@/lib/task-pad";
import { cn } from "@/lib/utils";
import ArrowUpIcon from "@/public/assets/images/assistant/arrow-up.svg";
import MicIcon from "@/public/assets/images/_common/mic.svg";

const TYPE_LABELS: Record<PadActivityType, string> = { call: "Call", email: "Email", meeting: "Meeting", note: "Note" };
const MARK_CLASSES: Record<"type" | "when" | "followup", string> = {
  type: "bg-[var(--tag-blue-bg)] text-[var(--tag-blue-text)] shadow-[0_0_0_2px_var(--tag-blue-bg)]",
  when: "bg-[var(--tag-green-bg)] text-[var(--tag-green-text)] shadow-[0_0_0_2px_var(--tag-green-bg)]",
  followup: "bg-[var(--tag-amber-bg)] text-[var(--tag-amber-text)] shadow-[0_0_0_2px_var(--tag-amber-bg)]",
};
const CHIP =
  "inline-flex h-7 w-auto max-w-full min-w-0 items-center gap-1.5 rounded-full bg-white/[0.06] px-2.5 text-[12.5px] leading-none text-soft transition-colors duration-150 hover:bg-white/10 hover:text-foreground";
const TIDY_LENGTH = 140;
const KINDS = ["contact", "company"] as const;

type PadRecord = { id: string; name: string };

function localFromIso(iso: string) {
  const wall = londonParts(new Date(iso));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`;
}

function timeLabel(iso: string) {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }).format(new Date(iso));
}

function RecordChip({ label, onRemove }: { label: string; onRemove?: () => void }) {
  return (
    <span className="text-soft inline-flex h-7 max-w-full min-w-0 items-center gap-1 rounded-full bg-white/[0.06] pr-1 pl-2.5 text-[12.5px]">
      <span className={cn("truncate", !onRemove && "pr-1.5")}>{label}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${label}`}
          onClick={onRemove}
          className="text-subtle hover:text-foreground flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full hover:bg-white/10"
        >
          <svg aria-hidden width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
            <path d="M6 6 18 18M18 6 6 18" />
          </svg>
        </button>
      )}
    </span>
  );
}

export default function ActivityPad({
  fixedContact,
  fixedCompany,
  suggestions: offerSuggestions = false,
  placeholder,
  onAdded,
  className,
  shortcut,
  autoFocus,
}: {
  shortcut?: string;
  autoFocus?: boolean;
  fixedContact?: PadRecord | null;
  fixedCompany?: PadRecord | null;
  suggestions?: boolean;
  placeholder?: string;
  onAdded?: (activity: Activity) => void;
  className?: string;
}) {
  const router = useRouter();
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [type, setType] = useState<PadActivityType | null>(null);
  const [when, setWhen] = useState<string | null | undefined>(undefined);
  const [follow, setFollow] = useState(false);
  const [followTitle, setFollowTitle] = useState<string | null>(null);
  const [eventId, setEventId] = useState<string | null>(null);
  const [tidy, setTidy] = useState<{ text: string; value: ActivityTidy } | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [starters, setStarters] = useState<ActivitySuggestion[] | null>(null);
  const [focused, setFocused] = useState(false);
  const dictation = useDictation((spoken) => {
    setText((current) => (current.trim() ? `${current.trimEnd()} ${spoken}` : spoken));
  });

  const parsed = parseActivityText(text);
  const fresh = tidy && tidy.text === text ? tidy.value : null;
  const live = liveMentions(text, mentions);
  const taggedContact = [...live].reverse().find((mention) => mention.kind === "contact");
  const taggedCompany = [...live].reverse().find((mention) => mention.kind === "company");
  const contact: PadRecord | null = fixedContact ?? (taggedContact ? { id: taggedContact.id, name: taggedContact.name } : null);
  const company: PadRecord | null = fixedCompany ?? (taggedCompany ? { id: taggedCompany.id, name: taggedCompany.name } : null);
  const finalType: PadActivityType = type ?? (parsed.typeFound ? parsed.type : (fresh?.type ?? parsed.type));
  const finalWhen = when !== undefined ? when : parsed.when;
  const followDue = parsed.followUp?.due ?? fresh?.followUpDue ?? null;
  const firstName = contact?.name.split(" ")[0] ?? company?.name ?? null;
  const finalFollowTitle = followTitle ?? fresh?.followUpTitle ?? (firstName ? `Follow up with ${firstName}` : "Follow up");
  const hasText = text.trim() !== "";
  const marks: InputMark[] = parsed.marks.map((mark) => ({ start: mark.start, end: mark.end, className: MARK_CLASSES[mark.kind] }));

  useEffect(() => {
    const value = text.trim();
    if (!value || (value.length < TIDY_LENGTH && !parsed.followUp) || dictation.listening) return;
    if (tidy?.text === text) return;
    let live = true;
    const timer = window.setTimeout(() => {
      setReading(true);
      const names = liveMentions(text, mentions).map((mention) => mention.name);
      void tidyActivityAction(encodeMentions(text, liveMentions(text, mentions)), names)
        .then((value) => {
          if (live && value) setTidy({ text, value });
        })
        .finally(() => {
          if (live) setReading(false);
        });
    }, 900);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [text, mentions, parsed.followUp, dictation.listening, tidy?.text]);

  function loadStarters() {
    setFocused(true);
    if (!offerSuggestions || starters !== null) return;
    setStarters([]);
    void activitySuggestionsAction()
      .then(setStarters)
      .catch(() => undefined);
  }

  function reset() {
    setText("");
    setMentions([]);
    setType(null);
    setWhen(undefined);
    setFollow(false);
    setFollowTitle(null);
    setEventId(null);
    setTidy(null);
    setError(null);
  }

  function applyStarter(starter: ActivitySuggestion) {
    const people: Mention[] = starter.contacts.map((person) => ({ kind: "contact", id: person.id, name: person.name }));
    const companyMention: Mention[] = starter.company && people.length === 0 ? [{ kind: "company", id: starter.company.id, name: starter.company.name }] : [];
    const tags = [...people, ...companyMention];
    const lead = tags.length ? `Met ${tags.map((tag) => `@${tag.name}`).join(" and ")}: ` : `${starter.subject}: `;
    setText(lead);
    setMentions(tags);
    setType("meeting");
    setWhen(localFromIso(starter.startsAt));
    setEventId(starter.eventId);
    setStarters((current) => current?.filter((item) => item.eventId !== starter.eventId) ?? null);
    window.requestAnimationFrame(() => {
      const node = input.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(lead.length, lead.length);
    });
  }

  async function submit() {
    if (busy || !hasText) return;
    if (dictation.listening) dictation.stop();
    if (!contact && !company) {
      setError("Tag who it was with: type @ and pick a person or company.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await logPadActivityAction({
      text: encodeMentions(text, live),
      type: finalType,
      when: finalWhen ?? null,
      contactId: contact?.id ?? null,
      companyId: company?.id ?? null,
      title: fresh && text.trim().length >= TIDY_LENGTH ? fresh.title : null,
      followUp: follow && followDue ? { title: finalFollowTitle, due: followDue } : null,
      eventId,
    }).catch((): { activity?: Activity; warning?: string | null; error?: string } => ({ error: "That didn't save. Try again." }));
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    const saved = result.activity;
    setNotice(
      [`${TYPE_LABELS[finalType]} logged`, follow && followDue ? `task added for ${formatDateLabel(followDue.slice(0, 10))}` : null]
        .filter(Boolean)
        .join(", ") + (result.warning ? `. ${result.warning}` : "."),
    );
    reset();
    if (saved) onAdded?.(saved);
    router.refresh();
    input.current?.focus();
  }

  const showStarters = offerSuggestions && focused && !hasText && (starters?.length ?? 0) > 0;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="bg-secondary focus-within:border-ring border-line-strong flex items-end gap-2 rounded-2xl border py-1.5 pr-1.5 pl-3.5 transition-[border-color] duration-150">
        <div className="min-w-0 flex-1 py-0.5">
          <MentionInput
            id={`${id}-activity`}
            inputRef={input}
            value={dictation.interim ? `${text}${text && !text.endsWith(" ") ? " " : ""}${dictation.interim}` : text}
            mentions={mentions}
            marks={marks}
            kinds={[...KINDS]}
            listPlacement="below"
            ariaLabel="Log an activity"
            composeFocus
            shortcut={shortcut}
            autoFocus={autoFocus}
            onFocus={loadStarters}
            placeholder={placeholder ?? (dictation.listening ? "Listening…" : "What happened? e.g. Called @Jane, wants pricing by Friday")}
            onChange={(next, nextMentions) => {
              setText(next);
              setMentions(nextMentions);
              setError(null);
              setNotice(null);
              if (!next.trim()) reset();
            }}
            onSubmit={() => void submit()}
          />
        </div>
        {dictation.supported && (
          <Button
            variant={dictation.listening ? "primary" : "ghost"}
            size="icon"
            type="button"
            aria-pressed={dictation.listening}
            aria-label={dictation.listening ? "Stop dictating" : "Dictate"}
            title={dictation.listening ? "Stop dictating" : "Dictate"}
            onClick={dictation.toggle}
            className={cn("shrink-0", dictation.listening && "animate-pulse")}
          >
            <MicIcon aria-hidden className="size-3.5" />
          </Button>
        )}
        <Button
          variant="primary"
          size="icon"
          type="button"
          aria-label="Log activity"
          title="Log activity (Enter)"
          disabled={busy || !hasText}
          onClick={() => void submit()}
          className="shrink-0"
        >
          <ArrowUpIcon aria-hidden className="size-3.5" />
        </Button>
      </div>

      {showStarters && (
        <ul className="flex flex-col gap-1" aria-label="Recent meetings to log">
          {starters!.map((starter) => (
            <li key={starter.eventId}>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => applyStarter(starter)}
                className="hover:bg-white/[0.06] flex w-full cursor-pointer items-center gap-2 rounded-xl bg-white/[0.03] px-3 py-2 text-left transition-colors duration-150"
              >
                <span className="text-foreground min-w-0 flex-1 truncate text-[13px] leading-5">How did {starter.subject} go?</span>
                <span className="caption-style text-subtle shrink-0">
                  {timeLabel(starter.startsAt)}
                  {starter.contacts[0] ? ` · ${starter.contacts[0].name}` : starter.company ? ` · ${starter.company.name}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {(hasText || fixedContact || fixedCompany) && hasText && (
        <div className="flex flex-wrap items-center gap-1.5">
          <label className={cn(CHIP, "focus-within:ring-ring/60 relative cursor-pointer pr-2 focus-within:ring-2")}>
            <span className="sr-only">Activity type</span>
            <select
              value={finalType}
              onChange={(event) => setType(event.target.value as PadActivityType)}
              className="cursor-pointer appearance-none bg-transparent text-[12.5px] outline-none"
            >
              {(Object.keys(TYPE_LABELS) as PadActivityType[]).map((option) => (
                <option key={option} value={option}>
                  {TYPE_LABELS[option]}
                </option>
              ))}
            </select>
          </label>
          <DateTimePicker
            id={`${id}-when`}
            aria-label="When it happened"
            placeholder="Now"
            value={finalWhen ?? ""}
            onChange={(value) => setWhen(value || null)}
            className={cn(CHIP, "border-transparent [&_svg]:size-3.5", !finalWhen && "text-subtle")}
          />
          {contact && (
            <RecordChip
              label={contact.name}
              onRemove={fixedContact ? undefined : () => setMentions((current) => current.filter((mention) => mention.id !== contact.id))}
            />
          )}
          {company && !fixedCompany && (
            <RecordChip label={company.name} onRemove={() => setMentions((current) => current.filter((mention) => mention.id !== company.id))} />
          )}
          {followDue && (
            <button
              type="button"
              aria-pressed={follow}
              onClick={() => setFollow((current) => !current)}
              className={cn(
                CHIP,
                "cursor-pointer",
                follow && "bg-[var(--tag-amber-bg)] text-[var(--tag-amber-text)] shadow-[inset_0_0_0_1px_var(--tag-amber-border)] hover:bg-[var(--tag-amber-bg)]",
              )}
            >
              <span aria-hidden>{follow ? "✓" : "+"}</span>
              <span className="truncate">
                Task: {finalFollowTitle} · {formatDateTimeLabel(followDue)}
              </span>
            </button>
          )}
          {reading && <span className="caption-style text-subtle px-1">Reading…</span>}
        </div>
      )}
      {follow && followDue && hasText && (
        <label className="flex items-center gap-2">
          <span className="caption-style text-subtle shrink-0">Task</span>
          <input
            value={finalFollowTitle}
            onChange={(event) => setFollowTitle(event.target.value)}
            aria-label="Follow-up task title"
            className="border-line-strong bg-secondary h-8 min-w-0 flex-1 rounded-lg border px-2.5 text-[13px] outline-none focus-visible:border-ring"
          />
        </label>
      )}
      {(error || dictation.error) && (
        <p role="alert" className="caption-style text-danger">
          {error ?? dictation.error}
        </p>
      )}
      {notice && !error && (
        <p role="status" className="caption-style text-subtle">
          {notice}
        </p>
      )}
    </div>
  );
}
