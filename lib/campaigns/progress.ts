import { PROGRESS_STATUS_LABELS } from "@/lib/campaigns/progress-view";
import { mailboxParts, shortDay } from "@/lib/campaigns/thread-view";
import type { CampaignChannel, CampaignEventKind, CampaignProviderId, CampaignStatus, ProspectState, SequenceStep, StopReason } from "@/lib/campaigns/types";
import { withActor } from "@/lib/crm/context";
import { isUuid } from "@/lib/crm/mutate";
import { assertScope } from "@/lib/crm/scopes";
import type { Actor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { appTimeZone } from "@/lib/time";

export type ProgressStatus = "in_progress" | "pending" | "replied" | "stopped" | "finished" | "paused";

export type ProgressStepState = "done" | "current" | "next" | "later" | "stopped";

export type ProgressStep = {
  step: number;
  label: string;
  variant: string | null;
  state: ProgressStepState;
  at: string | null;
  due: string | null;
  text: string;
};

export type ProgressCounts = { opens?: number; clicks?: number; accepted?: boolean; messages?: number; replied?: boolean };

export type CampaignProgress = {
  prospectId: string;
  campaignId: string;
  name: string;
  channel: CampaignChannel;
  provider: CampaignProviderId;
  status: ProgressStatus;
  stage: string;
  current: number | null;
  total: number;
  sender: string | null;
  steps: ProgressStep[];
  counts: ProgressCounts;
};

export type CompactProgress = { prospectId: string; campaign: string; channel: CampaignChannel; status: string; stage: string; steps: string[]; counts: string };

type ProgressRow = {
  id: string;
  campaign_id: string;
  campaign_name: string;
  channel: CampaignChannel;
  provider: CampaignProviderId;
  campaign_status: CampaignStatus;
  sequence: unknown;
  state: ProspectState;
  skip_reason: string | null;
  lead_status: string | null;
  provider_state: Record<string, unknown> | null;
  replied_at: Date | null;
  stop_requested_at: Date | null;
  stopped_at: Date | null;
  stop_reason: StopReason | null;
  sender_name: string | null;
  mailbox: string | null;
  mailbox_owner: string | null;
};

export type ProgressEvent = { prospect_id: string; kind: CampaignEventKind; step: number | null; variant: string | null; occurred_at: Date; from_webhook: boolean };

const PROGRESS_SQL = `select p.id, p.campaign_id, k.name as campaign_name, k.channel, k.provider, k.status as campaign_status, k.sequence, p.state, p.skip_reason,
         p.lead_status, p.provider_state, p.replied_at, p.stop_requested_at, p.stopped_at, p.stop_reason,
         coalesce(nullif(btrim(pr.full_name), ''), nullif(s.name, ''), nullif(p.provider_state->>'senderName', '')) as sender_name,
         sent.from_address as mailbox, owner.name as mailbox_owner
  from crm.campaign_prospects p
  join crm.campaigns k on k.id = p.campaign_id
  left join crm.campaign_senders s on s.workspace_id = p.workspace_id and s.provider = k.provider and s.external_id = p.sender_id
  left join crm.profiles pr on pr.id = s.user_id
  left join lateral (
    select m.from_address from crm.campaign_messages m
    where k.channel = 'email' and m.prospect_id = p.id and m.direction = 'outbound' and m.from_address is not null
    order by m.sent_at desc
    limit 1
  ) sent on true
  left join lateral (
    select coalesce(nullif(btrim(mp.full_name), ''), mp.email) as name
    from crm.workspace_members wm
    join crm.profiles mp on mp.id = wm.user_id
    where sent.from_address is not null and wm.workspace_id = p.workspace_id
      and (lower(mp.email) = lower(btrim(coalesce(substring(sent.from_address from '<([^<>]+)>'), sent.from_address)))
        or exists (select 1 from unnest(mp.other_emails) other where lower(other) = lower(btrim(coalesce(substring(sent.from_address from '<([^<>]+)>'), sent.from_address)))))
    order by mp.id
    limit 1
  ) owner on true
  where p.id = any($1::uuid[]) and p.workspace_id = $2
  order by p.created_at, p.id`;

const PROGRESS_KINDS: CampaignEventKind[] = [
  "sent",
  "opened",
  "clicked",
  "replied",
  "invite_sent",
  "invite_accepted",
  "message_sent",
  "inmail_sent",
  "profile_viewed",
  "post_liked",
  "followed",
];

const EVENTS_SQL = `select e.prospect_id, e.kind, e.step, e.variant, e.occurred_at, coalesce((e.payload->>'fromWebhook')::boolean, false) as from_webhook
  from crm.campaign_events e
  where e.workspace_id = $1 and e.prospect_id = any($2::uuid[]) and e.kind = any($3::text[])
  order by e.occurred_at, e.id`;

const STEP_EVENTS: Record<string, CampaignEventKind> = {
  "View profile": "profile_viewed",
  "Like post": "post_liked",
  Follow: "followed",
  Invite: "invite_sent",
  Message: "message_sent",
  InMail: "inmail_sent",
};

const DAY_MS = 86_400_000;

type PlannedStep = { step: number; kind: string; variants: number; delayDays: number | null };

function plannedSteps(sequence: unknown): PlannedStep[] {
  if (!Array.isArray(sequence)) return [];
  const steps = new Map<number, PlannedStep>();
  for (const item of sequence as Partial<SequenceStep>[]) {
    if (!item || typeof item.step !== "number" || !Number.isFinite(item.step)) continue;
    const found = steps.get(item.step);
    if (found) {
      found.variants += 1;
      found.delayDays ??= typeof item.delayDays === "number" ? item.delayDays : null;
      continue;
    }
    steps.set(item.step, { step: item.step, kind: typeof item.subject === "string" ? item.subject.trim() : "", variants: 1, delayDays: typeof item.delayDays === "number" ? item.delayDays : null });
  }
  return [...steps.values()].sort((a, b) => a.step - b.step);
}

type Slot = { at: Date | null; variant: string | null };

export function eventSlots(events: Pick<ProgressEvent, "step" | "variant" | "occurred_at" | "from_webhook">[]): Slot[] {
  const webhook = events.filter((event) => event.from_webhook).sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime());
  const stepped = new Map<number, Pick<ProgressEvent, "variant" | "occurred_at">>();
  const loose: Pick<ProgressEvent, "variant" | "occurred_at">[] = [];
  for (const event of events) {
    if (event.from_webhook) continue;
    if (event.step && event.step > 0) {
      const found = stepped.get(event.step);
      if (!found || event.occurred_at < found.occurred_at) stepped.set(event.step, event);
    } else loose.push(event);
  }
  loose.sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime());
  const count = Math.max(webhook.length, stepped.size ? Math.max(...stepped.keys()) : 0, loose.length);
  const slots: Slot[] = [];
  for (let index = 0; index < count; index += 1) {
    const event = webhook[index] ?? stepped.get(index + 1) ?? loose[index] ?? null;
    slots.push({ at: event?.occurred_at ?? null, variant: event?.variant ?? null });
  }
  return slots;
}

