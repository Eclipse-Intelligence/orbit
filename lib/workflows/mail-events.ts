import { withActor } from "@/lib/crm/context";
import type { UserActor } from "@/lib/crm/types";
import { workspaceActors } from "@/lib/crm/workspaces";
import { addressHomesInDb, captureWorkspaces } from "@/lib/mail/routing";
import { filedWorkspaces } from "@/lib/mail/timeline";
import type { EmailKind } from "@/lib/workflows/definition";

const BOUNCE_SENDER = /^(mailer-daemon|mail-daemon|postmaster|microsoftexchange[0-9a-f]*|bounces?|mdaemon)@/i;
const BOUNCE_SUBJECT =
  /^\s*(undeliverable|undelivered mail|delivery status notification \(failure\)|delivery has failed|delivery failure|mail delivery failed|message not delivered|returned mail|failure notice|address not found)/i;
const AUTO_SUBJECT = /^\s*(automatic reply|auto(matic)?[- ]?reply|autoreply|auto-response|out of (the )?office|ooo\b|away from (the )?office|i am away|i'm away|on leave)/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

type Arrival = {
  id: string;
  from_email: string | null;
  subject: string | null;
  body_text: string | null;
  replying: boolean;
};

export function classifyEmail(input: { from: string | null; subject: string | null }): EmailKind {
  const from = input.from ?? "";
  const subject = input.subject ?? "";
  if (BOUNCE_SENDER.test(from) || BOUNCE_SUBJECT.test(subject)) return "bounce";
  if (AUTO_SUBJECT.test(subject)) return "auto_reply";
  return "any";
}

export function failedRecipient(body: string | null, exclude: string[]) {
  const skip = new Set(exclude.map((item) => item.toLowerCase()));
  for (const match of (body ?? "").matchAll(EMAIL)) {
    const address = match[0].toLowerCase().replace(/\.$/, "");
    if (skip.has(address) || BOUNCE_SENDER.test(address) || /^(no-?reply|noreply)@/.test(address)) continue;
    return address;
  }
  return null;
}

export async function queueMailWorkflowEvents(actor: UserActor, messageIds: string[]) {
  if (messageIds.length === 0) return 0;
  const actors = await workspaceActors(actor);
  const workspaceIds = actors.map((item) => item.workspaceId);
  const filed = (await filedWorkspaces(actor, actors, { messageIds })).filter((row) => row.direction === "inbound");
  const unfiled = messageIds.filter((id) => !filed.some((row) => row.message_id === id));
  const homes = await withActor(actor, async (db) => captureWorkspaces(db, actor, await addressHomesInDb(db, actor), workspaceIds, unfiled));
  const byWorkspace = new Map<string, Set<string>>();
  const add = (workspaceId: string, id: string) => byWorkspace.set(workspaceId, (byWorkspace.get(workspaceId) ?? new Set<string>()).add(id));
  for (const row of filed) add(row.workspace_id, row.message_id);
  for (const id of unfiled) add(homes.get(id) ?? actor.workspaceId, id);
  let queued = 0;
  for (const target of actors) {
    const ids = byWorkspace.get(target.workspaceId);
    if (ids?.size) queued += await queueIn(target, [...ids]);
  }
  return queued;
}

async function queueIn(actor: UserActor, messageIds: string[]) {
  return withActor(actor, async (db) => {
    const wanted = await db.query<{ wanted: boolean }>(
      `select exists (
         select 1 from crm.workflows
         where owner_id = $1 and workspace_id = $2 and status = 'active' and archived_at is null and trigger_type = 'email_received'
       ) as wanted`,
      [actor.userId, actor.workspaceId],
    );
    if (!wanted.rows[0]?.wanted) return 0;
    const own = await db.query<{ email: string }>(
      `select lower(email) as email from crm.mail_sources where user_id = $1
       union select lower(email) from crm.send_identities where user_id = $1
       union select lower($2::text)`,
      [actor.userId, actor.email],
    );
    const ownAddresses = own.rows.map((row) => row.email).filter(Boolean);
    const result = await db.query<Arrival>(
      `select m.id, m.from_email, m.subject, left(m.body_text, 20000) as body_text,
         exists (
           select 1 from crm.mail_messages earlier join crm.mail_folders ef on ef.id = earlier.folder_id
           where earlier.source_id = m.source_id and ef.role = 'sent'
             and earlier.thread_key = m.thread_key
             and coalesce(earlier.sent_at, earlier.created_at) < coalesce(m.received_at, m.created_at)
         ) as replying
       from crm.mail_messages m
       where m.user_id = $1 and m.id = any($2::uuid[]) and not m.is_draft
         and lower(coalesce(m.from_email, '')) <> all ($3::text[])`,
      [actor.userId, messageIds, ownAddresses],
    );
    let queued = 0;
    for (const message of result.rows) {
      const kind = classifyEmail({ from: message.from_email, subject: message.subject });
      const data = {
        messageId: message.id,
        kind,
        reply: kind === "any" && message.replying,
        failedRecipient: kind === "bounce" ? failedRecipient(message.body_text, [...ownAddresses, message.from_email ?? ""]) : null,
      };
      await db.query(
        `insert into crm.workflow_events (workspace_id, trigger_types, event_type, entity_type, entity_id, data, actor_user_id, owner_user_id)
         values ($1, array['email_received'], 'email.received', 'email', $2, $3::jsonb, $4, $4)`,
        [actor.workspaceId, message.id, JSON.stringify(data), actor.userId],
      );
      queued += 1;
    }
    return queued;
  });
}
