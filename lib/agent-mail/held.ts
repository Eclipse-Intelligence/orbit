import { senderAuthenticated, type AuthenticationResults } from "@/lib/agent-mail/senders";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { iso, isUuid } from "@/lib/crm/mutate";
import type { UserActor } from "@/lib/crm/types";
import { query } from "@/lib/db/pool";

export type HeldAgentMail = { id: string; subject: string | null; receivedAt: string; reason: string | null };

const FILTERED_LEVELS = new Set(["suspicious", "quarantined"]);
const FILTERED_EVENTS = new Set(["message.received.quarantined", "message.received.spam"]);

type HeldRow = {
  id: string;
  from_address: string | null;
  subject: string | null;
  received_at: Date | string;
  status_reason: string | null;
  authentication: AuthenticationResults | null;
  trust_level: string | null;
  event_type: string | null;
};

export function canRunAnyway(row: Pick<HeldRow, "from_address" | "authentication" | "trust_level" | "event_type">) {
  if (!row.from_address) return false;
  const filtered = FILTERED_LEVELS.has(row.trust_level ?? "") || FILTERED_EVENTS.has(row.event_type ?? "");
  return filtered && senderAuthenticated(row.from_address, row.authentication);
}

export async function heldAgentMail(actor: UserActor, limit = 5): Promise<HeldAgentMail[]> {
  const rows = await withActor(actor, async (db) => {
    const result = await db.query<HeldRow>(
      `select m.id, m.from_address, m.subject, m.received_at, m.status_reason, m.authentication, m.trust_level, m.event_type
       from crm.agent_mail_messages m
       where m.workspace_id = $1 and m.direction = 'inbound' and m.status = 'refused' and m.replied_at is null
         and m.received_at > now() - interval '7 days'
         and exists (
           select 1 from crm.agent_mailbox_senders s
           where s.workspace_id = m.workspace_id and s.address = lower(m.from_address) and s.user_id = $2
         )
       order by m.received_at desc
       limit 20`,
      [actor.workspaceId, actor.userId],
    );
    return result.rows;
  });
  return rows
    .filter(canRunAnyway)
    .slice(0, limit)
    .map((row) => ({ id: row.id, subject: row.subject, receivedAt: iso(row.received_at) ?? new Date().toISOString(), reason: row.status_reason }));
}

export async function runHeldAgentMail(actor: UserActor, id: string) {
  if (!isUuid(id) || !(await heldAgentMail(actor, 20)).some((item) => item.id === id)) {
    throw new CrmError("not_found", "That email can't be run from here.", 404);
  }
  const result = await query<{ id: string; workspace_id: string; user_id: string }>("select * from private.agent_mail_run_anyway($1, $2)", [id, actor.userId]);
  const row = result.rows[0];
  if (!row) throw new CrmError("conflict", "That email has already been handled.", 409);
  return { mailId: row.id, userId: row.user_id, workspaceId: row.workspace_id };
}
