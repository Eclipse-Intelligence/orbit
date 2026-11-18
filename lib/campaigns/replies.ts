import { createHash } from "node:crypto";
import { auditJson } from "@/lib/campaigns/audit";
import { connectedContext, mightHaveSent, providerError, type ProviderOptions } from "@/lib/campaigns/context";
import { CAMPAIGN_AUDIT_EVENTS, leadRef, readProspectRef, type ProspectRef } from "@/lib/campaigns/manage";
import { FILABLE_SQL, fileMessageActivity, saveThread, threadFetched, type FilableMessage } from "@/lib/campaigns/messages";
import type { CampaignProvider, ProviderContext, ReplyTarget } from "@/lib/campaigns/providers";
import { scheduleWebhooks, withActor } from "@/lib/crm/context";
import { CrmError, isPgError, pgFailure } from "@/lib/crm/errors";
import { assertScope } from "@/lib/crm/scopes";
import type { Actor, Provenance, UserActor } from "@/lib/crm/types";
import { query, type Db } from "@/lib/db/pool";
import { redactedError } from "@/lib/upstream";
import { ServiceBusy } from "@/lib/workflows/limits";

const EMAIL_MAX = 20_000;
const LINKEDIN_MAX = 8_000;
const CLIENT_KEY = /^[A-Za-z0-9_:.-]{1,200}$/;

export type SendState = "sending" | "sent" | "unknown" | "failed";

export type ReplyResult = { messageId: string; sendState: SendState; repeated: boolean; note?: string };

export function repeatedNote(at: Date, state: SendState = "sent", now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - at.getTime()) / 60_000));
  const when = minutes === 0 ? "just now" : minutes === 1 ? "1 minute ago" : `${minutes.toLocaleString("en-GB")} minutes ago`;
  if (state === "unknown") return `Already tried ${when} and it may not have gone. Not sent again; check the thread.`;
  if (state === "sending") return `Started sending ${when}, not sent again.`;
  return `Already sent ${when}, not sent again.`;
}

type StoredTarget = {
  conversation_id: string | null;
  sender_id: string | null;
  stats_id: string | null;
  provider_message_id: string | null;
  body: string;
  sent_at: Date;
  direction: "inbound" | "outbound";
};

type SenderRow = { user_id: string | null; name: string | null; member: boolean };

export function onlySenderMessage(name: string) {
  return `Only ${name} can reply from this LinkedIn account.`;
}

export const KEY_REUSED = "This client key was already used for a different reply.";
export const KEY_ELSEWHERE = "This client key was already used for a reply to someone else.";
const SAME_REPLY_MS = 10 * 60_000;

function derivedKey(actor: UserActor, prospectId: string, text: string) {
  const bucket = Math.floor(Date.now() / SAME_REPLY_MS);
  return `auto-${createHash("sha256").update(`${actor.userId}|${prospectId}|${text}`).digest("hex").slice(0, 40)}-${bucket}`;
}

async function recentSameReply(actor: UserActor, prospectId: string, text: string) {
  return withActor(actor, async (db) => {
    const found = await db.query<{ id: string; send_state: SendState; created_at: Date }>(
      `select id, send_state, created_at from crm.campaign_messages
       where workspace_id = $1 and prospect_id = $2 and direction = 'outbound' and sent_by_user_id = $3 and body = $4
         and send_state is not null and send_state <> 'failed' and created_at > now() - make_interval(secs => $5)
       order by created_at desc limit 1`,
      [actor.workspaceId, prospectId, actor.userId, text, SAME_REPLY_MS / 1000],
    );
    return found.rows[0] ?? null;
  });
}

export const UNLINKED_SENDER = "Link this LinkedIn account to someone in Settings › Tools › HeyReach first.";

function assertPerson(actor: Actor): asserts actor is UserActor {
  if (actor.type !== "user") throw new CrmError("forbidden", "Only a person can reply.", 403);
}

function cleanText(raw: string, channel: ProspectRef["channel"]) {
  const text = (raw ?? "").replace(/\r\n?/g, "\n").trim();
  if (!text) throw new CrmError("invalid_input", "Write a reply.", 400, { field: "text" });
  const max = channel === "linkedin" ? LINKEDIN_MAX : EMAIL_MAX;
  if (text.length > max) throw new CrmError("invalid_input", `Keep the reply under ${max.toLocaleString("en-GB")} characters.`, 400, { field: "text" });
  return text;
}

async function storedTargets(db: Db, prospectId: string) {
  const result = await db.query<StoredTarget>(
    `select conversation_id, sender_id, stats_id, provider_message_id, body, sent_at, direction
     from crm.campaign_messages
     where prospect_id = $1 and (send_state is null or confirmed_at is not null)
     order by sent_at desc, created_at desc
     limit 200`,
    [prospectId],
  );
  return result.rows;
}

