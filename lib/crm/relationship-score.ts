import { formatDate, relativeWhen } from "@/lib/companies";

export const RELATIONSHIP_LABELS = ["strong", "warm", "cooling", "one_sided", "cold", "new"] as const;

export type RelationshipLabel = (typeof RELATIONSHIP_LABELS)[number];

export const RELATIONSHIP_META: Record<RelationshipLabel, { label: string; color: string; meaning: string }> = {
  strong: { label: "Strong", color: "var(--success)", meaning: "Two-way and recent: they reply or meet, and the tone is good." },
  warm: { label: "Warm", color: "#a3e635", meaning: "Two-way, but slowing down or neutral." },
  cooling: { label: "Cooling", color: "var(--warning)", meaning: "Was two-way, but they've gone quiet." },
  one_sided: { label: "One-sided", color: "var(--danger)", meaning: "You're reaching out and they aren't replying." },
  cold: { label: "Cold", color: "#64748b", meaning: "Nothing either way for a long time." },
  new: { label: "New", color: "#a78bfa", meaning: "Too little history to judge." },
};

export type Tone = "positive" | "neutral" | "negative";

export type RelationshipSignals = {
  inboundCount: number;
  lastInboundAt: string | null;
  outboundCount: number;
  lastOutboundAt: string | null;
  meetingCount: number;
  lastMeetingAt: string | null;
  unanswered: number;
  firstUnansweredAt: string | null;
  recentEngagements: number;
  tone: Tone | null;
};

export type RelationshipOverride = {
  label: RelationshipLabel;
  reason: string | null;
  at: string | null;
  byUserId: string | null;
  byName: string | null;
};

export type Relationship = {
  label: RelationshipLabel;
  reason: string;
  override?: RelationshipOverride;
  automatic?: { label: RelationshipLabel; reason: string };
};

export function isRelationshipLabel(value: unknown): value is RelationshipLabel {
  return typeof value === "string" && (RELATIONSHIP_LABELS as readonly string[]).includes(value);
}

export function withOverride(computed: Relationship, override: RelationshipOverride | null | undefined): Relationship {
  if (!override) return computed;
  return {
    label: override.label,
    reason: override.reason || "Set by hand.",
    override,
    automatic: { label: computed.label, reason: computed.reason },
  };
}

const DAY = 86_400_000;

export const EMPTY_SIGNALS: RelationshipSignals = {
  inboundCount: 0,
  lastInboundAt: null,
  outboundCount: 0,
  lastOutboundAt: null,
  meetingCount: 0,
  lastMeetingAt: null,
  unanswered: 0,
  firstUnansweredAt: null,
  recentEngagements: 0,
  tone: null,
};

function latest(...values: (string | null)[]) {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
}

function days(iso: string, now: number) {
  return (now - new Date(iso).getTime()) / DAY;
}

function when(iso: string, now: number) {
  return days(iso, now) < 45 ? relativeWhen(iso, now).replace(/^Today$/, "today").replace(/^Yesterday$/, "yesterday") : `on ${formatDate(iso)}`;
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function meetingNote(signals: RelationshipSignals) {
  return signals.lastMeetingAt ? ` Last meeting ${formatDate(signals.lastMeetingAt)}.` : "";
}

function unansweredNote(signals: RelationshipSignals) {
  return `${plural(signals.unanswered, "email")} from you since ${formatDate(signals.firstUnansweredAt ?? signals.lastOutboundAt!)} with no reply.`;
}

export function scoreRelationship(signals: RelationshipSignals, now = Date.now()): Relationship {
  const theirs = latest(signals.lastInboundAt, signals.lastMeetingAt);
  const any = latest(theirs, signals.lastOutboundAt);
  if (!any) return { label: "new", reason: "No emails, calls or meetings yet." };

  if (!theirs) {
    if (signals.outboundCount <= 1 && days(signals.lastOutboundAt!, now) <= 14) {
      return { label: "new", reason: `You emailed ${when(signals.lastOutboundAt!, now)}. No reply yet.` };
    }
    return { label: "one_sided", reason: `${unansweredNote(signals)} They haven't replied or met with you.` };
  }

  const quiet = days(theirs, now);
  const heard = signals.lastInboundAt === theirs ? `Last reply ${when(theirs, now)}.` : `Last met ${when(theirs, now)}.`;

  if (signals.unanswered >= 3 || (signals.unanswered >= 2 && quiet > 60)) {
    return { label: "one_sided", reason: `${unansweredNote(signals)} ${heard}${signals.lastInboundAt === theirs ? meetingNote(signals) : ""}` };
  }
  if (quiet > 180) {
    return { label: "cold", reason: `${heard}${signals.unanswered ? ` ${unansweredNote(signals)}` : ""}` };
  }
  if (quiet > 60) {
    return { label: "cooling", reason: `${heard} Nothing back from them since.${signals.unanswered ? ` ${unansweredNote(signals)}` : ""}` };
  }
  if (signals.tone === "negative") {
    return { label: "cooling", reason: `${heard} Their latest message or call sounded unhappy.` };
  }
  const recent = `${signals.recentEngagements === 1 ? "1 reply or meeting" : `${signals.recentEngagements} replies or meetings`} in the last 90 days.`;
  const tone = signals.tone === "positive" ? " Tone is positive." : "";
  if (quiet <= 30 && signals.recentEngagements >= 2 && (signals.tone === "positive" || signals.recentEngagements >= 3)) {
    return { label: "strong", reason: `${heard} ${recent}${tone}` };
  }
  return { label: "warm", reason: `${heard} ${recent}${tone}${signals.unanswered ? ` ${unansweredNote(signals)}` : ""}` };
}
