import { requireAgentMailAccess, type AgentMailboxRow } from "@/lib/agent-mail/mailbox";
import { emailHtml, emailText } from "@/lib/agent-mail/email-format";
import { bareAddress } from "@/lib/agent-mail/senders";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { iso, isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";
import { MachineMailError, replyToMessage, sendNewMessage, type SentMail } from "@/lib/machinemail";

export const AGENT_MAILBOX = "agent";

type MessageRow = {
  id: string;
  message_id: string;
  thread_id: string | null;
  direction: "inbound" | "outbound";
  from_address: string | null;
  from_name: string | null;
  to_addresses: string[];
  cc_addresses: string[];
  subject: string | null;
  received_at: Date | string;
  text: string | null;
  status: string;
  status_reason: string | null;
  attachments: { filename?: string; content_type?: string; size?: number }[] | null;
  conversation_id: string | null;
};

const COLUMNS =
  "id, message_id, thread_id, direction, from_address, from_name, to_addresses, cc_addresses, subject, received_at, text, status, status_reason, attachments, conversation_id";

const ACTED: Record<string, string> = {
  received: "Received, not started yet",
  working: "Orbit is working on it",
  replied: "Orbit replied",
  superseded: "A later email in the thread took over",
  failed: "Orbit couldn't finish it",
  ignored: "Not acted on: the sender can't give it work",
  refused: "Not acted on",
  sent: "Sent from the agent mailbox",
};

function attachmentNames(row: MessageRow) {
  return (row.attachments ?? []).map((item) => item.filename || "file").slice(0, 20);
}

function listed(row: MessageRow) {
  return {
    id: row.id,
    mailbox: AGENT_MAILBOX,
    direction: row.direction,
    from: row.from_name ? `${row.from_name} <${row.from_address ?? ""}>` : row.from_address,
    to: row.to_addresses,
    subject: row.subject || "(no subject)",
    receivedAt: iso(row.received_at),
    snippet: (row.text ?? "").replace(/\s+/g, " ").trim().slice(0, 240),
    attachments: attachmentNames(row),
    status: row.status === "refused" && row.status_reason ? `Not acted on: ${row.status_reason}` : ACTED[row.status] ?? row.status,
  };
}

export async function searchAgentMail(actor: UserActor, input: { query?: string; from?: string; limit?: number }) {
  const mailbox = await requireAgentMailAccess(actor);
  const words = input.query?.trim() || null;
  const from = input.from?.trim().toLowerCase() || null;
  const limit = Math.max(1, Math.min(50, input.limit ?? 20));
  const rows = await withActor(actor, async (db) => {
    const result = await db.query<MessageRow>(
      `select ${COLUMNS} from crm.agent_mail_messages
       where workspace_id = $1 and mailbox_id = $2
         and ($3::text is null or search @@ websearch_to_tsquery('english', $3))
         and ($4::text is null or position($4 in lower(coalesce(from_address, '') || ' ' || coalesce(from_name, ''))) > 0)
       order by ${words ? "ts_rank(search, websearch_to_tsquery('english', $3)) desc," : ""} received_at desc
       limit $5`,
      [actor.workspaceId, mailbox.id, words, from, limit],
    );
    return result.rows;
  });
  return { mailbox: mailbox.address, emails: rows.map(listed) };
}

async function ownMessage(actor: UserActor, id: string) {
  if (!isUuid(id)) return null;
  return withActor(actor, async (db) => {
    const result = await db.query<MessageRow & { mailbox_id: string }>(`select ${COLUMNS}, mailbox_id from crm.agent_mail_messages where id = $1 and workspace_id = $2`, [
      id,
      actor.workspaceId,
    ]);
    return result.rows[0] ?? null;
  });
}

export async function isAgentMail(actor: UserActor, id: string) {
  return Boolean(await ownMessage(actor, id).catch(() => null));
}

export async function agentMailThread(actor: UserActor, id: string) {
  const mailbox = await requireAgentMailAccess(actor);
  const row = await ownMessage(actor, id);
  if (!row) throw new CrmError("not_found", "That email isn't in the agent mailbox.", 404);
  const rows = row.thread_id
    ? await withActor(actor, async (db) => {
        const result = await db.query<MessageRow>(
          `select ${COLUMNS} from crm.agent_mail_messages where workspace_id = $1 and mailbox_id = $2 and thread_id = $3 order by received_at, created_at limit 100`,
          [actor.workspaceId, row.mailbox_id, row.thread_id],
        );
        return result.rows;
      })
    : [row];
  return {
    mailbox: mailbox.address,
    messages: rows.map((message) => ({ ...listed(message), snippet: undefined, cc: message.cc_addresses, text: message.text ?? "" })),
  };
}

export async function recordOutbound(
  actor: UserActor,
  mailbox: Pick<AgentMailboxRow, "id" | "address">,
  sent: SentMail,
  mail: { to: string[]; cc?: string[]; subject: string | null; text: string },
) {
  await query("select private.agent_mail_record_sent($1, $2, $3, $4, $5::text[], $6::text[], $7, $8, $9::timestamptz)", [
    mailbox.id,
    actor.userId,
    sent.message_id.slice(0, 200),
    sent.thread_id?.slice(0, 200) ?? null,
    mail.to,
    mail.cc ?? [],
    mail.subject?.slice(0, 2000) ?? null,
    mail.text.slice(0, 1_000_000),
    sent.timestamp ?? null,
  ]);
}

export const AGENT_SENDS_PER_DAY = 50;

async function allowSend(actor: UserActor) {
  const result = await query<{ allowed: boolean }>("select private.consume_rate_limit($1, $2, $3) as allowed", [`agent-mail-send:${actor.userId}`, AGENT_SENDS_PER_DAY, 86_400]);
  if (!result.rows[0]?.allowed) {
    throw new CrmError("rate_limited", `You've sent ${AGENT_SENDS_PER_DAY} emails from the agent mailbox in the last day, the most Orbit allows. Try again tomorrow.`, 429);
  }
}

function addresses(values: string[]) {
  const out: string[] = [];
  for (const value of values) {
    const address = bareAddress(value);
    if (!address) throw new CrmError("invalid_input", `${value.slice(0, 80)} isn't an email address.`, 400, { field: "to" });
    if (!out.includes(address)) out.push(address);
  }
  return out;
}

export async function sendFromAgentMailbox(
  actor: UserActor,
  input: { replyTo: string | null; to: string[]; cc: string[]; subject: string | null; body: string },
  fetchImpl: typeof fetch = fetch,
) {
  const mailbox = await requireAgentMailAccess(actor);
  const extra = addresses(input.to);
  await allowSend(actor);
  const cc = addresses(input.cc);
  let sent: SentMail;
  let to: string[];
  let subject: string | null;
  try {
    if (input.replyTo) {
      const original = await ownMessage(actor, input.replyTo);
      if (!original) throw new CrmError("not_found", "That email isn't in the agent mailbox. Use an id from search_email with mailbox agent.", 404, { field: "replyToEmailId" });
      const base = original.direction === "inbound" ? [original.from_address ?? ""].filter(Boolean) : original.to_addresses;
      to = [...new Set([...base, ...extra])].filter((address) => address !== mailbox.address);
      if (to.length === 0) throw new CrmError("invalid_input", "Say who the reply is to.", 400, { field: "to" });
      subject = original.subject && /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject ?? ""}`.trim();
      sent = await replyToMessage(mailbox.address, original.message_id, { to, cc, text: emailText(input.body), html: emailHtml(input.body) }, fetchImpl);
    } else {
      to = extra;
      if (to.length === 0) throw new CrmError("invalid_input", "Say who the email is to.", 400, { field: "to" });
      subject = input.subject?.trim() || null;
      if (!subject) throw new CrmError("invalid_input", "A new email needs a subject.", 400, { field: "subject" });
      sent = await sendNewMessage(mailbox.address, { to, cc, subject, text: emailText(input.body), html: emailHtml(input.body) }, fetchImpl);
    }
  } catch (error) {
    if (error instanceof MachineMailError) throw new CrmError("upstream_error", `MachineMail didn't send it: ${error.message}`, 502);
    throw error;
  }
  await recordOutbound(actor, mailbox, sent, { to, cc, subject, text: emailText(input.body) }).catch((error) => console.error("Saving the agent mailbox copy failed", error instanceof Error ? error.message : "unknown"));
  return { sent: true, from: mailbox.address, to, cc, subject };
}