async function senderFor(db: Db, workspaceId: string, externalId: string) {
  const result = await db.query<SenderRow>(
    `select s.user_id, coalesce(nullif(btrim(pr.full_name), ''), pr.email) as name,
            exists (select 1 from crm.workspace_members m where m.workspace_id = s.workspace_id and m.user_id = s.user_id) as member
     from crm.campaign_senders s
     left join crm.profiles pr on pr.id = s.user_id
     where s.workspace_id = $1 and s.provider = 'heyreach' and s.external_id = $2`,
    [workspaceId, externalId],
  );
  return result.rows[0] ?? null;
}

export type ReplyPermission = { canReply: boolean; reason: string | null; senderName: string | null };

export async function linkedinReplyPermission(db: Db, actor: Actor, messages: StoredTarget[]): Promise<ReplyPermission & { conversationId: string | null; senderId: string | null }> {
  const fromThem = messages.find((message) => message.direction === "inbound" && message.conversation_id && message.sender_id);
  const any = fromThem ?? messages.find((message) => message.conversation_id && message.sender_id);
  if (!any) return { canReply: false, reason: "There's no LinkedIn conversation with this person yet.", senderName: null, conversationId: null, senderId: null };
  const sender = await senderFor(db, actor.workspaceId, any.sender_id!);
  const base = { conversationId: any.conversation_id, senderId: any.sender_id };
  if (!sender?.user_id || !sender.member) return { ...base, canReply: false, reason: UNLINKED_SENDER, senderName: null };
  if (actor.type !== "user" || sender.user_id !== actor.userId) {
    return { ...base, canReply: false, reason: onlySenderMessage(sender.name || "the linked member"), senderName: sender.name };
  }
  const member = await db.query("select 1 from crm.workspace_members where workspace_id = $1 and user_id = $2", [actor.workspaceId, actor.userId]);
  if (member.rowCount === 0) return { ...base, canReply: false, reason: "Only people in this workspace can reply.", senderName: sender.name };
  return { ...base, canReply: true, reason: null, senderName: sender.name };
}

async function readTarget(actor: UserActor, prospectId: string) {
  return withActor(actor, async (db) => {
    const prospect = await readProspectRef(db, actor, prospectId);
    const messages = await storedTargets(db, prospect.id);
    if (prospect.channel === "linkedin") {
      const permission = await linkedinReplyPermission(db, actor, messages);
      return { prospect, messages, permission };
    }
    return { prospect, messages, permission: null };
  });
}

function emailTarget(prospect: ProspectRef, messages: StoredTarget[]): ReplyTarget | null {
  const withStats = messages.find((message) => message.direction === "inbound" && message.stats_id) ?? messages.find((message) => message.stats_id);
  if (!withStats) return null;
  const replyTo = messages.find((message) => message.direction === "inbound") ?? withStats;
  return {
    lead: leadRef(prospect),
    conversationId: null,
    senderId: null,
    statsId: withStats.stats_id,
    replyTo: { messageId: replyTo.provider_message_id, sentAt: replyTo.sent_at.toISOString(), body: replyTo.body },
  };
}

async function refresh(provider: CampaignProvider, context: ProviderContext, prospect: ProspectRef) {
  const messages = await provider.readThread(context, { externalId: prospect.campaign_external_id }, leadRef(prospect));
  await saveThread(prospect.id, messages, { replyEvents: provider.repliesFromThreads, handled: false });
  await threadFetched(prospect.id);
}

async function fileSent(actor: UserActor, messageId: string, provenance: Provenance) {
  try {
    await withActor(actor, async (db) => {
      const found = await db.query<FilableMessage>(`${FILABLE_SQL} where m.id = $1 and m.workspace_id = $2`, [messageId, actor.workspaceId]);
      if (found.rows[0]) await fileMessageActivity(db, actor, found.rows[0], provenance);
    });
  } catch (error) {
    console.error("Couldn't file a campaign reply on the timeline", redactedError(error));
  }
}