function providerStatus(row: ProgressRow): ProgressStatus | null {
  if (row.provider === "heyreach") {
    const status = typeof row.provider_state?.status === "string" ? row.provider_state.status : null;
    if (status === "in_sequence") return "in_progress";
    if (status === "pending") return "pending";
    if (status === "finished") return "finished";
    if (status === "paused") return "paused";
    if (status === "failed" || status === "excluded") return "stopped";
  }
  switch (row.lead_status) {
    case "in_progress":
      return "in_progress";
    case "not_started":
      return "pending";
    case "completed":
      return "finished";
    case "paused":
      return "paused";
    case "stopped":
    case "blocked":
    case "unsubscribed":
    case "bounced":
      return "stopped";
    default:
      return null;
  }
}

function statusOf(row: ProgressRow, replied: boolean, started: boolean): ProgressStatus {
  if (row.state === "skipped" || row.state === "failed") return "stopped";
  if (replied) return "replied";
  if (row.stopped_at) return "stopped";
  if (row.state !== "pushed") return "pending";
  const own = providerStatus(row) ?? (started ? "in_progress" : "pending");
  if (own !== "in_progress" && own !== "pending") return own;
  if (row.campaign_status === "paused") return "paused";
  if (row.campaign_status === "completed") return "finished";
  if (row.campaign_status === "stopped" || row.campaign_status === "archived") return "stopped";
  return own;
}

const CHANNEL_WORDS: Record<CampaignChannel, string> = { linkedin: "on LinkedIn", email: "by email" };