export async function replyToProspect(
  actor: Actor,
  prospectId: string,
  input: { text: string; clientKey?: string | null },
  options: ProviderOptions & { provenance?: Provenance } = {},
): Promise<ReplyResult> {
  assertPerson(actor);
  assertScope(actor.scopes, "campaigns:write");
  const given = input.clientKey?.trim() || null;
  if (given && !CLIENT_KEY.test(given)) throw new CrmError("invalid_input", "Try sending again.", 400, { field: "clientKey" });
  const provenance = options.provenance ?? { operation: "reply_to_prospect", source: "web" };
  let read = await readTarget(actor, prospectId);
  const text = cleanText(input.text, read.prospect.channel);
  if (!given) {
    const recent = await recentSameReply(actor, read.prospect.id, text);
    if (recent) return { messageId: recent.id, sendState: recent.send_state, repeated: true, note: repeatedNote(recent.created_at, recent.send_state) };
  }
  const clientKey = given ?? derivedKey(actor, read.prospect.id, text);
  if (read.permission && !read.permission.canReply) throw new CrmError("forbidden", read.permission.reason ?? "You can't reply from this account.", 403);
  if (read.prospect.state !== "pushed") throw new CrmError("conflict", "This person hasn't been added to the campaign yet.", 409);
  const { provider, context } = await connectedContext(actor.workspaceId, read.prospect.provider, options);

  let target: ReplyTarget | null =
    read.prospect.channel === "linkedin"
      ? { lead: leadRef(read.prospect), conversationId: read.permission!.conversationId, senderId: read.permission!.senderId, statsId: null, replyTo: null }
      : emailTarget(read.prospect, read.messages);
  if (!target) {
    try {
      await refresh(provider, context, read.prospect);
    } catch (error) {
      throw providerError(provider, error, "Couldn't read the conversation. Try again.");
    }
    read = await readTarget(actor, prospectId);
    target = emailTarget(read.prospect, read.messages);
    if (!target) throw new CrmError("conflict", `${provider.name} hasn't sent this person anything yet.`, 409);
  }

  let begun;
  try {
    begun = await query<{ message_id: string; send_state: SendState; created: boolean }>("select * from private.campaign_reply_begin($1, $2, $3, $4, $5, $6::jsonb)", [
      actor.workspaceId,
      read.prospect.id,
      actor.userId,
      text,
      clientKey,
      JSON.stringify({ conversationId: target.conversationId, senderId: target.senderId, statsId: target.statsId }),
    ]);
  } catch (error) {
    if (isPgError(error) && error.code === "22023") throw new CrmError("conflict", KEY_ELSEWHERE, 409, { field: "clientKey" });
    throw pgFailure(error) ?? error;
  }
  const row = begun.rows[0];
  if (!row) throw new CrmError("internal_error", "Couldn't send. Try again.", 500);
  if (!row.created) {
    const stored = await withActor(actor, (db) => db.query<{ body: string; created_at: Date }>("select body, created_at from crm.campaign_messages where id = $1 and workspace_id = $2", [row.message_id, actor.workspaceId]));
    if ((stored.rows[0]?.body ?? null) !== text) throw new CrmError("conflict", KEY_REUSED, 409, { field: "clientKey" });
    return { messageId: row.message_id, sendState: row.send_state, repeated: true, note: repeatedNote(stored.rows[0]!.created_at, row.send_state) };
  }
  try {
    return await sendBegun(actor, provider, context, read.prospect, target, text, row.message_id, provenance);
  } catch (error) {
    if (error instanceof CrmError && typeof error.details?.messageId === "string") throw error;
    if (!(error instanceof CrmError)) console.error("A campaign reply failed after it was stored", redactedError(error));
    const base = error instanceof CrmError ? error : new CrmError("internal_error", "Couldn't send. Try again.", 500);
    throw new CrmError(base.code, base.message, base.status, { ...(base.details ?? {}), messageId: row.message_id });
  }
}

async function sendBegun(
  actor: UserActor,
  provider: CampaignProvider,
  context: ProviderContext,
  prospect: ProspectRef,
  target: ReplyTarget,
  text: string,
  messageId: string,
  provenance: Provenance,
): Promise<ReplyResult> {
  let state: Exclude<SendState, "sending">;
  let providerMessageId: string | null = null;
  let failure: CrmError | null = null;
  try {
    providerMessageId = (await provider.sendReply(context, prospect.campaign_external_id, target, text)).providerMessageId;
    state = "sent";
  } catch (error) {
    if (mightHaveSent(provider, error)) {
      state = "unknown";
      console.error(`A ${provider.name} reply may not have gone`, redactedError(error));
    } else {
      state = "failed";
      failure = error instanceof ServiceBusy ? providerError(provider, error, "") : providerError(provider, error, "Couldn't send. Try again.");
    }
  }
  const audit = auditJson(actor, CAMPAIGN_AUDIT_EVENTS.replySent, "campaign_prospect", prospect.id, provenance, {
    campaignId: prospect.campaign_id,
    campaign: prospect.campaign_name,
    contactId: prospect.contact_id,
    channel: prospect.channel,
  });
  const finished = await query<{ audited: boolean }>("select private.campaign_reply_finish($1, $2, $3, $4, $5, $6::jsonb) as audited", [
    actor.workspaceId,
    messageId,
    state,
    providerMessageId,
    failure?.message ?? (state === "unknown" ? "May not have gone." : null),
    audit,
  ]);
  if (failure) throw new CrmError(failure.code, failure.message, failure.status, { ...(failure.details ?? {}), messageId });
  if (finished.rows[0]?.audited) scheduleWebhooks();

  await fileSent(actor, messageId, provenance);
  return { messageId, sendState: state, repeated: false };
}