function stopLine(row: ProgressRow, replied: boolean, group: ProgressRow[]) {
  if (replied) return "Stopped when they replied";
  if (!row.stop_reason || !(row.stopped_at || row.stop_requested_at)) return null;
  if (row.stop_reason === "removed") return "Removed";
  if (row.stop_reason === "suppressed") return "Do not contact";
  const elsewhere = group.filter((other) => other.id !== row.id && other.replied_at).sort((a, b) => a.replied_at!.getTime() - b.replied_at!.getTime())[0];
  return elsewhere && elsewhere.channel !== row.channel ? `Stopped when they replied ${CHANNEL_WORDS[elsewhere.channel]}` : "Stopped when they replied";
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

export function countsLine(progress: Pick<CampaignProgress, "channel" | "counts">) {
  const counts = progress.counts;
  if (progress.channel === "email") return [plural(counts.opens ?? 0, "open", "opens"), plural(counts.clicks ?? 0, "click", "clicks")].join(", ");
  return [`${counts.accepted ? "Yes" : "No"} accepted`, plural(counts.messages ?? 0, "message", "messages"), `${counts.replied ? "Yes" : "No"} replied`].join(", ");
}

type Built = {
  label: string;
  kind: string;
  variant: string | null;
  done: boolean;
  at: Date | null;
  accepted: boolean;
  acceptedAt: Date | null;
  replied: boolean;
  repliedAt: Date | null;
  delayDays: number | null;
};

export function buildProgress(row: ProgressRow, events: ProgressEvent[], group: ProgressRow[] = [row], options: { now?: number; timeZone?: string } = {}): CampaignProgress {
  const now = options.now ?? Date.now();
  const timeZone = options.timeZone ?? appTimeZone();
  const day = (at: Date) => shortDay(at.toISOString(), timeZone, now);
  const state = row.provider_state ?? {};
  const linkedin = row.channel === "linkedin";
  const planned = plannedSteps(row.sequence);
  const ofKind = (kind: CampaignEventKind) => events.filter((event) => event.kind === kind);
  const providerReplied = linkedin && state.messaging === "replied";
  const replied = Boolean(row.replied_at) || providerReplied;
  const steps: Built[] = planned.map((plan) => ({
    label: linkedin ? plan.kind || `Step ${plan.step}` : `Email ${plan.step}`,
    kind: linkedin ? plan.kind : "Email",
    variant: null,
    done: false,
    at: null,
    accepted: false,
    acceptedAt: null,
    replied: false,
    repliedAt: null,
    delayDays: plan.delayDays,
  }));

  if (linkedin) {
    const slots = new Map<CampaignEventKind, Slot[]>();
    const used = new Map<CampaignEventKind, number>();
    const slotsOf = (kind: CampaignEventKind) => {
      if (!slots.has(kind)) slots.set(kind, eventSlots(ofKind(kind)));
      return slots.get(kind)!;
    };
    const accepts = eventSlots(ofKind("invite_accepted"));
    let invites = 0;
    let messages = 0;
    steps.forEach((built, index) => {
      const kind = STEP_EVENTS[built.kind];
      if (!kind) return;
      const position = used.get(kind) ?? 0;
      used.set(kind, position + 1);
      const slot = slotsOf(kind)[position];
      if (slot) {
        built.done = true;
        built.at = slot.at;
        if (slot.variant && planned[index].variants > 1) built.variant = slot.variant;
      }
      if (kind === "invite_sent") {
        const accept = accepts[invites];
        if (accept) {
          built.accepted = true;
          built.acceptedAt = accept.at;
          built.done = true;
        } else if (invites === 0 && state.connection === "accepted") built.accepted = true;
        if (invites === 0 && (state.connection === "sent" || state.connection === "accepted")) built.done = true;
        invites += 1;
      }
      if (kind === "message_sent") {
        if (messages === 0 && (state.messaging === "sent" || state.messaging === "replied")) built.done = true;
        messages += 1;
      }
    });
  } else {
    const sent = ofKind("sent");
    planned.forEach((plan, index) => {
      const event = sent.find((item) => item.step === plan.step);
      if (!event) return;
      steps[index].done = true;
      steps[index].at = event.occurred_at;
      if (event.variant && plan.variants > 1) steps[index].variant = event.variant;
    });
    if (row.lead_status === "completed" && !replied && !row.stopped_at) for (const built of steps) built.done = true;
  }

  const lastDone = steps.findLastIndex((built) => built.done);
  for (let index = 0; index < lastDone; index += 1) steps[index].done = true;

  if (replied && lastDone >= 0) {
    const repliedAt = row.replied_at;
    const target = repliedAt ? steps.findLastIndex((built) => built.done && (!built.at || built.at <= repliedAt)) : lastDone;
    const chosen = steps[target >= 0 ? target : lastDone];
    chosen.replied = true;
    chosen.repliedAt = repliedAt;
  }

  const status = statusOf(row, replied, lastDone >= 0);
  const halted = status === "replied" || status === "stopped";
  const highlighted = status === "in_progress" || status === "paused" || status === "replied" || status === "pending" ? lastDone : -1;
  const waitingInvite = steps.some((built) => built.done && built.kind === "Invite" && !built.accepted);
  let nextShown = false;

  const shown: ProgressStep[] = steps.map((built, index) => {
    const label = built.variant ? `${built.label} ${built.variant}` : built.label;
    const base = { step: planned[index].step, label, variant: built.variant };
    if (built.done) {
      const parts = [built.at ? day(built.at) : null, built.accepted ? (built.acceptedAt ? `accepted ${day(built.acceptedAt)}` : "accepted") : null, built.replied ? (built.repliedAt ? `replied ${day(built.repliedAt)}` : "replied") : null];
      return { ...base, state: index === highlighted ? "current" : "done", at: built.at?.toISOString() ?? null, due: null, text: parts.filter(Boolean).join(", ") };
    }
    if (halted) return { ...base, state: "stopped", at: null, due: null, text: "stopped" };
    if (nextShown || status === "finished") return { ...base, state: "later", at: null, due: null, text: "" };
    nextShown = true;
    if (status === "paused") return { ...base, state: "next", at: null, due: null, text: "paused" };
    if (linkedin && built.kind === "Message" && waitingInvite) return { ...base, state: "next", at: null, due: null, text: "after they accept" };
    const previous = index > 0 ? steps[index - 1] : null;
    const from = previous ? [previous.at, previous.acceptedAt].filter((at): at is Date => Boolean(at)).sort((a, b) => b.getTime() - a.getTime())[0] : null;
    if (!from) return { ...base, state: "next", at: null, due: null, text: "next" };
    const due = new Date(from.getTime() + (built.delayDays ?? 0) * DAY_MS);
    const today = shortDay(new Date(now).toISOString(), timeZone, now);
    const text = due.getTime() <= now && day(due) !== today ? "due now" : `around ${day(due)}`;
    return { ...base, state: "next", at: null, due: due.toISOString(), text };
  });

  const skipped = row.state === "skipped" || row.state === "failed";
  const current = lastDone >= 0 ? planned[lastDone].step : null;
  const sender = linkedin ? row.sender_name : (row.mailbox_owner ?? mailboxParts(row.mailbox)?.name ?? mailboxParts(row.mailbox)?.address ?? null);
  const stage = skipped
    ? [row.skip_reason?.trim() || "Not added"]
    : [current !== null ? `Step ${current} of ${planned.length}` : planned.length > 0 ? "Not started" : null, sender ? `Sent from ${sender}` : null, stopLine(row, replied, group)];

  const counts: ProgressCounts = linkedin
    ? {
        accepted: steps.some((built) => built.accepted) || ofKind("invite_accepted").length > 0 || state.connection === "accepted",
        messages: Math.max(
          eventSlots(ofKind("message_sent")).length + eventSlots(ofKind("inmail_sent")).length,
          steps.filter((built) => built.done && (built.kind === "Message" || built.kind === "InMail")).length,
        ),
        replied,
      }
    : { opens: ofKind("opened").length, clicks: ofKind("clicked").length };

  return {
    prospectId: row.id,
    campaignId: row.campaign_id,
    name: row.campaign_name,
    channel: row.channel,
    provider: row.provider,
    status,
    stage: stage.filter(Boolean).join(" · "),
    current,
    total: planned.length,
    sender,
    steps: skipped ? [] : shown,
    counts,
  };
}

export async function progressIn(db: Db, workspaceId: string, prospectIds: string[], options: { now?: number; timeZone?: string } = {}): Promise<CampaignProgress[]> {
  if (prospectIds.length === 0) return [];
  const rows = (await db.query<ProgressRow>(PROGRESS_SQL, [prospectIds, workspaceId])).rows;
  if (rows.length === 0) return [];
  const events = (await db.query<ProgressEvent>(EVENTS_SQL, [workspaceId, rows.map((row) => row.id), PROGRESS_KINDS])).rows;
  const byProspect = new Map<string, ProgressEvent[]>();
  for (const event of events) {
    const list = byProspect.get(event.prospect_id);
    if (list) list.push(event);
    else byProspect.set(event.prospect_id, [event]);
  }
  return rows.map((row) => buildProgress(row, byProspect.get(row.id) ?? [], rows, options));
}

export async function campaignProgress(actor: Actor, prospectIds: string[], options: { now?: number; timeZone?: string } = {}): Promise<CampaignProgress[]> {
  assertScope(actor.scopes, "crm:read");
  const ids = [...new Set(prospectIds.filter(isUuid))];
  if (ids.length === 0) return [];
  return withActor(actor, (db) => progressIn(db, actor.workspaceId, ids, options));
}

export function compactProgress(progress: CampaignProgress[]): CompactProgress[] {
  return progress.map((item) => ({
    prospectId: item.prospectId,
    campaign: item.name,
    channel: item.channel,
    status: PROGRESS_STATUS_LABELS[item.status],
    stage: item.stage,
    steps: item.steps.map((step) => {
      const word = step.state === "later" ? "" : step.state;
      const detail = [...new Set([word, step.text].filter(Boolean))].join(", ");
      return detail ? `${step.label}: ${detail}` : step.label;
    }),
    counts: countsLine(item),
  }));
}
